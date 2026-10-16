# GPU arrays

`GpuArrays` is an `ArrayData` table on the GPU: one 2D array texture per channel, with the same rows as the CPU table. `GpuArrayReader` reads a bundle in any shader stage, and `GpuArrayWriter` writes bundles from TSL as a fragment pass. All three work on WebGPU and WebGL2. On WebGPU, arrays made with `storage: true` can also be written from compute ([wgpu.md](wgpu.md)).

Code: `src/gpu/GpuArrays.ts`, `GpuArrayReader.ts`, `GpuArrayWriter.ts`, and `textureIo.ts`.

```ts
// One texture per GPU channel, uploaded
const arrays = GpuArrays.fromData(renderer, data);

// Reads in any shader stage; zero past count
const reader = new GpuArrayReader(POINTS).bind(arrays, "points");
material.colorNode = reader.load("color", instanceIndex);

// Rows back, as an ArrayData
const back = await arrays.read({ start: 0, count: 10 });
```

## Texture layout

Each channel is one 2D array texture 1024 texels wide, with a power-of-two height up to 4096 and 2 to 512 layers, so at most 2^31 texels. Texel `t` is at:

```
x     = t & 1023
y     = (t >> 10) & (height - 1)
layer = t >> (10 + log2(height))
```

- With packing 2, element `e` is in texel `e >> 1`; with packing 4, in texel `e >> 2`.
- The height is the largest power of two at or below half the number of rows (at most 4096), and the rows split into 2 to 512 layers. Small data uses 2 to 4 layers; past 4096 rows per layer, the texture grows one full layer at a time.
- `TextureLayout` does this math on the CPU ([arraydata.md](arraydata.md#texturelayout)), and readers and writers do it in shaders.

## GpuArrays

```ts
const arrays = new GpuArrays({
  renderer,
  bundles: { points: POINTS },
  capacity: 100_000,
});

// Rows 4096..5095
arrays.upload(data, { srcStart: 4096, dstStart: 4096, count: 1000 });

// GPU to GPU
arrays.copyFrom(other, { srcStart: 0, dstStart: 0, count: 500 });

// Exchange textures (double buffering)
arrays.swap(back);

// Free the textures
arrays.dispose();
```

| Member | What it does |
|---|---|
| `new GpuArrays({ renderer, bundles, capacity?, storage? })` | empty textures for a schema (bundle names to definitions). `storage: true` (WebGPU only) lets compute write them |
| `GpuArrays.fromData(renderer, data, { bundles?, storage? })` | the GPU copy of a table: its GPU-capable bundles (or `bundles`), uploaded |
| `GpuArrays.supports(def)` | whether every channel of a bundle can be stored on the GPU |
| `upload(data, { bundles?, srcStart?, dstStart?, count? })` | rows `[srcStart, srcStart + count)` of `data` to `dstStart`. With no range: all of `data`, growing as needed, and `count = data.count`. With a range: `count = max(count, dstStart + count)`; the range must fit the capacity. The bundles' meta is copied |
| `read({ bundles?, start?, count?, into? })` | rows back as an `ArrayData` (into `into` when given), each channel in its own typed array |
| `copyFrom(src, { bundles?, srcStart?, dstStart?, count? })` | a GPU copy from arrays with the same bundles and formats |
| `setCapacity(n)`, `ensureCapacity(n)` | reallocate every texture; the contents are discarded and `count` reset. `ensureCapacity` at least doubles, and does nothing when the capacity suffices |
| `write(writer, range)`, `writeBatch(items)` | run writers (below) |
| `swap(other)` | exchange contents with arrays of the same renderer and storage setting |
| `hasStorage()` | whether these are storage arrays; narrows the type to `GpuArrays<S, true>` |
| `bundle(name)` | a `GpuBundle` by name: `def`, `layout` (its `TextureLayout`), `channels`, and `meta`; throws for an unknown name |
| `renderTarget(outputs)` | a cached render target whose attachments are these channel textures (what fragment writers draw into) |
| `dispose()` | frees the textures |
| `count`, `capacity` | valid elements, and elements the textures hold (including the layout's padding) |
| `version` | grows whenever these methods change the contents (upload, copy, write, swap, or a reallocation), so a consumer can tell when to redo its work |
| `bundles`, `schema`, `storage`, `renderer` | the bundles by name, their definitions, the storage flag, and the renderer |

Each channel (`GpuChannel`) has `format` (the element's format), `texelFormat` (the texel's: the format times the packing), `texture` (a `THREE.DataArrayTexture` named `radix_<bundle>_<channel>`, the name WebGPU errors and debuggers show), and `storage` (whether compute can write it).

- Readback returns each channel as its own typed array on both backends. Only `snorm8` channels cannot be read back on WebGL2.
- A range that starts at the beginning of a texture row is uploaded as whole rows, taking the rest of the last row from the table's spare capacity. Starts of packed bundles must be multiples of the packing.
- After `swap`, `setCapacity`, or a growing upload, bind readers again.

Types: `GpuBundle`, `GpuBundles`, `GpuChannel`, and `WriterFor<Storage>` (the writers arrays accept: compute writers only on storage arrays).

## GpuArrayReader

```ts
const reader = new GpuArrayReader(Splats.EXT).bind(arrays, "extSplats");

// A uvec4, in any shader stage; zero past count
const a = reader.load("extA", index);

// The same without the bounds check
const b = reader.fetch("extB", index);
```

| Member | What it does |
|---|---|
| `new GpuArrayReader(def)` | a reader of one bundle definition. The shader code is built from the definition alone, so one shader can read different arrays from draw to draw |
| `bind(arrays?, name?)` | read bundle `name` of `arrays` from now on; without arrays, `count` becomes 0. Returns the reader |
| `load(channel, index)` | element `index` of `channel`, typed by its format; zero past `count` |
| `fetch(channel, index)` | the same without the bounds check |
| `count` | a `uint` uniform: the elements `load` can read |

Bind again after the arrays' count changes or after they are resized or swapped. For splats, the readers in [splats.md](splats.md#gpusplatreader-the-shader-side) also decode the data.

## GpuArrayWriter

```ts
const writer = new GpuArrayWriter({
  outputs: { extSplats: Splats.EXT },
  write: (index, out) => {
    const splat = reader.loadSplat(index);
    const pbr = reader.loadPbr(index);
    GpuSplats.storeExt(out.extSplats, splat, pbr);
  },
});

// Elements [at, at + count); index starts at `first`
arrays.write(writer, { at: 0, count: n, first: 0 });

// Several writers and ranges, one pass per layer
arrays.writeBatch([
  { writer, at: 0, count: 1000 },
  { writer: other, at: 4096, count: 500 },
]);
```

- `write(index, out)` assigns one value per output channel: a whole texel, typed by the channel's texel format (`out.extSplats.extA` is a `uvec4`). With packing p, one call writes p elements and `index` is the first of them; `at` must then be a multiple of p.
- The writer runs as a fragment pass on both backends: one render pass per layer, each range drawn as a quad over its rows. `writeBatch` draws all the ranges that overlap a layer in one pass for that layer, so batching many ranges together saves passes. Ranges should not overlap.
- Limits (`GpuArrayWriter.MAX_CHANNELS`, `MAX_BYTES`): at most 4 channels and 64 bytes per texel (WebGPU counts `rgba8unorm` as 8), one packing for all outputs, and renderable formats only (not `snorm8`).
- Each write sets `count = max(count, at + count)`.
- `label` (default from the channels) names the render pipeline and its shaders in WebGPU errors and debuggers.
- `arrays.write` and `writeBatch` take any `ArrayWriter`: the fragment `GpuArrayWriter`, or the compute `WgpuArrayWriter` on storage arrays, which has the same arguments and gives the same texels ([wgpu.md](wgpu.md)). A batch runs the writers of each kind together.

| Type | What it is |
|---|---|
| `ArrayWriter<O, Storage>` | what `write` and `writeBatch` run: `outputs`, `packing`, `channels`, `storage`, and `run` |
| `WriteRange` | `{ at?, count, first? }`: the first element written (default 0), how many, and the index `write` sees at `at` (default 0) |
| `WriteItem` | a `WriteRange` plus its `writer` |
| `WriterOutput` | one output channel: `{ bundle, channel, texelFormat }` |
| `WriterOutputs<O>` | the `out` argument of `write`: a TSL variable per output channel |

## Gotchas

- A writer must not read the arrays it writes in the same pass. Write into other arrays, then `swap`.
- `setCapacity` on the GPU discards the contents (unlike `ArrayData.setCapacity`). Use `copyFrom` from the old arrays to keep them.
- Storage arrays (`storage: true`) throw on WebGL2. Check `getGpuCaps(renderer).compute` first.
