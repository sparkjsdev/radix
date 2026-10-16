# Splats

A table stores Gaussian splats in one bundle, in one of three layouts. CPU code reads and writes them through `Splats`, and shaders through `GpuSplatReader` and `GpuSplats`. Both sides use the same bits, so a splat encoded in a worker decodes to the same values in a shader.

Code: `src/core/splats.ts` (`Splats`); `src/gpu/splatAccess.ts` (`GpuSplatReader`) and `splats.tsl.ts` (`GpuSplats`). How each field is encoded: [encoding.md](encoding.md).

```ts
// Ext splats by default, in data.bundles.extSplats
const data = await loadSplats(url);

// The splat bundle, whichever layout was loaded
const { bundle } = Splats.get(data);

// Splat 0, read into a new record
const splat = Splats.makeSplat();
Splats.load(bundle, 0, splat);
const { center, scales, quaternion, rgb, opacity } = splat;
console.log(center, scales, quaternion, rgb, opacity);
```

## Layouts

| Layout and bundle name | Definition | Size | Holds |
|---|---|---|---|
| `extSplats` (the default) | `Splats.EXT`: `extA`, `extB` (`uint32x4` each) | 32 B | a float32 center, opacity, HDR color, half-float log scales, and a rotation; PBR: a normal, roughness, and metallic |
| `covSplats` | `Splats.COV`: `covA`, `covB` | 32 B | like ext, but a covariance instead of scales and rotation; a normal, but no roughness or metallic |
| `packedSplats` | `Splats.PACKED`: `packed` (`uint32x4`) | 16 B | half the memory of ext: 8-bit color and opacity, a half-float center, 8-bit log scales, and an 8 + 8 + 8 bit rotation; no PBR |

A layout's name is also its standard bundle name, so ext splats are in `data.bundles.extSplats`. Lookups try the standard names first, then any bundle with a layout's channels.

