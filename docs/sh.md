# Spherical harmonics

Spherical harmonics (SH) make a splat's color depend on the direction it is seen from. Radix stores bands 1 to 4 (3 + 5 + 7 + 9 RGB coefficients, 3DGS basis) in a bundle beside the splats. Band 0 is the splat's base color and stays in the splat layout. Files load their SH by default, every writer saves it, and generators made from arrays draw it for each view.

Code: `src/core/sh.ts` (`Sh`, `ShPalette`, the codecs) and `src/gpu/sh.tsl.ts` (`GpuSh`, `GpuShReader`, `GpuShPalette`).

```ts
// SH loads into an extSh bundle by default ("packed": smaller; false: skipped)
const data = await loadSplats("scene.ply");
const arrays = GpuArrays.fromData(renderer, data);

// The object draws its SH for each camera; nothing else is needed
const collection = new SplatCollection([SplatCollection.arrays(arrays)]);

// Draw up to band 1 only (0: base colors). Nothing recompiles
splatRenderer.objectParams.maxShDegree = 1;

// What SH a table holds
const found = Sh.find(data.bundles); // { name: "extSh", codec: "ext", degree: 3 }
```

## Codecs

There are two codecs, named by strings (`ShCodecName`). A name means the same codec on every thread, so a worker loads `"packed"` exactly as the page would. A codec turns an entry's coefficients into `uint32` words and back. Coefficients are coefficient-major RGB: value `3k + c` is channel c of coefficient k. Bands are stored in order, so a lower degree reads a prefix of a higher-degree entry. The words are grouped into `uint32x4` texels.

