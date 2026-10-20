# Checks

Radix has three sets of checks: core checks in Node (no browser), GPU checks in the browser on both backends, and a check of these docs. Performance is measured separately, by the benchmarks at the end.

| What | Command | Needs |
|---|---|---|
| core checks | `npm run check:core` | Node |
| GPU checks, both backends | `npm run check:test` (`scripts/check-test.mjs`) | `npm run build:test`, `npm run serve` and Chrome |
| GPU checks, one backend | open `http://localhost:8000/build/test/gpu/index.html?gpu=webgpu` or `?gpu=webgpu-gl` | `npm run build:test` and `npm run serve` |
| example pages, both backends | `npm run check:examples` (`scripts/check-examples.mjs`) | `npm run build`, `npm run serve` and Chrome |
| docs | `npm run check:docs` | Node |
| types | `npm run typecheck` (`tsconfig.lib.json`, `tsconfig.core.json`, `tsconfig.examples.json`, `tsconfig.test.json`) | Node |
| lint | `npm run lint` (the types, then `eslint .`) | Node |

## check:core: core checks in Node

`npm run check:core` (`scripts/check-core.ts`) runs without a browser. It checks:

- `ArrayData`: types, shared arrays, growth, copies, transfer, `swap`, and `setFromTransferable` keeping the existing objects.
- RDX: round trips of whole and chunked files, chunks read out of order, range reads, and chunked URLs.
- Codecs: every field stays within its bit budget (rounded octahedral normals within 0.06 degrees, and the generic and fixed-size codecs agree), and covariance round trips.
- Splat access: `Splats.loadCenter` matches `Splats.load` for every layout. `Splats.store` and `Splats.storePbr` each leave the other's bits unchanged, and together they produce the same words as `Splats.encodeExt` (likewise for the cov and packed layouts). `Splats.get` / `Splats.find` look up the splat bundle by explicit name, then by the standard names, then by formats.
- Layouts: `SplatFiles.decode` decodes every format into `packedSplats` with an encoding and into `covSplats`. The packed `encoding` is optional: the defaults apply when it is left out, partial fields are filled from the defaults, and an RDX file keeps its own encoding. `Splats.convert` returns data already in the layout unchanged, converts data in another layout, shares the other bundles, and renames a bundle without copying its arrays. `SplatData` typing is checked too.
- Types: `Splats.loadPbr` is refused for packed and cov bundles and for untyped ones, and accepted after `Splats.isExt`.
- Files:
  - PLY with and without PBR, point clouds, and SH degrees.
  - Compressed PLY round trips in table and Morton order, and older SuperSplat files (without color ranges, with an `sh` element).
  - SPZ versions 2, 3, and 4: PBR and the LoD tree round trip. SPZ 4 at SH degrees 0 and 4, with its records, unpacks to the same columns as version 3 and is detected by its `NGSP` header. Version 4 inside gzip reads as version 3 with SH degree 4.
  - SPZ extension records: safe orbit, coordinate system (with and without conversion), and unknown types skipped.
  - `SpzFile.unpack` of streams in chunks of 1, 7, and random sizes gives the same columns, rejects early ends, and with `sh: false` stops before SPZ 4's SH stream.
  - Tampered SPZ 4 files are rejected: table of contents, stream counts and sizes, trailing bytes, point counts, truncated and corrupt streams.
  - RAD with several chunks and a LoD tree, format detection, and `SplatFiles.encode` / `decode` for every format.
