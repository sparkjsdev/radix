# @sparkjsdev/radix: array data and splats

Radix (the npm package `@sparkjsdev/radix`): tables of typed arrays, the same on
the CPU and the GPU, and 3D Gaussian splats stored in them, drawn by
three.js r186's `WebGPURenderer` on WebGPU or its WebGL2 backend. The repo:

- `src/`: the library. `src/index.ts` is `@sparkjsdev/radix` (everything, with
  three as a peer dependency) and `src/core/index.ts` is `@sparkjsdev/radix/core`
  (CPU only: no three, no DOM).
- `docs/`: the docs (Markdown, the generated `ref/`, and the HTML guide).
- `examples/`: the example pages and the SparkJS ports (TypeScript).
- `test/`: the GPU test page (`test/gpu/`) and the benchmark page
  (`test/bench/`).
- `scripts/`: builds, checks and benchmarks (`package.json` lists them).
- Built (gitignored): `dist/` (the package: `radix.module.js`,
  `radix-core.module.js`, `types/`), `build/examples/`, `build/test/`,
  `build/site/`, and the docs' reference pages in `docs/ref/`.

From a clean checkout: `npm install` (its `prepare` builds `dist/`),
`npm run build` (`dist/`, `build/examples/`, `build/test/` and `docs/ref/`;
`npm run build:watch` rebuilds the library, the examples and `docs/ref/`),
`npm run serve`, then open `http://localhost:8000/build/examples/index.html`
(the examples and Spark ports), `http://localhost:8000/docs/index.html` (the
docs) and `http://localhost:8000/build/test/gpu/index.html` (the GPU checks).
After `npm run build:site`, `http://localhost:8000/build/site/` is the landing
page that links to all of them. The README has the rest.

Docs live in `docs/`, in two forms:

- The Markdown reference, one page per topic, indexed by `docs/overview.md`
  (its "Pages" section, in groups, is also the reference sidebar):
  `quickstart`, `concepts`, `recipes`; `rendering`, `params`, `generators`,
  `views`, `sorting`, `lifetimes`, `xr`, `controls`; `arraydata`, `splats`,
  `encoding`, `files`, `rdx`, `workers`; `renderer`, `gpu-arrays`, `shaders`,
  `wgpu`; `projection`, `multi-splat` (why drawing many objects in one sort
  takes collections, per-viewpoint views, versioned orders and releases: keep
  it in step when that model changes), `performance`; `api` (every export, A
  to Z) and `checks`. Every page: what it is for, an example, the concepts,
  API tables with defaults, gotchas. Check facts against the code.
