# ArrayData

`ArrayData` is the table every other part of Radix stores data in: splats, LoD trees, sort keys, draw orders, and any data of an app's own. Rows are elements and columns are typed-array channels, grouped into named bundles. A table can be sent to workers without copying, saved to RDX files, and uploaded to the GPU (`GpuArrays`) row for row.

Code: `src/core/` (`formats.ts`, `bundles.ts`, `ArrayData.ts`, `layout.ts`), in `@sparkjsdev/radix/core`.

```ts
const POINTS = defineBundle({ position: "float32x4", color: "unorm8x4" });

const data = new ArrayData({ bundles: { points: POINTS }, count: 1000 });
const { position, color } = data.bundles.points.channels;

// position.data is a Float32Array of capacity * 4 floats, and color.data a
// Uint8Array, where offset 4 is element 1
position.data[0] = 1.5;
color.data.set([255, 128, 0, 255], 4);
```

## Formats

A format is a scalar type, optionally with a component count: `"uint32"`, `"uint32x4"`, `"unorm8x4"`, `"float16x2"`.

| Scalar | CPU array | In a shader |
|---|---|---|
| `uint8`, `uint16`, `uint32` | `Uint8Array`, `Uint16Array`, `Uint32Array` | `uint`, `uvec2`, `uvec4` |
| `sint8`, `sint16`, `sint32` | `Int8Array`, `Int16Array`, `Int32Array` | `int`, `ivec2`, `ivec4` |
| `unorm8`, `snorm8` | `Uint8Array`, `Int8Array` | normalized `float`, `vec2`, `vec4` |
| `float16` | `Uint16Array` (half-float bits) | `float`, `vec2`, `vec4` |
| `float32` | `Float32Array` | `float`, `vec2`, `vec4` |

- Formats with 1, 2, or 4 components can be stored on the GPU. Other counts (`"uint32x5"`, `"float32x3"`) stay on the CPU.
- `ArrayFormats.info(format)` returns a `FormatInfo`: `scalar`, `components`, `scalarBytes`, `bytes`, `array` (the typed array class), and `gpu` (whether the GPU can store it).
- `ArrayFormats.make(scalar, components)` builds a format from its parts.
- Types: `ArrayFormat`, `ScalarType`, `TypedArray`, `TypedArrayConstructor`, and `ArrayOf<F>` (the typed array of format `F`).

## Bundles

A bundle is a named set of channels that are used together: a codec, a reader, or a file section binds to all of them at once. Its definition is plain data.

```ts
// The definition of Splats.EXT
const EXT = defineBundle({ extA: "uint32x4", extB: "uint32x4" });

// 2 elements per GPU texel
const PAIRS = defineBundle({ pair: "uint32x2" }, { packing: 2 });

// Rebuilt after loading, so not saved to RDX
const DERIVED = defineBundle({ data: "uint32x5" }, { serialize: false });
```

| `defineBundle(channels, options?)` | Default | What it does |
|---|---|---|
| `channels` | | maps channel names to formats. The names say what the bits mean; there is no type tag |
| `packing` | 1 | elements per GPU texel: 1, 2, or 4. The channel's components times the packing must be 1, 2, or 4. CPU arrays are the same for every packing |
| `serialize` | `true` | set to `false` for data rebuilt after loading, which RDX files then skip |

- The definition's type keeps the channel names and formats, so `data.bundles.extSplats.channels.extA.data` is typed as a `Uint32Array`.
- `ArrayData.INDICES` (`{ index: "uint32" }`, packing 4) is the standard bundle for lists of element indices: draw orders, and subsets such as LoD subsets.
- Types: `BundleDef`, `BundleChannels`, and `Schema` (bundle names to definitions).

## ArrayData

```ts
const data = new ArrayData({
  bundles: { extSplats: Splats.EXT },
  count: 1000,
}).addBundle("pairs", PAIRS);

// A Uint32Array of capacity * 4
data.bundles.extSplats.channels.extA.data;

// Grows every bundle, keeping the contents
data.ensureCapacity(5000);
```

Every bundle of one table has the same rows. A LoD tree with one node per splat is a bundle next to the splats; data with a different row count, such as a draw order, goes in a table of its own.