| Codec | Per entry, degree 1 / 2 / 3 / 4 | Texels | How a value is stored | Measured error (RMS, 8-bit steps) |
|---|---|---|---|---|
| `ext` (default) | 12 / 32 / 60 / 96 B | 1 / 2 / 4 / 6 | one word per coefficient: three 8-bit magnitudes, three signs, and a shared 5-bit exponent (`Encoding.encodeExtRgb`) | 0.035 to 0.13 |
| `packed` | 10 / 26 / 48 / 76 B | 1 / 2 / 3 / 5 | per band, a scale byte (0: all zero; otherwise the band's largest value is 2^((code - 192) / 16), rounded up), then one signed byte per value (`code / 127 * max`) | 0.08 to 0.31 |

The error is the RMS color error over all view directions, `sqrt(sum of squared coefficient errors / 4 pi)` (the basis is orthonormal). It was measured on the float SH3 scans Grace interior and Sutro; Sutro has outliers up to ±4.9. Neither codec uses per-file ranges, so outliers never clip. Ranges do worse on the same data: one signed byte over ±1 (RAD's `s8`) clips Sutro's outliers by up to 382 steps, and one signed byte over each band's largest value errs by 2.7 steps RMS.

Because neither codec has per-file values, all files of a codec share one program. Other formats' SH encodings are converted on load: SOG's codebook palettes into ext palettes (within one ext step of the codebook values).

## Storage

### Per splat

The SH bundle sits beside the splat bundle and has the same rows, so index lists and remaps apply to it too. It is named after its codec (`extSh`, `packedSh`). Its `uint32x4` channels are named after the codec plus a letter per texel:

| Codec | Degree 1 | Degree 2 | Degree 3 | Degree 4 |
|---|---|---|---|---|
| ext | `extShA` | `extShA`, `extShB` | `extShA` to `extShD` (words 0-3, 4-7, 8-11, 12-14) | `extShA` to `extShF` (words 0-23) |
| packed | `packedShA` | `packedShA`, `packedShB` | `packedShA` to `packedShC` (bytes 0-15, 16-31, 32-47) | `packedShA` to `packedShE` (bytes 0-75; band 4 starts at byte 48, texel D) |

`Sh.find` finds the codec and degree from channel names and formats alone, as `Splats.find` does for splat layouts. The degree is also in `meta.degree`. A letter is a position in the entry, not a band: texels do not line up with bands (ext's texel B holds band 2 and the start of band 3).

### Palettes

With a palette, splats pick shared SH entries by label. The labels are bundle `shLabel` (`uint16`, so at most 65,536 entries) in the splat table. The entries are a separate table (`ShPalette`), because their count differs from the splat count. Entry n takes `stride` texels in channel `shEntries`, elements `n * stride` to `n * stride + stride - 1`, so its coefficients sit together in one texture row. By default the stride is the codec's texel count rounded up to a power of two (1 / 2 / 4 / 8 for degree 1 / 2 / 3 / 4), so entries are 16 / 32 / 64 / 128 bytes and never cross a row. The palette's meta holds `{ codec, degree, size, stride }`, so it is a plain `ArrayData`. RDX files do not store palettes yet; writers expand them (see below).

At SH3 a palette costs 2 bytes per splat plus its table (4 MB at 65,536 entries), against 48 to 64 bytes per splat for per-splat SH. At SH4 the default stride of 8 doubles the table; a stride of 6 (ext) or 5 (packed) fits exactly.

| `ShPalette` member | What it does |
|---|---|
| `ShPalette.create({ codec, degree, size, stride? })` | an empty palette |
| `ShPalette.strideOf(codec, degree)` | the default stride |
| `new ShPalette(data)` | a palette over a table with bundle `shPalette` |
| `set(n, coeffs)`, `get(n, out?)` | encode or decode entry n |
| `convert(codec, { stride? })` | the same entries in another codec |
| `expand(data, labels, codec?)` | adds per-splat SH to `data` for `labels` (default: the palette's codec) |
| `expanded(data, codec?)` | `data` with per-splat SH instead of its `shLabel` bundle (other bundles shared) |
| `data`, `codec`, `degree`, `size`, `stride` | the table and its meta |

On the GPU, `GpuShPalette.upload(renderer, palette)` uploads a palette. `GpuShPalette.create(renderer, { codec, degree, size, stride?, storage? })` makes an empty one for a `GpuArrayWriter` to fill (element t is entry `t / stride`, texel `t % stride`). Pass it to `SplatCollection.arrays(arrays, { shPalette })` or set it as `StoredSplats.shPalette`.

## Loading and writing

`loadSplatFile`, `SplatFiles.decode` / `fetch`, and the format readers (`PlyFile.read`, `SpzFile.read`, `RadFile.read`) return `{ splats, shPalette? }`. Only RAD's clustered SH makes a palette. `loadSplats` returns just the table, with any palette expanded to per-splat SH (`ShPalette.expanded`). All take `sh`, an `ShTarget`:

| `sh` | What happens |
|---|---|
| left out | PLY, compressed PLY, SPZ, and RAD load into `extSh`; RDX keeps its stored SH bundle |
| `"ext"`, `"packed"` | that codec (RDX converts to it) |
| `false` | SH is skipped; `meta.ignoredShDegree` records its degree |

RAD files with clustered SH (from Spark's `build-lod --cluster-sh`) store `shCodeCount` entries in chunk 0's `sh1_code` to `sh3_code`, and an `sh_label` per splat in every chunk. `loadSplatFile` loads them as a palette in the `sh` codec: `shLabel` in `splats`, the entries in `shPalette`. With more than 65,536 entries the labels no longer fit `shLabel`, so they load as per-splat SH. Files without SH get no SH bundle.

```ts
const { splats, shPalette } = await loadSplatFile("clustered.rad");
const arrays = GpuArrays.fromData(renderer, splats);
const palette = shPalette && GpuShPalette.upload(renderer, shPalette);
const object = SplatCollection.arrays(arrays, { shPalette: palette });
```

Writers write the SH bundle when there is one (`sh: true`, the default); each format's limits are in [files.md](files.md#what-each-format-keeps). PLY, SPZ, and RDX keep degree 4. Compressed PLY and RAD stop at degree 3 and write the first 3 bands of degree-4 SH. Given `shPalette`, `RadFile.write` writes clustered SH (codes as `radSh`, labels as `u16`) and the other writers expand it to per-splat SH. `writeSplats` on a worker moves the palette's arrays there and back, like the table's.

## Drawing

`SplatGenerator.forArrays(arrays, { remap?, modifiers?, sh?, shPalette? })` finds the splat layout and the SH storage (per splat, or `shLabel` with `shPalette`) and returns a generator, shared by all arrays of the same kind. `SplatCollection.arrays` uses it, so loaded files draw their SH without extra code. `sh` caps the degree (0 or `false`: no SH).

`SplatGenerator.fromSplats({ layout, remap, modifiers, sh: { codec, degree, palette? } })` is the explicit form, for use before any data exists. In both forms the SH color is added after the splat is read and before the modifiers run: `rgb = max(rgb + SH(normalize(center - context.viewOrigin)), 0)`. `viewOrigin` is the camera position in the object's space (in XR, the midpoint between the eyes; see [generators.md](generators.md#the-generator-context)). So SH stays correct for any object placement, and each view sees it from its own camera.

`objectParams.maxShDegree` (default 4) caps the drawn degree below the generator's, per renderer, view, or object. Bands above the cap are skipped in a uniform branch, texture reads included, so a GUI can change it without recompiling.

### In your own generator

`GpuShReader` reads and evaluates stored SH. `fromSplats` uses one, and any generator can:

```ts
const sh = new GpuShReader({ codec: "ext", degree: 3 });
const base = SplatGenerator.fromSplats();
const generator: SplatGenerator<StoredSplats> = {
  generateSplat(i, context = SplatGenerator.context) {
    const s = base.generateSplat!(i, context).toVar();
    s.get("rgb").assign(max(s.get("rgb").add(sh.color(i, context.viewOrigin, s.get("center"))), vec3(0)));
    return s;
  },
  bind(data, context) {
    base.bind!(data, context);
    sh.bind(data.splats);
  },
};
```

| `GpuShReader` member | What it does |
|---|---|
| `new GpuShReader({ codec, degree, palette? })` | a reader of per-splat SH, or of labels and a palette |
| `GpuShReader.find(arrays, palette?)` | `{ codec, degree, palette }` for what the arrays hold, or undefined |
| `bind(arrays?, palette?)` | read these arrays' SH from now on. A lower degree, another codec, or no SH reads what it can (missing bands cost nothing) |
| `color(index, origin, center)` | the SH color (vec3) of stored splat `index` at `center`, seen from `origin` |
| `apply(splat, index, origin)` | a splat node with that color added to its rgb, clamped at 0 |
| `band(index, band)`, `coefficients(index)` | the decoded coefficients (vec3 each), for blending two tables' SH before `GpuSh.evaluate` |

Remapped generators pass the stored index. Generators that read two tables use two readers. Batch generators that place instances inside one object pass each instance's origin (`context.viewOrigin` through the instance's inverse transform).

## Sh

| Member | What it does |
|---|---|
| `Sh.COEFFICIENTS` | `[0, 3, 8, 15, 24]`: RGB coefficients per degree, band 0 excluded |
| `Sh.VALUES`, `Sh.MAX_DEGREE` | 72 and 4: an array of `Sh.VALUES` fits any degree |
| `Sh.LABEL` | the `shLabel` bundle definition |
| `Sh.codec(name)` | a codec by name: `encode`, `decode`, `words(degree)`, `channels(degree)` |
| `Sh.bundle(codec, degree)`, `Sh.bundleName(codec)`, `Sh.texels(codec, degree)` | the per-splat bundle's definition and name; texels per entry |
| `Sh.add(data, codec, degree)` | adds an empty SH bundle |
| `Sh.find(bundles)` | the SH bundle among a table's or a `GpuArrays`' bundles: `{ name, codec, degree }` |
| `Sh.encoder(data)`, `Sh.decoder(data)` | `(i, coeffs)` and `(i, out)` functions for loops over splats |
| `Sh.convert(data, codec, { degree? })` | the data with its SH in another codec (other bundles shared) |
| `Sh.prepare(data, degree, target)` | for file readers: adds the bundle for an `ShTarget` and returns its encoder |
| `Sh.basis(dir, out)`, `Sh.evaluate(coeffs, dir, degree, out?)` | the basis functions, and the SH color along a unit direction (the CPU twin of `GpuSh.evaluate`) |

`GpuSh.evaluate(dir, degree, coefficients, { cap?, limit? })` is the basis in TSL. `GpuSh.maxDegree` is the uniform that `maxShDegree` sets. `encodeShScale` and `decodeShScale` convert packed's scale byte.

`GpuSh.codec(name)` is a codec's TSL decoder (`decodeBand(band, texel)`), for tests and custom readers.

Types: `ShDegree` (1 to 4), `ShCodecName` (`"ext" | "packed"`), `ShTarget` (`ShCodecName | false`), `FoundSh` (returned by `Sh.find`), `ShCodec`, `GpuShCodec`, and `LoadedSplats` (returned by `loadSplatFile` and the readers).

## Costs

The projection evaluates SH once per splat; the draw is unchanged. On Sutro (2.0M splats, SH3, Apple M3 Max, `node scripts/bench.mjs --matrix sh`), the projection's GPU time grew by:

| Storage | WebGPU | WebGL2 |
|---|---:|---:|
| ext per splat (4 texels) | 0.46 ms | 0.87 ms |
| packed per splat (3 texels) | 0.28 ms | 0.62 ms |
| packed palette, labels in order / scattered | 0.12 / 0.35 ms | 0.29 / 0.22 ms |

A palette's stride (3 or 4 texels at SH3) made no measurable difference. The bands are nested branches that share one texel cache, so a texel used by two bands is read once (as is a palette label). Memory: `extSh` adds 64 bytes per splat at SH3 (96 at SH4) and `packedSh` 48 (80 at SH4). After gzip, RDX files grow by about 53 and 46 bytes per splat.

## Gotchas

- SH is evaluated in object space. Modifiers or skinning that rotate splats do not rotate their SH (as in Spark), so a spinning splat keeps its unrotated SH look.
- The view is the head, not each eye: a splat is generated once for both eyes.
- `packed` and `ext` do not reproduce SPZ's 8-bit values bit for bit, though their error is far below SPZ's own steps (1/16 and 1/8). To keep the exact SPZ bytes, load with `sh: false` and read them yourself (`SpzFile.unpack`).
- Per-splat ext SH4 reads 6 textures (packed: 5) beside the splat layout's, out of the 16 per stage that WebGPU and WebGL2 guarantee. A generator that reads other arrays too can run out. A palette reads 2 at any degree.
- A reader binds only arrays of its own codec; other arrays read as having no SH. `forArrays` picks the right reader for the arrays it gets.
- Radix has no LoD tree builder, so it never merges SH. Files with trees (RAD, SPZ with a tree) already store SH per node.