- The HTML site (`site.css` / `site.js`, classic scripts so `file://` works;
  each page sets `<body data-root data-page>`; `site.js` highlights every
  code sample, so pages write plain escaped code in `<pre>`): `index.html` (the front door
  and the layer map), `why.html` (against SparkJS 2.3.1;
  keep it honest, gaps included), `ideas.html`,
  `model.html` (how the classes fit together: chapters, a live class map;
  its class cards and code must match the exports), `data.html` and
  `pipeline.html` (in depth, with live codecs), and `multi-splat.html`.
  `bench.html` (the benchmarks summary, in the guide's row), `bench-report.html`
  (every result) and `img/bench-*.jpg` hold the benchmarks of Oct 9, 2026.
  `site.js` draws every page's top bar: Radix, then the sections Guide
  (these pages, a second row; `GUIDE`), Examples (`build/examples/`,
  whose two index pages load the bar with `data-section="examples"`) and
  Reference (`ref/`).
  Sections end in "See also" links into `ref/`. To browse it, run
  `npm run serve` and open `http://localhost:8000/docs/`
  (`file://` works in Chrome, but some editor previews do not follow links).

The docs call the module Radix (imports say `@sparkjsdev/radix`). Write them
in plain technical English: whole sentences, headings that say what a section
covers, no slogans, "X, not Y" contrasts, intensifiers, or empty callout
labels ("Summary:", "Result:").

`npm run docs` (`scripts/build-docs.mjs`, also run by
`build`) writes `docs/ref/*.html` from the Markdown (generated
and gitignored: do not edit `ref/`); `npm run check:docs` writes
them and fails on a broken relative link or anchor in any `.md` or `.html`
page, or an export on no `.md` page. Update the docs with the code, then run
the check.

## Checks

`npm run lint` (`npm run typecheck`, then ESLint, which also enforces the
layer imports below), `npm run check:core` (Node), `npm run check:docs`,
and with `npm run build` and `npm run serve` running: `npm run check:test`
(the GPU test page on both backends) and `npm run check:examples` (every
example page and Spark port on both backends; `-- --only splats,hello-world`
for some). `docs/checks.md` lists what each covers.

## Naming and exports

- The layer says CPU or TSL, and the class name says the layer. `core/`
  classes have no prefix and are plain JavaScript (`Splats`, `Encoding`,
  `SortKeys`, `SplatMath`, `SplatFiles`, `RdxFile`, `TextureLayout`). Their
  TSL twins live in `gpu/`, prefixed `Gpu`, with the same method names
  (`GpuSplats`, `GpuEncoding`, `GpuSortKeys`, `GpuSplatMath`). `Wgpu*` is
  WebGPU compute. `render/` classes are `Splat*`, their TSL helpers on the
  class that uses them (`SplatProjection`, `SplatCamera.viewIndex`, both
  internal). No cross-layer `tsl` namespace. `SplatGenerator`
  (`gpu/splatGenerator.ts`) is a type with a helper object of the same name:
  the template `SplatGenerator.fromSplats({ layout, remap, modifiers })`
  (readers only read; this wraps one) and `SplatGenerator.indices`;
  `SplatGenerator<Data>` types an object's data (`AnySplatGenerator` for any).
- Functions are static methods of the class they belong to (a static class
  is fine); the free functions are the one-call entry points: `createRenderer`,
  `getGpuCaps`, `defineBundle`, `loadSplats`, `writeSplats`, `sortSplatKeys`.
  Long bodies may stay module functions that a class exposes (`static
  readonly read = readPly`).
- Verbs in names where a noun would be unclear (`SortKeys.compute`,
  `Splats.layoutOf`, `Splats.findLodTree`, `SplatFiles.detectFormat`).
- Fixed-size codecs name the total bits of their code (`encodeOct24`,
  `encodeQuatOct32`, `encodeQuatOct24`); quaternion codecs say `Oct`.
- Each layer's `index.ts` lists its exports by name: only what an app would
  use. Helpers other layers need stay exported from their files but out of
  the index (`backend.ts`, `gpuFormats.ts`, `textureIo.ts`, writer internals,
  `requireWebGPU`, `workerTarget`, the projection helpers in
  `projection.tsl.ts`, and in `render/` everything but `SplatCollection`,
  `SplatRenderer`, `SplatView` and `SplatProjector.programs` / `dispose`:
  `SplatCamera`, `SplatParams`, `SplatProjection`, `projectCollection`,
  `programOf`, `readSortKeys`, the transforms; the `@internal` members of
  `SplatRenderer` and `SplatView` are for each other); tests deep-import
  them.
- GPU objects Radix creates are labeled `radix` and camelCase parts
  joined by `_` (`radix_sortKeysB`, `radix_sortHistogram_0`), written out
  where each object is made, as three writes its own, so a label from a
  WebGPU error can be searched for. Labels an app passes are used as given.
  The name is the whole label of a buffer, texture or encoder, and sits
  inside the pipeline and shader labels three builds around a material or
  kernel name (`renderPipeline_radix_splatDraw_18`).
- Types rule out error states: `GpuArrays<S, Storage>` (compute writers and
  stores take `GpuArrays<S, true>`; `hasStorage()` narrows), `SplatNode` /
  `CovSplatNode` / `PbrNode` (struct nodes with typed `get()`),
  `SplatProjection<F>` (the splat form it reads), `SplatObject<Data>` (data
  checked against the generator's with `SplatCollection.object`), bundle-typed
  splat access, `ProgressStage`.

## Layers

- `core/` (`@sparkjsdev/radix/core`): no three.js, no DOM, so it runs in the
  browser, in workers and in Node (typechecked by `tsconfig.core.json`,
  checked by `npm run check:core`). `ArrayFormats`, `TextureLayout`,
  `defineBundle`, `ArrayData` (with `transferables`, and `INDICES`: the one
  index-list bundle, for draw orders and subsets), `Compression`,
  progress, `RdxFile`, the CPU splat codecs and access (`Splats`,
  `Encoding`, `SplatMath`), spherical harmonics (`sh.ts`: `Sh`, the codecs
  a fixed set by name, ext / packed, `ShPalette`),
  `PlyFile` (also reads SuperSplat compressed PLY) / `CompressedPlyFile`
  (writes it: `"compressed-ply"`, Morton-sorted unless `sort: false`) /
  `SpzFile` (reads gzip v1-v4 and SPZ 4's NGSP / zstd container, from bytes
  or a stream; `unpack` returns the raw columns; writes v2, v3 (default) or
  4; LoD tree and PBR go in the gzip trailer or in SPZ 4's "RX" records;
  reads upstream's safe-orbit and coordinate-system records) / `Axes`
  (`axes.ts`: the 16 SPZ coordinate systems; converts splats, tables and SH;
  readers convert with `coordinateSystem`) / `Zstd` (`zstd.ts`: decodes with
  Node's zlib or fzstd; encodes with Node's zlib or its own literals-only
  encoder) / `RadFile`, `SplatFiles` (`core/files.ts`: format detection,
  decode, encode, fetch). Every reader loads SH (`sh`: `"ext"` by default;
  `false` skips it and records `meta.ignoredShDegree`; RDX keeps its stored
  codec unless asked; RAD's clustered SH becomes an `ShPalette` plus
  `shLabel`). Every writer writes SH (`sh: true`); given `shPalette`, RAD
  writes clustered SH and the others expand it.
- `gpu/`: three.js r186 `WebGPURenderer` on its WebGPU backend or WebGL2
  fallback, TSL only. `createRenderer` (survey baselines; options from the
  call, else the URL, else defaults), `Hdr`, `GpuProfiler`, `GpuArrays`
  (one array texture per channel), `GpuArrayReader`, `GpuArrayWriter`
  (fragment-pass writes), the splat readers (`GpuSplatReader`,
  `splatAccess.ts`), the TSL codecs (`GpuSplats`, `GpuEncoding`,
  `GpuSplatMath`) and SH (`sh.tsl.ts`: `GpuSh`, the basis and the codecs'
  decoders; `GpuShReader`, which `fromSplats` and any generator hold;
  `GpuShPalette`). `splatGenerator.ts` also defines the generator context
  (`generatorContext`, `modifierContext`: uniforms `render/` sets per
  object). `GpuArrays.write` / `writeBatch` take any `ArrayWriter`;
  `storage: true` (WebGPU) makes storable channels writable from compute.
  Sort keys in TSL (`GpuSortKeys`, the twin of `SortKeys`; here because
  `wgpu/` reads them too).
- `wgpu/`: WebGPU backend only (throws on WebGL2), on `gpu/` and `core/`.
  WebGPU-only code lives here and is named `Wgpu*`. `WgpuCompute` (with the
  workgroup scan helpers as statics) / `WgpuComputeBatch` (kernels),
  `WgpuBuffer` (storage buffers), `WgpuArrayStore` (scatter stores into
  storage arrays), `WgpuArrayWriter` (the compute twin of `GpuArrayWriter`:
  same arguments, same texels and indices, one dispatch per range),
  `WgpuRadixSort` and `WgpuCompact` (general building blocks) and
  `WgpuSplatSorter` (both, for splats).
- `worker/`: `WorkerPool` (workers made on first use, none by default) over
  `coreWorker.ts`'s handlers, in `coreModule.ts` (`core/` plus `serveWorker`)
  inlined into the bundle as a string (`?module&inline`, minified in the
  library build): `WorkerPool.coreUrl` is its blob URL, which each pool
  worker's one-line shim and an app's own workers import; and
  `loadSplats` / `writeSplats` / `sortSplatKeys` with the `worker` option
  (`loadSplats` takes `request` fetch options and a `signal`, which cancels
  the call on its worker). Imports `core/` only.
- `render/`: splat projection and drawing, on `core/`, `gpu/`, `wgpu/` and
  `worker/` (the CPU sort). Nothing imports it. Public: `SplatCollection`
  (immutable objects in order: generator, data and count locked on the
  object, live matrixWorld, params and release), `SplatRenderer` (the draw mesh
  and the settings every viewpoint shares: collection, method, params, modifier
  in a space, sort; its views; object releases; its own projected arrays
  and sorter; CPU sorts on the static `SplatRenderer.sortPool`, shared by
  every renderer and view, `SplatRenderer.sortWorkers` (4) workers), `SplatView` (one viewpoint of a renderer, by
  key: settings over the renderer's and the CPU sort's versioned orders,
  autoSort) and `SplatProjector` (the program cache's `programs` and
  `dispose`). Internal, TSL for both backends: the camera as static
  uniforms (`SplatCamera`, `splatCamera.ts`, `viewIndex.ts`), the params
  (`SplatParams`: plain values on renderers, views and objects, static
  uniform `nodes`), the per-object transforms and transforms of either
  splat form (`splatTransform.tsl.ts`), the four methods
  (`projection.tsl.ts` shared, `projections.tsl.ts`) behind
  `SplatProjection` (one object per method: words, outputs,
  `project(splatNode, eyes)`, `write(splat, eyes)`, `writeKeys`, the draw's
  decoding), the dispatch (`projectCollection` in `SplatProjector.ts`, given
  resolved `ProjectSettings`) and the draw material (`splatDraw.ts`).
- `controls/`: `CameraControls` (`docs/controls.md`), orbit and fly camera
  controls for pointer, touch, keys, gamepad and WebXR controllers, after
  Spark's SparkControls, plus a double-press slide.
  One state for both modes (the pose plus `distance`), so switching never
  moves the view; it stores nothing (saving settings is the app's job).
  Imports three only; nothing imports it.
- `index.ts` (`@sparkjsdev/radix`) re-exports all six. `core/` imports no other
  layer; `gpu/` and `worker/` do not import each other, and neither imports
  `wgpu/` or `render/`; `render/` imports all but `controls/`.
- Pages: the GPU test page `test/gpu/` (bundled with three and the
  library's sources by `scripts/build-test.mjs` into
  `build/test/gpu/index.html`, since the tests deep-import internals;
  `?gpu=webgpu | webgpu-gl`, `?run=0`; `npm run check:test` runs both
  headless; `sceneTests.ts` checks collections, renderers and views, modifiers,
  the program cache, CPU orders, release, requestSort and onInvalidate;
  `controlsTests.ts` drives `CameraControls` with synthetic events), the
  usage examples `examples/scenes/` (`/build/examples/scenes/index.html?scene=multi
  | views | modifiers | subset | offline`: several placed objects and a
  generator in one sort, one renderer from two cameras (the second
  camera's view with its own collection and modifier), modifiers in each space
  with thumbnails through views of the app's keys, remapped LoD-style
  subsets with a pool, an offline still; the bar switches the sort live and
  the backend by a reload), the viewer `examples/splats/` (`/build/examples/splats/index.html`: one
  file at a time from Open, a drop, a URL or the samples in its `catalog.ts`;
  a quick bar (`quickBar.ts`) and a Tweakpane panel (`gui.ts`: monitors,
  renderer and quality params, depth of field, transform and gizmo, HDR,
  controls, export, presets); the WebGL2 fallback's worker sort re-sorts
  when the camera moves or turns in the splats' frame; it copies what it
  needs from other pages rather than importing them; query parameters in
  its `main.ts` header), the benchmark page `test/bench/` (`/build/test/bench/index.html`,
  bundled the same way, driven by `npm run bench` over the hosted samples) and the WebXR page
  `examples/xr/` (`/build/examples/xr/index.html`: WebGPU XR with the GPU sort, or
  the WebGL2 backend's XR with the worker sort through one view of the
  page's key for every camera it renders; switched in place by
  `radixXr.configure` or `scripts/dev-link.mjs` (`?link=1` or
  `?link=<url>`), so an emulator-paired tab never reloads).
  `npm run convert:ply` streams PLY files past 2 GiB into RDX.
- `examples/`: TypeScript sources of static pages on the
  `dist/radix.module.js` bundle. `npm run build`
  (`npm run build:watch` too) builds the bundle and runs
  `scripts/build-examples.mjs`, which strips each `.ts` file's types
  (Node's `module.stripTypeScriptTypes`: lines and columns stay put, no
  source maps) and copies everything else into `build/examples/`
  (HTML with page-relative import maps; links name `index.html`, never a
  folder, since a bucket serves no folder index), served by `npm run serve` at
  `http://localhost:8000/build/examples/` (`index.html` lists the
  pages, each with a WebGL2 link). `tsconfig.examples.json` checks
  them (part of `npm run lint`) with `erasableSyntaxOnly`: no enums,
  namespaces or constructor parameter properties. Relative imports name the
  built file (`./objects.js` for `objects.ts`; the build rejects others).
  `three` types are three's WebGL build: WebGPU-only classes come from
  `three/webgpu`; TSL comes from @sparkjsdev/radix's loosened `TSL`.
  The viewers' samples
  are single-file RDX files of ext splats without SH on Google Cloud Storage,
  `https://storage.googleapis.com/forge-dev-public/asundqui/radix/261009/rdx/`
  (`butterfly-ai`, `ceramic`, `sutro-2m`, `grace-interior-10m`, `bicycle`
  `.rdx`; `?splats=` reads the same names elsewhere). The splats
  viewer shows SH3 versions instead (`extSh`: `sutro-2m`, `grace-interior-10m`,
  `bicycle`, `garden`) in `261015/rdx-sh/` (`?splatsSh=` reads them
  elsewhere). The fx editor and the MPM water offer
  the butterfly, the ceramic and the SH3 Sutro.
- `examples/spz/` (`radixSpz`: `open`, `openSample`, `write(version)`,
  `data()`, `written()`): the SPZ reader / writer. Samples (`catalog.ts`)
  are CC0 files from SharedTestModels in every version: v2 backpack, v3
  scarf (SH4), and SPZ 4 seashell, backpack and sparkling water (SH4). They
  are hosted in `spz/` (dated 261015; the v3 scarf and SPZ 4 sparkling
  water were written by the reference implementation); `?spz=` reads them
  elsewhere. A panel shows what the
  reader found (container, version, SH degree, records). Buttons write the
  splats as v2, v3 or SPZ 4 on a worker and download them; "open it" reads
  the file back. Files with a coordinate-system record other than RUB are
  converted to RUB (`Axes.convert`). All samples are y-up, so there is no
  flip (`?flip=1` for y-down files).
- Hosted data: dated GCS folders (`scripts/data.mjs`) hold every example's
  data in a subfolder (`rdx/`,
  `rdx-sh/`, `spz/`, `sogs/`). Files in a
  dated folder are never replaced, so the pages' addresses (the catalogs)
  stay valid. `npm run check:examples` loads them with the Spark
  ports.
- `examples/spark/`: static ports of the SparkJS 2.3.1 examples, a test of
  what Radix can do unchanged (TypeScript built as above, on the
  `dist/radix.module.js` bundle; the index
  page and `js/examples.ts` record each example's status and Radix's gaps:
  LoD selection and building, paged RAD, SOG, per-object opacity / tint,
  raycasts; SH comes from Radix, `js/files.ts`). They import only the bundle and three, never
  the library's sources; `npm run check:examples` loads every page
  on both backends.
- Larger demos, each self-contained in its folder (it copies what it needs):
  - `examples/mpm/` (`radixMpm`: `ready`, `stats()`, `benchmark()`,
    `?timing=1`): MLS-MPM water, WebGPU only (a notice on
    WebGL2). `MpmSim.ts` holds the TSL compute kernels, `ParticleSort.ts` the
    Morton re-sort (`WgpuRadixSort`). `waterSplats` is a plain
    `SplatGenerator` over the particle `WgpuBuffer`s, in one collection with a
    GCS sample scan (`?scene=ceramic | <sample> | <url> | none`; a LoD tree's
    leaves only) placed by a `TransformControls` holder; `SplatCollider.ts`
    bakes the scan (`GpuExtSplatReader`) into a distance field in its object
    space that the kernels sample through that transform.
  - `examples/fxedit/` (`radixFxedit`: `ready`, `selfTest()`, which must
    pass on both backends): a node editor for effect graphs. In `fx/`,
    `buildGraphModifier(graph)` gives a
    `SplatModifier` cached by `graphKey`, each unlinked input reading its own
    uniform and `FxInputs` holding time, the click and the camera, so value
    edits compile nothing. On WebGPU the graph is the renderer's modifier (in
    `"world"` or the live object matrix); on WebGL2 it runs inside the scan's
    `fromSplats` generator in the same frames (`framed.ts`), since a renderer
    modifier costs about 6x there (`?apply=` picks either, `?sort=cpu` the
    worker sort on WebGPU). ELK loads as a classic script from
    `node_modules/elkjs/lib/` (the site copies it).
- `examples/fractals/` (`radixFractals`: `ready`, `show(name)`, `bake()`,
  `settled()`, `progress()`, `baked()`, `samples()`; both backends): 3D
  fractals as splats. A kind's `GpuArrayWriter` bakes samples of
  `sample.ts`'s bundle (position with a 4th coordinate, normal or tangent
  and shape, orbit traps, occlusion, shadow, motion, size, alpha), a chunk
  per frame sized from the frame time, into the next fractal's table.
  Bakes are kept, a table each (`Bake`: a key of everything that decides
  the samples but the seed, the writer's inputs, set again before every
  chunk, the rows done and the table's last order), up to a share of GPU
  memory (`?cache=` tables): a request reuses a bake of the same key or
  parks the one under way (resumed when asked for again), new samples (R)
  always bake anew, and a queue of surprises (up to 4, by the tables free)
  bakes ahead, in chunks that back off after any slow frame (transitions
  included), each in turn so light fractals land first; the first ready one
  and the shown table are sorted into its transition's order in advance, so
  "Surprise me" starts at once, or makes a quick new look or angle when
  none is ready (a press during a transition plays after it). On phones
  (`?stash=1` anywhere) the queue lives in CPU memory: one bake at a time,
  each read back and its table freed but the next surprise's, uploaded
  again when needed, so the gallery keeps 3 tables on the GPU (`cpu()`
  counts the copies). `cache()` lists them;
  `morph.ts`'s `TableSorter` quantizes both tables' positions on the GPU,
  reads the codes back and orders them on a module worker (`sortWorker.ts`:
  Hilbert, layers, radial, spiral or random keys, visible first); the
  transition generator pairs slot j with the same fraction of each visible
  order and moves each pair along a style's Bezier on its own clock, then
  the next table is the shown one. Kind, sampling and 4D turn apply when the transition
  starts, not when its bake does. Requests during a transition wait for it
  (merged into one). A look-only request (no bake) blends the two palette
  slots in the steady generator (`paletteMix`). "Surprise me" picks a new
  preset or a remixed look, often a new angle, then a `shots.ts` camera
  shot (incremental moves, stopped by any input). Every kind's writer is
  compiled during the first bake (a 4-sample write into a scratch table).
  `shade.ts`'s `shadeSample` lights a sample from uniforms for a side
  (steady, or a transition's from / to: each its own palette and turn),
  `motion.ts` eases the objects' `matrixWorld` (or moves the camera) once idle,
  so the camera uniform goes through its inverse; views baked from the
  camera are baked for the fractal at rest and only look around (any move
  of the eye would show unbaked surfaces);
  the page renders through three's `RenderPipeline` (bloom, tone mapping;
  it sets `outputColorSpace` back to sRGB, since the splats draw into its
  linear target). Surfaces (`surfaces.ts`) sphere-trace a distance
  estimator per sample from all around the set or from the camera,
  stopping within half a sample spacing; the DE is a `Fn` with
  `setLayout`, so its loop is one function. In TSL, an `If` body must not
  return its assignment (`() => { z.assign(...); }`): a returned node
  becomes the function's return value; and an index read from a packed
  `GpuArrayReader` needs `float(uint(i))`, since `float(i)` alone may emit
  no conversion.
- `examples/fractals/demo/`: the gallery's demo mode (the page opens on its
  menu unless `?demo=0`, `?ui=0` or `?tour=1`; D later; `?demo=aurora |
  tidal | lumen` prepares one, `?sound=0`; "explore the fractals" leaves): minute-long music
  videos of its fractals on the gallery's own canvas, renderer, kinds and
  bake uniforms (the gallery pauses and frees its cache meanwhile). A
  `Tune` (`tune.ts`, three in `tunes/`) is a tempo, a cue list on its bars,
  lines of type, a mix and a `compose` onto an `AirScore` (`airScore.ts`: a
  film `Score` with glass FM bells, kalimba, airy pads, a choir, vocal
  chops, breath, soft drums), whose instruments leave marks (kicks, hits,
  chords, impacts, risers). `library.ts` keeps the tune's presets in a pool
  of tables sized to the device's memory (`../device.ts`), baked just in
  time in the order the cues need them (with the teaser videos' fixed
  seeds; a table is freed from the preset needed furthest ahead and never
  from one drawn), their orders sorted by `TableSorter` on a pool of up to
  4 workers; `fits` says whether the rest bakes during playback before each
  cue. Phones keep GPU memory tight: a pool of 3 tables, the whole demo
  baked before the start (the rest into a spare table and read back into
  uncapped CPU memory), a freed table read back when its preset comes again,
  and a CPU copy uploaded just before its cue. `video.ts` draws film time t (morph from the last fractal in a
  `morph.ts` style, look, palettes, sky, light, 4D turn and camera blended,
  the marks in bloom, rim light, glow, palette and flashes) plus the
  viewer's turn and zoom, backing off on tall screens. `demo.ts` holds the
  menu, preparation (start once ready, buffering if a device falls behind,
  `stalls` lists why), the music and its clock (`music.ts`: by default the
  tune's mix as an AAC file, decoded whole;
  or live on the GPU through `film/audioStream.ts`, `?music=gpu`; a wall
  clock when silent), the steering (drag, pinch, wheel; drifts back after
  2.5 s; a tap pauses), the controls shown while paused, a volume slider
  and mute on the right while playing (beating with the kick; M, arrows), and
  `?render=1&demo=<tune>`, a film for a frame-by-frame recorder
  (900k samples unless `?splats=`). `examples/film/` holds only the score
  synthesizer this uses (`score.ts`, `gpuAudio.ts`: `WgpuCompute` kernels;
  `audioStream.ts` and `scoreSink.ts`: an `AudioWorklet` fed ahead of
  playback; `timeline.ts`, `text.ts`), not a page.
- Static site: `npm run build:site` (`scripts/build-site.mjs`)
  builds `build/site/` (gitignored), one folder to preview
  (`npm run serve:site`, :8002) and copy to any static host: the bundle and
  built examples, the docs, the `node_modules/` files the import maps load,
  and a landing `index.html` (the GitHub repo, getting started, links). The
  sources stay on GitHub: the docs' links to repo files and the Spark list's
  "Radix source" name the commit the site is built from, and the top bar's
  Radix logo goes to the landing page, in the site's copies only. Repo paths
  are kept, so relative links work under any prefix; the build fails on a
  broken link or import-map address.
  `npm run check:examples -- --base http://localhost:8002`
  checks the site's pages. `npm run build:single` (`scripts/build-single.mjs`,
  run by the site build) writes each example page but the Spark ports
  as one HTML file, `build/examples/<name>/<name>.html` (linked as
  "one file" from the examples index when it exists): esbuild bundles
  `main.ts` through the page's import map, and `new URL("./x.js" | "./x.css",
  import.meta.url)`, `import.meta.resolve(...)`, `<link rel="stylesheet">` and
  `<script src>` are inlined as blob URLs (ELK's worker as
  `window.ELK_WORKER_URL`, read by `fxedit/layout.ts`). The files need http(s):
  Chrome starts no module workers from a page opened from disk.
  `npm run check:examples -- --single` checks them.

## Rendering

- The model: generators (programs, built once; their data bound per
  dispatch) placed as splat objects (`SplatObject`: generator, data,
  count, world transform `matrixWorld`) in an immutable `SplatCollection`; a
  `SplatRenderer` in the scene with the settings every viewpoint shares
  (collection, method, sort key bits, `params` shared with the draw,
  `objectParams` per object, a modifier in a space, `sortMode`, `autoSort`,
  `onInvalidate`); `SplatView`s made by `viewFor(key)` (a camera or any
  value) set some of them over the renderer's (not `method` or
  `sortMode`; a null modifier drops the renderer's) and hold the CPU
  orders. A render draws `splatRenderer.view` when set, else the view of
  `viewKey(camera)` (default the camera), else the renderer's own
  settings; in cpu mode it makes a view per view key (each viewpoint needs
  its own order) and warns past 32, since an app making cameras anew needs
  `viewKey` or `view`. A WebGPU-only app needs no views. Generators get
  `context` (`generateSplat(i, context)`, `bind(data, context)`: the view
  origin, forward, object-to-head and object-to-world in the object's
  space; modifiers the same in their space, the modifier context set only
  when a modifier runs), set by
  `setTransforms` before each object's dispatch; wrappers pass it on (it
  defaults to `SplatGenerator.context`). `SplatGenerator.forArrays` /
  `SplatCollection.arrays` pick the generator for given arrays, their SH
  included; `objectParams.maxShDegree` caps the drawn bands without compiling. Each render `onBeforeRender` (or `prepare(camera)`,
  before it, outside its passes; used only by the render that directly
  follows it) sets `SplatCamera`, projects every object (one dispatch each,
  its uniforms set first) and orders: `WgpuSplatSorter` in sortMode "gpu"
  (WebGPU's default), else ("cpu": WebGL2, or chosen on WebGPU) the view's
  applied CPU order, drawing the collection it was sorted for. Views belong to one renderer; it refuses another's.
- Uniforms are static and shared by every program and draw (`SplatCamera`,
  `SplatParams.nodes`, the key uniforms in `SplatProjection.ts`): three
  gives each compute node and render object its own buffer, written when it
  dispatches or is encoded, and submits each dispatch at once. A frame's
  draws run after its compute, so renderers drawn in one render each keep
  their own projected splats and sorter.
- The program cache (`SplatProjector`) keys on generator, modifier, cov
  modifier, method, eye count, pass and backend. Matrices, the modifier
  space, data and params are uniforms or bindings: changing them compiles
  nothing. GC does not free GPU pipelines: `SplatProjector.dispose(generator)`
  does, called by the app once a generator's objects are released.
- The CPU sort's policy is the view's: `sort(camera)` (keys on the GPU, a
  readback, a worker sort on `SplatRenderer.sortPool` or the renderer's
  `sortWorker`; never this thread),
  `apply(order)` (cpu mode only; an order can be applied until one of a
  later sort lands or is applied, so at most one landed order waits),
  `autoSort` (default on) for the loop, re-sorting on moves, matrix and
  collection changes, with a `sortGuard` on turns and lens changes, and on
  `requestSort()` (changes it can't see, such as a generator's uniforms;
  also with autoSort off; a request during a sort runs after it;
  `splatRenderer.requestSort()` asks every view). Switching to gpu drops
  the orders. `onInvalidate(view?)` is called when something Radix did
  or was asked to do needs a render (an autoSort order applied, a
  request): on-demand rendering, never for the app's own changes.
  Live collections (the renderer's, its views'; in cpu mode also the shown
  orders' and those of sorts in flight or waiting) hold their objects: an
  object's `release` (app-defined; Radix frees nothing and never looks
  inside `data`) runs once no renderer's live collection holds that object.
  Renderers must be disposed (their views go too; a sort in flight then
  rejects); one garbage-collected undisposed is warned about
  (`FinalizationRegistry`) and its objects released. `view.dispose()`
  takes one view off its renderer. Every object gives its `count`.
- Splats reach the projection in head space: generate, transform (`a`;
  `a`, modifier, `b` with a modifier), project. Forms are picked once per
  program (`build` in `SplatProjector.ts`): each step gets the form it takes
  without converting where the generator allows; non-uniform matrices go
  through the covariance (a uniform flag, so no recompiles); methods take a
  splat struct node of their input form (`SplatProjection.input`: ewa
  `"cov"`, the others `"splat"`) and never fetch.
- One material per renderer, rebuilt in one place when the method, the eye
  count or the order source changes. It is built against real projected
  arrays from the start (the constructor makes empty ones): a draw compiled
  while its projected reader held the placeholder keeps reading it, and the
  ray methods then draw garbage (`renderTests.ts` checks a renderer that
  drew nothing first).
- `SplatCamera.set` never changes the app's cameras: an eye whose
  projection is in the other clip convention is converted (z' = (z + w) / 2
  to WebGPU's, the inverse to WebGL's).
- Projected words: head words, then each eye's, in `uint32x4` channels (a
  `uint32x2` last one for 1 or 2 words); keys in bundle `sortKeys` as RGBA8
  bytes. Changing a layout means changing the method's `project`, `look` and
  `vertex` together, and `docs/projection.md`.
- TSL `select` with a vector condition does not select per component: select
  each component.
- The draw: one call, instances of 1024 quads (`quadIndices`,
  `WgpuSplatSorter.QUADS_PER_INSTANCE`); varyings are `varyingProperty`s
  written in the vertex stage (each method lists the ones its density reads
  in `ProjectionDef.varyings`), so the fragment stage never re-runs vertex
  code. `vertexStage(struct.get(...))` on a struct var pulls the var's code
  into the fragment stage.

## Performance

Measured on an Apple M3 Max: the draw is
60-85% of a WebGPU frame; inside scenes the ray methods (3dgut, htgs) cost
4-25x ewa (splats around the camera cover the screen). Rerun the
`npm run bench` matrices before and after a change that could move a frame (`--compare` checks
the images), with the GPU otherwise idle. Core benchmarks run from an
esbuild bundle (`npm run bench:core`), never `tsx`: its `keepNames`
wraps every closure and skews hot loops. Hot loops in decoders reuse one
record (no object or array literals per splat) and avoid `Math.hypot`.

## Data model

- `ArrayData` is a table: elements are rows, channels are typed-array columns,
  and a bundle (`defineBundle(channels, { packing, serialize })`) is a named set
  of channels that belong together. All bundles share one `count` (valid rows)
  and `capacity` (allocated rows, a multiple of 4096).
- Formats: `scalar` or `scalar x n` (`"uint32x4"`); 1, 2 or 4 components can go
  on the GPU. Type rule (CPU array / TSL): `uint*` `Uint*Array` / `uint`,
  `uvec*`; `sint*` `Int*Array` / `int`, `ivec*`; `unorm8` / `snorm8` bytes read
  as normalized floats; `float16` `Uint16Array` half bits / `float`; `float32`
  `Float32Array` / `float`, `vec*`.
- `packing` (1, 2 or 4 elements per texel) only changes the GPU layout.
  `serialize: false` bundles are skipped by RDX.
- No `kind` tags: channel names say what the bits are (`extA` / `extB`,
  `covA` / `covB`, `packed`; SH `extShA..F`, `packedShA..E`: a letter per
  texel); `Splats.get` / `Splats.find` / `Sh.find` and the guards check
  names and formats.
- Spherical harmonics (bands 1-4; DC is the base color) live in an SH
  bundle beside the splat bundle, sharing its rows (`extSh` by default,
  `packedSh`), or as a palette: `shLabel` (uint16) in the splat table and
  an `ShPalette` table of entries `stride` texels apart (a power of two by
  default), bound as `StoredSplats.shPalette`. A codec writes an entry's
  bands in order, so a lower degree reads a prefix. Codecs have no per-file
  values: other encodings (SOG's codebooks) decode into ext.
  Coefficient arrays of `Sh.VALUES` (72) fit any degree. PLY, SPZ and RDX
  keep degree 4; compressed PLY and RAD write the first 3 bands.
  `docs/sh.md` has the layouts and measured errors.
- Splat layouts are named `extSplats`, `covSplats`, `packedSplats`, and a
  layout's name is its standard bundle name. Loaders take `{ layout,
  encoding }` (default extSplats); `loadSplats` returns the `SplatData<L>` (a
  palette expanded per splat), `loadSplatFile` and every format reader
  `{ splats, shPalette? }` (`LoadedSplats`); readers decode
  straight into the layout. Layout-agnostic code uses `Splats.get(data)` and
  `GpuSplatReader.from(arrays)`. Loops over every splat pick the codec (and
  its arrays and constants) once with `Splats.encoder` / `Splats.decoder`,
  not a per-splat branch.
- Splat access: CPU methods take the bundle first and are typed by it
  (`Splats.load` / `store` / `loadCenter` for every layout, `loadPbr` /
  `storePbr` for ext only); `Splats.encode*` / `decode*` stay as the
  per-layout direct layer. GPU readers are one class per layout with the
  same method names, every one with both `loadSplat` and `loadCovSplat`.
  CPU and TSL codecs share bit layouts: TSL uses the built-ins where they
  exist (`packHalf2x16` / `unpackHalf2x16` for halves, `sin` / `cos`),
  floor(x + 0.5) for `Math.round`, and plain math for unorm bytes; f32
  rounding may leave a code one step off the CPU's, which the GPU checks
  allow within each encoder's budget.
- Count rules: a full upload sets `count = data.count`, a range write or
  `arrays.write` (either writer kind) `count = max(count, end)`; kernels
  using `WgpuArrayStore` set `count` themselves. `setCapacity` keeps
  contents on the CPU and discards them on the GPU. After `swap`, rebind
  readers and stores.
- Storage textures: three declares their WGSL format from texture format /
  type, not `internalFormat`, so only 32-bit texels and `rgba8unorm`,
  `rgba8snorm`, `rgba16float` are storable (`gpuFormatInfo().storable`).

## Texture layout

Width 1024, power-of-two height up to 4096 (the largest at or below rows / 2),
at least 2 and at most 512 layers: texel `t` is at `x = t & 1023`,
`y = (t >> 10) & (height - 1)`, `layer = t >> (10 + yBits)`. At most 2^31
texels. `GpuArrays.capacity` includes the layout's padding. `TextureLayout`
does the math.

## Code style

Simple and direct, short files with one purpose, a blank line between
stanzas (groups of related lines), few comments (constraints the code cannot
show), plain types (generics only to type `data.bundles.x.channels.y.data`,
storage arrays and splat forms).
