# Sorting

Gaussian splats are semi-transparent and must be blended back to front, so every render needs them in order. Radix computes a sort key per splat in the projection, then sorts the keys either on the GPU in the same frame (WebGPU) or on a worker a few frames later (the WebGL2 path). Everything one renderer draws is sorted together, so overlapping objects blend correctly.

Code: `src/core/sort.ts` (`SortKeys`), `src/gpu/sortKey.tsl.ts` (`GpuSortKeys`), `src/wgpu/WgpuSplatSorter.ts`, `WgpuRadixSort.ts`, `WgpuCompact.ts`, `src/worker/splatSort.ts` (`sortSplatKeys`), and `src/render/SplatView.ts`.

```ts
// The WebGL2 path, also on WebGPU (to compare)
splatRenderer.sortMode = "cpu";
// The exact float order (a 4th GPU pass)
splatRenderer.sortBits = 32;
// The CPU sort drops splats well outside the view
splatRenderer.objectParams.sortGuard = 0.5;
```

## Sort keys

Each splat's key is its distance from the head as bits, arranged so that ascending keys run back to front. Distances are measured from the head, not along the view direction, so one order stays valid for every view direction from the same position, and both eyes of an XR pair share one sort.

| `sortBits` | GPU radix passes | CPU sort | Orders splats apart by | Use it for |
|---|---|---|---|---|
| 16 | 2 | one counting pass | about 0.1% of their distance; a clamped window of 6 exponent bits (2^-32 to 2^32) and 10 mantissa bits | the cheapest sort: 35-55% faster than 24 bits |
| 24 (default) | 3 | two passes of 11 and 13 bits | about 0.0015% of their distance | a balance of quality and speed |
| 32 | 4 | two passes of 16 bits | the exact float32 order | exact references |

- The key width is a uniform, so changing `sortBits` rebuilds nothing.
- 32-bit keys keep the float32 distance's 31 bits (its sign is always 0); 24-bit keys keep `f >> 7`.
- The **invalid key** is all ones (`SortKeys.invalid(bits)`). Splats that are not drawn get it, sort last, and are dropped. Non-finite distances give it too.
- `SortKeys.compute` (CPU) and `GpuSortKeys.compute` (TSL) give the same key bit for bit.
- Keys are stored as the 4 bytes of an RGBA8 texel (the `sortKeys` bundle, `SortKeys.KEYS`), read back as a `Uint32Array`.

## The GPU sort

With `sortMode: "gpu"` (WebGPU's default), each render runs, after the projection, in one compute pass:

1. **Compaction** (`WgpuCompact`): drops invalid keys and keeps the rest in input order. With the GPU sort, splats culled in every eye get the invalid key, so they are neither sorted nor drawn.
2. **Radix sort** (`WgpuRadixSort.sortIndirect`): a stable LSD sort with 8-bit digits, sized on the GPU from the compacted count.
3. **Draw arguments**: a one-thread kernel writes `[6 × 1024, ceil(visible / 1024), 0, 0, 0]` for the indexed indirect draw.

Nothing is read back, so each frame is drawn in order for the current camera, with any number of cameras. `WgpuSplatSorter` combines the three ([wgpu.md](wgpu.md#wgpusplatsorter)); `splatRenderer.readSortedCount()` reads the visible count back for stats.

Sorting more keys than the device's storage binding limit allows (by default 256 MiB, or 64M keys) throws an error naming the limit; `createRenderer({ limits: { maxStorageBufferBindingSize: "adapter" } })` asks for all the adapter has ([renderer.md](renderer.md#device-baselines)).

## The CPU sort

WebGL2 has no compute shaders. With `sortMode: "cpu"`:

1. A **keys pass** (a cached program that writes only sort keys: a fragment pass on WebGL2, compute on WebGPU) computes each splat's key for the view's collection and camera.
2. The keys are **read back** asynchronously.
3. A worker **sorts** them (`sortSplatKeys`, running `SortKeys.sort`).
4. The view **applies** the order, and its renders draw it until a newer one is applied.

The order arrives a few frames late. It still draws correctly, because a late order indexes the same splats of the same collection: while the camera moves, the blend order is only slightly out of date. A new collection shows once a sort of it has landed. `autoSort` runs this loop for each view ([views.md](views.md#autosort)).

- With the CPU sort, keys of splats outside the view stay valid (only invisible splats and splats outside `sortGuard` are dropped), so a late order still includes splats that come into view; the draw culls per eye.
- Sorts run on `SplatRenderer.sortPool`, one pool shared by every renderer and view: up to `SplatRenderer.sortWorkers` sorts (4 by default; set it before the first CPU sort) run at once, the rest wait in turn, and a worker serves whichever view sorts next. It is separate from `WorkerPool.default`, so sorts never wait behind file loads. The pool is made on the first CPU sort, starts workers as sorts need them, and lives with the page. `sortWorker` points a renderer at a pool or lease of the app's instead. A renderer in gpu mode sorts on no worker; `view.sort()` in gpu mode needs a `sortWorker`.
- Sorting never runs on the main thread: a sort of millions of keys takes tens of milliseconds.

`sortSplatKeys(keys, { bits, ordering?, worker? })` is the worker sort on its own ([workers.md](workers.md#sortsplatkeys)). `SortKeys.sort({ keys, count, bits, ordering? })` is the sort itself, on the current thread: stable, invalid keys last, returning `{ ordering, visible }`.

## sortGuard

The CPU sort's order lags the camera, so its keys cannot cull by the view: a splat off screen now may be on screen when the order is drawn. `objectParams.sortGuard` adds a guard band: splats farther outside the head's view than this (in NDC beyond the edges, plus each splat's extent) get the invalid key, so fewer splats are sorted and drawn.

- 0 (the default) keeps every splat. 0.5 reduced the WebGL2 draw by 24-68% on full turns in the benchmarks, with identical still frames. Both pages default to 0: set it from the guard band slider in `/build/examples/splats/index.html`, or with `?guard=0.5` on `/build/examples/xr/index.html`.
- With a guard set, re-sort when the view turns, not only when it moves: `autoSort` does, using its `angle`.
- The GPU sort culls against the current view every frame and ignores `sortGuard`.

## SortKeys

| Member | What it does |
|---|---|
| `SortKeys.compute(distance, bits)` | the key of a distance (>= 0) |
| `SortKeys.invalid(bits)`, `SortKeys.validMax(bits)` | the invalid key (all ones), and the largest valid key |
| `SortKeys.sort({ keys, count, bits, ordering? })` | stable ascending sort into `ordering` (default: a new array of a whole capacity); returns `{ ordering, visible }` |
| `SortKeys.KEYS` | the `sortKeys` bundle: `{ key: "unorm8x4" }`, not serialized |
| `SortKeys.KEY16_LO`, `KEY16_HI` | the float bit range 16-bit keys keep |

`SortKeyBits` is `16 | 24 | 32`. Draw orders are `ArrayData.INDICES` lists.

## Costs

At 10M splats on an Apple M3 Max, the GPU radix sort takes about 3, 4.7, and 7 ms at 16, 24, and 32 bits; compaction under 1 ms. The CPU path's readback and worker sort take tens of milliseconds at millions of splats, but they run asynchronously while frames keep rendering ([performance.md](performance.md)).