Spherical harmonics (bands 1 to 4) are not part of a layout. They sit in an SH bundle beside the splat bundle (`extSh` by default, `packedSh`, or a palette's labels) and work with any layout. `Sh.find(data.bundles)` finds the bundle by its channel names, as `Splats.find` finds the splats ([sh.md](sh.md)).

The words of each layout (A and B are `uint32x4`):

```
ext (32 B)
  A.xyz  center, float32
  A.w    normal (Oct24, 0 = none) | opacity byte << 24 (128 = 1.0)
  B.x    rgb: three 8-bit magnitudes, three sign bits, a shared 5-bit exponent
  B.y    half(ln sx) | half(ln sy) << 16
  B.z    half(ln sz) | roughness unorm8 << 16 | metallic unorm8 << 24
  B.w    rotation, QuatOct32: a 10 + 10 bit octahedral axis
         | a 12-bit angle << 20
cov (32 B)
  A, B.x as ext
  B.y    half(ln xx) | half(ln yy) << 16
  B.z    half(ln zz) | half(c_xy) << 16
  B.w    half(c_xz) | half(c_yz) << 16       (c = sign x ln|correlation|)
packed (16 B)
  x      r, g, b over [rgbMin, rgbMax] and opacity, unorm8 each
  y      half(cx) | half(cy) << 16
  z      half(cz) | the rotation's 8 + 8 bit axis << 16
  w      three 8-bit log scales over [lnScaleMin, lnScaleMax] (0 = zero)
         | the rotation's 8-bit angle << 24
```

`Splats.LOD_TREE` (`node`: `uint32x2`, the child count and the first child's index) defines a LoD tree with one node per splat, stored next to the splats in the bundle `lodTree`. `Splats.findLodTree(data)` returns it. Files that have a tree load it into that bundle ([files.md](files.md)).

## Choosing a layout

| Layout | Choose it for |
|---|---|
| `extSplats` | the default: full precision, HDR colors, and PBR fields for lighting |
| `covSplats` | data that comes as covariances (merged LoD nodes, some generators), and the `ewa` method, which reads covariances directly |
| `packedSplats` | large files and low-memory devices: half the memory and about 30% faster projection, with colors and scales limited to the encoding's ranges |

```ts
const layout = settings.lowMemory ? "packedSplats" : "extSplats";
const data = await loadSplats(url, { layout });

// Packed splats with room for HDR colors
const hdr = await loadSplats(url, {
  layout: "packedSplats",
  encoding: { rgbMin: -0.5, rgbMax: 1.5 },
});
```

**Packed encodings.** `PackedEncoding` (`rgbMin`, `rgbMax`, `lnScaleMin`, `lnScaleMax`) sets the ranges of the 8-bit codes. Every field is optional. Missing fields come from the source when it already holds packed splats (an RDX file, or `Splats.convert` from packed splats), and otherwise from `Splats.DEFAULT_PACKED_ENCODING`: colors 0 to 1, ln scales -12 to 9. The bundle keeps its encoding in `meta.encoding`; `Splats.packedEncodingOf(bundle)` returns it with the defaults filled in. Pass ranges when colors go outside 0 to 1 (HDR) or scales outside e^-12 to e^9.

## Records

```ts
// Every layout
interface Splat {
  center: Vec3;
  scales: Vec3;
  quaternion: Quat;
  rgb: Rgb;
  opacity: number;
}

// Ext only
interface Pbr { normal: Vec3; roughness: number; metallic: number }
type ExtSplat = Splat & Pbr;

interface CovSplat {
  center: Vec3;
  cov: Cov;
  rgb: Rgb;
  opacity: number;
  normal: Vec3;
}
```

- `Vec3` is `{ x, y, z }`, `Quat` is `{ x, y, z, w }`, `Rgb` is `{ r, g, b }`, and `Cov` is `{ xx, yy, zz, xy, xz, yz }`, so `THREE.Vector3`, `Quaternion`, and `Color` work directly.
- Opacity 1 is opaque; ext and cov store up to 255 / 128 (about 2), for merged LoD nodes.
- A normal of zero means none. Roughness is perceptual, 0 to 1.
- `Splats.makeSplat()`, `makePbr()`, `makeExtSplat()`, and `makeCovSplat()` make records: a unit splat at the origin, white and opaque, roughness 1, metallic 0, no normal.

## Splats: the CPU side

```ts
const splats = data.bundles.extSplats;

// Any layout (cov is diagonalized)
Splats.load(splats, i, splat);

// Any layout; keeps the PBR bits
Splats.store(splats, i, splat);

// Ext only
Splats.loadPbr(splats, i, pbr);

// Ext only; keeps the 3DGS bits
Splats.storePbr(splats, i, pbr);

// Any layout; reads only the center
Splats.loadCenter(splats, i, out);

// @ts-expect-error packed splats have no PBR
Splats.loadPbr(packed.bundles.packedSplats, i, pbr);
```

A bundle's type comes from its definition, so TypeScript accepts a call only when the layout stores that data. Code that works with any layout finds the bundle with `Splats.get`:

```ts
// Throws when there is no splat bundle (Splats.find returns undefined)
const { name, layout, bundle } = Splats.get(data);
Splats.load(bundle, i, splat);
if (Splats.isExt(bundle)) Splats.loadPbr(bundle, i, pbr);
```

For loops over every splat, `Splats.encoder(bundle)` and `Splats.decoder(bundle)` pick the layout's codec and look up its arrays once, before the loop. They return `(i, splat)` functions that write or read every field as an `ExtSplat`. Fields the layout lacks read as no normal, roughness 1, and metallic 0. The file readers and writers use them.

| Member | What it does |
|---|---|
| `EXT`, `COV`, `PACKED`, `LOD_TREE` | the bundle definitions |
| `LAYOUTS` | layout names to definitions |
| `DEFAULT_PACKED_ENCODING` | `{ rgbMin: 0, rgbMax: 1, lnScaleMin: -12, lnScaleMax: 9 }` |
| `makeSplat()`, `makePbr()`, `makeExtSplat()`, `makeCovSplat()` | new records |
| `isExt(bundle)`, `isCov(bundle)`, `isPacked(bundle)` | type guards by channel names and formats |
| `layoutOf(bundle)` | the layout of a bundle (`undefined` when it is none) |
| `findBundle(bundles, name?)` | `{ name, layout }` of the splat bundle among any bundles (of an `ArrayData` or a `GpuArrays`): `name` when given, else the standard names, else any bundle of a layout |
| `find(data, name?)`, `get(data, name?)` | `{ name, layout, bundle }` (`FoundSplats`); `get` throws when there is none |
| `findLodTree(data)` | the `lodTree` bundle, or `undefined` |
| `add(data, { layout?, encoding? })` | adds an empty splat bundle named after its layout (default `extSplats`) |
| `make(count, { layout?, encoding?, meta? })` | a new `SplatData<L>` of `count` empty splats |
| `convert(data, { layout, encoding? })` | the data in another layout: `data` itself when it already is, else a new table that shares the arrays of every other bundle |
| `load` / `store`, `loadPbr` / `storePbr`, `loadCenter` | one splat's fields, as above |
| `encoder(bundle)`, `decoder(bundle)` | per-splat functions for loops |
| `encodeExt` / `decodeExt`, `encodeCov` / `decodeCov`, `encodePacked` / `decodePacked` | every word of one splat of one layout, with the same bits (`ExtSplat`, `CovSplat`, `Splat`) |
| `toCov(splat, out)`, `fromCov(cov, out)` | scales plus rotation to a covariance, and back (an eigendecomposition) |
| `packedEncodingOf(bundle)` | a packed bundle's encoding, defaults filled in |

Types: `Splat`, `Pbr`, `ExtSplat`, `CovSplat`, `ExtSplats`, `CovSplats`, `PackedSplats` (typed bundles), `SplatBundle` (any of them), `SplatBundles`, `SplatLayout`, `SplatData<L>` (an `ArrayData` with layout `L`'s bundle), `SplatTarget` (`{ layout?, encoding? }`), `SplatReadOptions` (a target plus `progress`), `FoundSplats`, `BundleLike` (anything with named channels of formats), and `PackedEncoding`.

## GpuSplatReader: the shader side

```ts
// A GpuExtSplatReader on arrays.bundles.extSplats
const reader = GpuSplatReader.for("extSplats").bind(arrays);

// SplatNode: a TSL struct with the record's fields, plus index
const splat = reader.loadSplat(index);

// CovSplatNode: converted here; read directly from cov splats
const cov = reader.loadCovSplat(index);

// PbrNode (ext only)
const pbr = reader.loadPbr(index);

// A vec3; reads extA only
const center = reader.loadCenter(index);

// A bound reader for whichever layout the arrays hold
const any = GpuSplatReader.from(arrays);
if (any.layout === "extSplats") any.loadPbr(index);
```

- There are three readers: `GpuExtSplatReader`, `GpuCovSplatReader`, and `GpuPackedSplatReader` (which reads its encoding from the bundle's meta when bound). `AnyGpuSplatReader` is the union.
- Every reader has `loadSplat`, `loadCovSplat` (each converts from the form the layout stores), `loadCenter`, `loadRgb`, and `loadOpacity`; ext adds `loadPbr`. Each load fetches only the channels it needs, and reads zero past `count`.
- `bind(arrays, name?)` binds the bundle named after the reader's layout, or else any bundle of that layout; pass `name` for another bundle. Bind again after the arrays' count changes, or after they are resized or swapped.
- Splat structs carry the `index` they were loaded from, so effects can key per-splat randomness on it.
- To draw stored splats, wrap a reader in a generator with `SplatGenerator.fromSplats({ layout })`, or use `SplatCollection.arrays(arrays)`, which does the wrapping ([generators.md](generators.md)).

`GpuSplats` holds the struct constructors and the TSL codecs. This writer stores splats from a shader, baking a generator into arrays:

```ts
const writer = new GpuArrayWriter({
  outputs: { extSplats: Splats.EXT },
  write: (i, out) => {
    const splat = generator.generateSplat(i);
    const pbr = GpuSplats.Pbr(normal, roughness, metallic);
    GpuSplats.storeExt(out.extSplats, splat, pbr);
  },
});

arrays.write(writer, { at: 0, count });
```

| `GpuSplats` member | What it does |
|---|---|
| `Splat(center, scales, quaternion, rgb, opacity, index?)` | a `SplatNode` (fields left out are zero) |
| `CovSplat(center, xxyyzz, xyxzyz, rgb, opacity, normal, index?)` | a `CovSplatNode`: the covariance's diagonal and off-diagonal as two `vec3`s |
| `Pbr(normal, roughness, metallic)` | a `PbrNode` |
| `decodeExt(a, b)`, `decodeExtPbr(a, b)`, `encodeExt(splat, pbr)` | ext words (two `uvec4`) |
| `decodeCov(a, b)`, `encodeCov(cov)` | cov words |
| `decodePacked(p, encoding?)`, `encodePacked(splat, encoding?)` | packed words; `encoding` is a `PackedEncoding` or a TSL `vec4` |
| `storeExt(out, splat, pbr?)`, `storeCov(out, cov)`, `storePacked(out, splat, encoding?)` | fill a writer's outputs for that layout |
| `toCov(splat)`, `fromCov(cov)` | convert between the forms |
| `splatOf(generator, i)`, `covSplatOf(generator, i)` | a generator's splat in the asked form, converted when the generator lacks it |
| `withIndex(node, index)` | a copy of a splat struct with its `index` set |
| `normalOf(splat)` | the unit axis of the smallest scale, rotated: a flat splat's normal |

Types: `SplatNode`, `CovSplatNode`, and `PbrNode` (`StructNode<Fields, Brand>`): their `get()` accepts only their own field names, and the type checker rejects one kind of node where another is expected. More on writing TSL: [shaders.md](shaders.md).

## Gotchas

- `Splats.convert` returns the same object when no conversion is needed; do not assume a copy.
- Packed splats clamp colors and scales to their encoding's ranges. Check `encoding` for HDR colors or very small or large splats.
- GPU and CPU encodings give the same bits, except where float32 rounding on the GPU lands on the other side of a step from the CPU's float64: under 2% of ext and packed splats and about 7% of cov splats (correlations near 1) come out one code step off ([encoding.md](encoding.md#cpu-and-gpu)).