| Member | What it does |
|---|---|
| `new ArrayData({ bundles?, count?, capacity?, meta? })` | a table of `count` valid rows (default 0). `capacity` defaults to `count` rounded up to a multiple of 4096 (`TextureLayout.alignCapacity`), which fills whole GPU texture rows |
| `count`, `capacity` | valid rows, and allocated rows |
| `bundles` | the bundles by name: each has `def`, `channels` (each `{ format, data }`), and `meta` |
| `meta` | a plain object of the table's own (RDX saves it) |
| `addBundle(name, def, { data?, meta? })` | adds a bundle; returns the table with its type extended. Arrays in `data` that hold `capacity` elements are used as they are; shorter ones are copied into new arrays |
| `removeBundle(name)` | removes a bundle; returns whether it was there |
| `setCapacity(n)` | resizes every channel, keeping the contents; `count` is clamped |
| `ensureCapacity(n)` | grows to at least `n` (at least doubling, in whole rows); returns whether it grew |
| `copyFrom(src, { bundles?, srcStart?, dstStart?, count? })` | copies rows of the bundles both tables have (or `bundles`); grows as needed; `count = max(count, dstStart + count)` |
| `clone()` | a deep copy |
| `swap(other)` | exchanges rows, capacity, bundles, and meta with `other` (double buffering) |
| `toTransferable()`, `ArrayData.fromTransferable(t)`, `setFromTransferable(t)`, `ArrayData.transferables(value)` | for sending to workers (below) |

Types: `ArrayBundle<D>`, `ArrayBundles<S>`, `ArrayChannel<F>`, and `TransferableArrayData`.

## Sending to workers

```ts
// A plain object holding the same arrays
const t = data.toTransferable();

// Moves the buffers rather than copying them
worker.postMessage(t, ArrayData.transferables(t));

// In the worker
const received = ArrayData.fromTransferable(t);
```

- After sending, `data` holds detached arrays and must not be used until its arrays come back.
- `data.setFromTransferable(back)` puts the returned arrays back into `data` in place. Bundles and channels with the same names and formats keep their objects, so references held elsewhere stay valid.
- `ArrayData.transferables(value)` collects the `ArrayBuffer`s inside any value, for `postMessage`'s transfer list. `WorkerPool` uses it for every call ([workers.md](workers.md)).

## Double buffering

`a.swap(b)` exchanges the contents of two tables. An app can read a front table while it fills the back one, then swap them; `GpuArrays.swap` does the same on the GPU.

## TextureLayout

`TextureLayout` maps elements to texels of a 2D array texture: 1024 texels per row, a power-of-two height up to 4096, and 2 to 512 layers. The CPU side uses it to size capacities, and the GPU side for uploads, readbacks, copies, and shader addressing.

| Member | What it does |
|---|---|
| `TextureLayout.for(texels)` | the layout holding `texels` texels: `width`, `height`, `layers`, `xBits`, `yBits`, and `texels` (the total) |
| `TextureLayout.alignCapacity(count)` | `count` rounded up to whole rows of 4-packed elements (multiples of 4096) |
| `layout.spans(start, count)` | the rectangles (`TexelSpan`: `x`, `y`, `layer`, `width`, `rows`, `offset`) that cover a range of texels |
| `TextureLayout.copySpans(src, srcStart, dst, dstStart, count)` | the rectangles (`CopySpan`) of a copy between two layouts |
| `WIDTH`, `MAX_PACKING`, `ROW_ELEMENTS`, `MAX_HEIGHT`, `MAX_LAYERS` | 1024, 4, 4096, 4096, 512 |

The rule for the shape and the addressing formula are in [gpu-arrays.md](gpu-arrays.md#texture-layout).

## Gotchas

- Capacities are multiples of 4096. A table of 10 rows allocates 4096.
- Arrays passed to a worker are detached until they come back. Hold on to the channel object (`bundle.channels.extA`) rather than its `data` array: `setFromTransferable` keeps channel objects of the same format but puts the returned arrays in them.
- Bundles with packing 2 or 4 need starts that are multiples of the packing when uploaded, copied, or read on the GPU.