- zstd: Radix's encoder is read by fzstd and by Node's zstd, and Node's frames by fzstd, on random, skewed, RLE, and mixed data across block edges. A wrong size is refused.
- Axes: all 256 pairs of the 16 coordinate systems round trip; SH matches when seen from the converted direction; quaternions and permuted scales match M Σ Mᵀ; flips change only SH signs. `Axes.convert` on ext, cov, and packed tables (per-splat SH and a palette) matches converting one splat at a time.
- Spherical harmonics:
  - Each codec round trips at every degree within its budget: RMS color error at most 0.2 / 255 (ext) and 0.4 / 255 (packed), on values with ±5 outliers. Reading degrees 1 to 3 of a degree-4 entry equals a lower-degree encode.
  - `Sh.find` identifies each degree's channel set (`extShA`..`F`, `packedShA`..`E`) and rejects other names and partial sets.
  - Palettes use power-of-two strides by default, and convert and expand.
  - Every writer round trips through its reader: PLY, RDX, and RAD `f32` exactly; RAD `f16` and `s8`, compressed PLY, and SPZ within their steps. `sh: false` skips SH and records its degree.
  - Degree 4 round trips through PLY (72 `f_rest`), SPZ, and RDX; compressed PLY and RAD keep its first 3 bands.
  - Loading defaults to ext and takes a codec; RDX keeps its codec unless asked.
  - RAD clustered SH written from a palette (`f32`, `f16`, and `s8` codes; labels over several chunks) reads back as that palette, in the `sh` codec or skipped. The PLY and RDX writers expand it per splat.
  - A hand-built RAD in Spark's clustered layout (`s8` codes in chunk 0, `u16` then `u32` labels) reads as an ext palette of its codes; one with 70,000 entries expands to per-splat SH.
  - `Sh.evaluate` along the axes, and for bands 1 to 4 against real SH computed from associated Legendre polynomials.
- Sort keys: keys are monotonic in distance and order splats back to front at 16, 24, and 32 bits, and non-finite distances give invalid keys. `SortKeys.sort` is stable, puts invalid keys last, and gives the same order at every key width. `ArrayData.INDICES` has the expected definition.

`tsconfig.core.json` also typechecks the script, so its `@ts-expect-error` lines test the types.

## /build/test/gpu/index.html: GPU checks in the browser

`/build/test/gpu/index.html?gpu=webgpu` and `?gpu=webgpu-gl` run the checks in `test/gpu/`: `tests.ts`, then `splatTests.ts`, `shTests.ts`, `wgpuTests.ts`, `renderTests.ts`, `sceneTests.ts`, and `controlsTests.ts`, with helpers in `renderUtils.ts`. `?run=0` loads the page without running them. The checks:

- Upload and readback for every GPU format, packed and unpacked.
- Ranges that start in the middle of a row, GPU copies, and capacity growth.
- `GpuArrayReader` in a fragment shader, compared with the CPU data.
- The splat functions that fill `THREE.Vector3`, `Quaternion`, and `Color`.
- Splat readers against CPU decoding for every layout and load function, bound by their default bundle names, and `GpuSplatReader.from(arrays)` picking the layout.
- `GpuSplats.store*` encoding against the CPU's bits, through the fragment writer and, on WebGPU, through the compute writer. Splats whose code is one step off must still decode within the encoder's budgets.
- `GpuArrayWriter` ranges across rows and layers, packing 1, 2, and 4, `writeBatch`, and the writer's limits.
- `GpuArrays.swap` with a rebound reader.
- Spherical harmonics (`shTests.ts`):
  - `GpuShReader` decodes ext and packed SH like `Sh` on the CPU: per splat at degrees 1 to 4 of a degree-4 bundle, and through palettes of degree 3 (strides 4 and 3) and 4 (strides 8, and 6 or 5).
  - The projection adds each object's SH from its own view origin, matching the same splats with that color baked in. Two placements are tested, one turned and scaled, and degree 4 per splat.
  - `objectParams.maxShDegree` caps the bands: 1 and 3 on degree-4 data, and 0 matches no SH.
  - Palettes of both codecs draw in one collection.
  - A RAD with clustered SH is written on a worker (the palette's arrays come back). `loadSplatFile` loads the same palette on a worker and on the page, and `loadSplats` expands it to the same per-splat SH on both.
  - A `GpuShReader` in a custom remapped generator matches `fromSplats`.
- The projected word codecs: ewa's `depth20` within 2^-16 of the depth (clamped to 2^-14 to 2^18) and `angle12` within π / 8192; the ray methods' center within 5e-6 rad of its direction (octahedron corners, axes, and both sides of the fold included) with its distance, whatever the last head word holds below bit 24.
- `createRenderer` with `profile`, `hdr`, and `directCanvas`.
- `loadSplats` / `writeSplats` give the same results with every `worker` choice. A pool makes no workers until it is used, and the data comes back from a failed write. `loadSplats` into `packedSplats` with an encoding gives the same bits on a worker and on the current thread. A `signal` aborted before the load, or on its first progress report, rejects with its reason on a worker and here, and the pool then loads again; a load queued behind a lease leaves the queue when aborted. `request` reaches `fetch` here and goes to a worker, a `Headers` object too.

WebGPU only (`wgpuTests.ts`). These are skipped on WebGL2, where `storage: true` must throw instead:

- `WgpuBuffer` upload, read, clear, `copyFrom`, growing with `keep`, and an atomic counter.
- `WgpuCompute` dispatched with 5M threads (more than 65535 workgroups), 2D workgroups, and an indirect buffer. `WgpuComputeBatch` in one pass and split.
- `WgpuArrayWriter` for every storable format at packing 1, 2, and 4: a range across layers with `first`, a batch mixed with a fragment writer, and the same texels as the source and as the fragment writer.
- The compute writer's limits, and its refusal of arrays made without `storage` (also a type error, checked with `@ts-expect-error`).
- `WgpuArrayStore` writing in reversed order, writing packed texels, and rebinding after `swap`.
- Storage arrays: upload, read, `copyFrom`, `swap`, and readers in fragment and compute shaders.

Projection, sorting, and drawing (`renderTests.ts`; the WebGPU-only checks are skipped on WebGL2):

- `WgpuRadixSort` against `SortKeys.sort` with 16-, 24-, and 32-bit keys, both scan tiers, and counts of 0, 1, around one block, and 70000 (WebGPU).
- `WgpuCompact` with sort keys read from an RGBA8 texture, followed by `sortIndirect`, against `SortKeys.sort` (WebGPU).
- Every projection method on every splat layout with 1 and 2 eyes. The compute and fragment writers give the same words and sort keys (WebGPU). In stereo, with the head placed at one eye, that eye gives its mono words (WebGL2 compilers may round raygs' float c² a few ulps apart).
- A TSL generator that gives only splats, or only covariances, projects like the same splats read from arrays. Two objects of one collection at different offsets equal one object that holds both.
- ewa bounds against a CPU EWA reference, and ewa, 3dgut, and htgs bounds agreeing for small, distant splats.
- Culling behind the camera, off screen, and under `minAlpha`, with sort keys marked invalid only when `cullKeys` asks for it.
- Sort keys against `SortKeys.compute` at every sort key width, switched by the uniform alone.
- `WgpuSplatSorter` against `SortKeys.sort` of the read-back sort keys, with its indirect arguments (WebGPU). `sortSplatKeys` on a worker and inline. A view's `sort` against `SortKeys.sort` of a full projection's sort keys.
- Rendered images: one splat gives a centered, symmetric falloff for every method. A small, far splat gives its exact falloff. Two splats blend back to front, and blend the other way with a reversed order. GPU and CPU orders give the same image (WebGPU). `Hdr` tone mapping leaves a frame below the knee unchanged. A negative color draws as black into a half-float target, never NaN. An opaque mesh in front of a splat hides it and one behind does not, with and without `logarithmicDepthBuffer`. A renderer that drew nothing before its splats arrived draws them correctly. A two-eye `ArrayCamera` matches the mono render of each eye.
- `objectParams.sortGuard` drops the sort keys of splats beyond the widened view and behind the head, and drops none at 0.

Collections, renderers, and views (`sceneTests.ts`):

- `isUniformScale`: rotations times a uniform scale (and products of them) pass; shear, non-uniform scale, mirrors, and zero fail.
- An object's world transform (its `matrixWorld`: uniform, non-uniform, or mirrored) against the same splats pre-transformed by it on the CPU, for every method.
- The static uniforms: one program dispatched twice in a frame with two matrices gives the same result as each dispatch alone. Two `SplatRenderer`s in one render each draw their own splats.
- The program cache: one program per generator across frames and renderers. Two modifiers build 2 programs, then none. New data, a modifier space, or a moved frame build none. A disposed generator's programs are rebuilt. `SplatCollection.object` refuses data that does not match its generator's (`@ts-expect-error`).
- Form selection: a covariance-only generator is never diagonalized under ewa, and is diagonalized under 3dgut.
- Modifiers: the modifier that matches the form runs. A view-space depth modifier colors splats by depth. An identity modifier in each space projects like no modifier. A world height modifier colors objects by their world height.
- `SplatGenerator.fromSplats`: an index list or a TSL remap gives the same result as reading those splats directly. New index lists compile nothing. In a subset drawn through an index list (such as a LoD subset), `splat.index` stays the index of the source splat. Modifiers run in turn.
- Views: a view's collection, `objectParams`, `null` modifier, and `sortBits` project like a renderer with those settings; its unset settings follow the renderer; `viewFor` returns the same view for a key; a disposed view leaves its renderer. A render draws the renderer's settings, its camera's view, or the explicit `view`; in gpu mode a render makes no view. `viewKey`: renders from cameras made anew share the view of their key; by default each camera makes one (cpu mode).
- The CPU sort: nothing is drawn before an order arrives. `apply` skips older versions. A newer order shows its own collection while the renderer's collection has moved on. A later landed order supersedes an earlier one. A switch to gpu mode drops the orders and releases their objects, and `apply` refuses in gpu mode.
- Object release: an object is released once, when no renderer's live collection holds it. Kept objects and other renderers still hold their objects. A view's own collection holds its objects until the view is disposed. `dispose()` releases the renderer's objects. A release may set a renderer's collection. Shown and in-flight collections (and landed collections not yet applied) hold their objects.
- Sort workers: cpu renderers and their views share `SplatRenderer.sortPool` (4 workers), sorting in parallel. A gpu renderer refuses `sort()`. A renderer with `sortWorker` sorts there instead. Both pools outlive their renderers. Disposing the renderer during a sort rejects the sort, keeps no sort key arrays or views, and leaves the shared pool working. A disposed renderer left in the scene draws nothing, makes no textures, and throws nothing, `prepare` too, in gpu and cpu modes; its `sortKeys` and a disposed pool reject.
- `SplatRenderer` refuses a view that belongs to another renderer. A render that does not follow its `prepare` projects again (WebGPU).
- A camera in the other clip-space convention projects like one in the renderer's convention, and is left unchanged.
- `autoSort` re-sorts on a lens change when a `sortGuard` is set, and does not without one. `requestSort()` makes it sort again; a request made while a sort is in flight starts one more sort after it finishes. With `autoSort: false`, a view sorts only when asked. `onInvalidate` is called for a request, for an applied order, and once for every view on the renderer's `requestSort()`.

`snorm8` is skipped on WebGL2, where it cannot be read back. `npm run check:test` runs the page headless on both backends and prints the failures and totals (it needs `npm run build:test` and `npm run serve`).

## The docs check

`npm run docs` (`scripts/build-docs.mjs`) writes the HTML version of every page to `docs/ref/`, which is gitignored; `npm run build` runs it too. `npm run check:docs` (`--check`) writes the pages and fails when:

- a relative link or `#anchor` in any `.md` page or docs `.html` page does not resolve (anchors follow GitHub's heading ids);
- an export of a Radix `index.ts` appears on no `.md` page, in inline code or in a code block.

## Benchmarks

Performance is measured by benchmarks rather than by the checks: `npm run bench:core` (core benchmarks in Node, on files in `splats/` or given with `--file`) and `npm run bench -- --matrix <name>` (`/build/test/bench/index.html` in headless Chrome, on the hosted samples). A summary of the results is in [performance.md](performance.md). Radix is compared with SparkJS and PlayCanvas on the same scenes and camera paths in [bench.html](bench.html), the summary, and [bench-report.html](bench-report.html), every result.
