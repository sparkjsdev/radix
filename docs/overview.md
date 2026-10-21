# Overview

Radix draws 3D Gaussian splats with three.js's `WebGPURenderer`, on WebGPU or on its WebGL2 fallback, from one set of TSL shaders. It keeps data in tables of typed arrays (`ArrayData`) that have the same layout on the CPU, in workers, in files, and on the GPU (`GpuArrays`), so a splat takes the same 32 bytes in each of them.

Import it as `@sparkjsdev/radix` (everything) or as `@sparkjsdev/radix/core` (only the CPU code, which doesn't use three.js and so runs in workers and in Node). The code is in `src/`; it imports no other `src/` folder.

## A first page

```ts
import * as THREE from "three";
import {
  CameraControls,
  GpuArrays,
  SplatCollection,
  SplatRenderer,
  createRenderer,
  loadSplats,
} from "@sparkjsdev/radix";

// WebGPU, or WebGL2 where WebGPU is missing
const renderer = await createRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 0, 3);
const controls = new CameraControls({
  canvas: renderer.domElement,
  object: camera,
  settings: { mode: "orbit" },
});

// Fetch and decode the file on a worker, then upload it to textures
const data = await loadSplats("scene.spz");
const splats = GpuArrays.fromData(renderer, data);

// A collection of one object, drawn by a SplatRenderer in the scene
const collection = new SplatCollection([SplatCollection.arrays(splats)]);
const splatRenderer = new SplatRenderer({ renderer, collection });
scene.add(splatRenderer);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

Each render projects every splat for the camera, sorts all of them back to front, and draws them in one draw call. With WebGPU the sort runs on the GPU in the same frame. With WebGL2 it runs on a worker and arrives a few frames later. [quickstart.md](quickstart.md) explains each line.

## The layers

Each layer imports only the layers above it in this table:

| Layer | Import | Runs on | Contents |
|---|---|---|---|
| `core/` | `@sparkjsdev/radix/core` | no three.js: the browser, workers, and Node | tables, bundles, formats; splat layouts and codecs; spherical harmonics codecs and palettes; sort keys; PLY (standard and compressed), SPZ (gzip and SPZ 4), RAD, and RDX files; coordinate systems |
| `gpu/` | `@sparkjsdev/radix` | three.js `WebGPURenderer` on WebGPU or WebGL2, TSL shaders only | `createRenderer`; tables in textures; readers and writers; splat and SH codecs in TSL; generators |
| `wgpu/` | `@sparkjsdev/radix` | WebGPU only (`Wgpu*`), on top of `gpu/` | compute kernels and buffers; compute writers; radix sort, compaction, `WgpuSplatSorter` |
| `worker/` | `@sparkjsdev/radix` | a pool of workers over `core/`, made on first use | `loadSplats`, `writeSplats`, `sortSplatKeys`, `WorkerPool` |
| `render/` | `@sparkjsdev/radix` | all of the above together; nothing imports it | `SplatCollection`, `SplatRenderer`, `SplatView`; the projection and the draw |
| `controls/` | `@sparkjsdev/radix` | three.js only; nothing imports it | `CameraControls`: orbit and fly |

Anything named `Wgpu*` needs WebGPU. Everything else also runs on WebGL2.

## Where to start

| To... | Read |
|---|---|
| draw a splat file | [quickstart.md](quickstart.md), [rendering.md](rendering.md), [params.md](params.md) |
| look up a term | [concepts.md](concepts.md) |
| draw several objects, move them, or generate splats in a shader | [rendering.md](rendering.md), [generators.md](generators.md), [recipes.md](recipes.md) |
| draw from several cameras, or support WebGL2 | [views.md](views.md), [sorting.md](sorting.md), [lifetimes.md](lifetimes.md) |
| render in VR | [xr.md](xr.md) |
| write an effect for every splat | [generators.md](generators.md#modifiers), [shaders.md](shaders.md) |
| load, save, or convert files | [files.md](files.md), [rdx.md](rdx.md), [workers.md](workers.md) |
| draw view-dependent color (spherical harmonics) | [sh.md](sh.md) |
| keep data of your own on the GPU, or run compute | [arraydata.md](arraydata.md), [gpu-arrays.md](gpu-arrays.md), [wgpu.md](wgpu.md) |
| understand why it works this way | [multi-splat.md](multi-splat.md), [projection.md](projection.md) |
| make it faster | [performance.md](performance.md) |
| compare it with SparkJS | [why.html](why.html), [bench.html](bench.html) |
| find any export | [api.md](api.md) |

## Naming

- `core/` classes are plain JavaScript and have no prefix (`Splats`, `Encoding`, `SortKeys`). Their shader versions are in `gpu/`, start with `Gpu`, and have the same method names and bit layouts (`GpuSplats`, `GpuEncoding`, `GpuSortKeys`). `Wgpu*` classes need WebGPU. `render/` classes start with `Splat`.
- Methods of `Gpu*` and `Wgpu*` readers, writers, and stores build shader code (TSL nodes). Methods of `GpuArrays` and `WgpuBuffer` move data.
- Most functions are static methods of a class. The plain functions are the entry points: `createRenderer`, `getGpuCaps`, `defineBundle`, `loadSplats`, `writeSplats`, and `sortSplatKeys`.
- The names of fixed-size codecs give the total bits of their code: `encodeOct24` (a 12 + 12 bit octahedral direction), `encodeQuatOct32` (a 10 + 10 bit axis and a 12-bit angle), and `encodeQuatOct24` (8 + 8 and 8).

## Pages

### Start here

- [overview.md](overview.md): this page
- [quickstart.md](quickstart.md): a page that draws a file, explained step by step, and the first things to change
- [concepts.md](concepts.md): definitions of the terms the docs use
- [recipes.md](recipes.md): short solutions to common tasks (several objects, subsets, effects, split screens, stills, exports)

### Drawing splats

- [rendering.md](rendering.md): `SplatCollection`, `SplatObject`, and `SplatRenderer`: what a render does, and each option and member
- [params.md](params.md): the projection and draw params, their defaults, and where to set them
- [generators.md](generators.md): `SplatGenerator`, `fromSplats`, index lists, modifiers and their spaces, transforms, and the program cache
- [views.md](views.md): `SplatView`: per-viewpoint settings, view keys, and the CPU sort's orders
- [sorting.md](sorting.md): sort keys, the GPU sort, the CPU sort, and `sortGuard`
- [lifetimes.md](lifetimes.md): on-demand rendering, object releases, and disposal
- [xr.md](xr.md): stereo projection and WebXR on both backends
- [controls.md](controls.md): `CameraControls`: orbit and fly for pointer, touch, keys, gamepads, and XR

### Data and files

- [arraydata.md](arraydata.md): formats, bundles, `ArrayData`, transfers to workers, swapping, and texture layout
- [splats.md](splats.md): the `extSplats`, `covSplats`, and `packedSplats` layouts, on the CPU and in shaders
- [encoding.md](encoding.md): how each splat field is stored, and the codecs other formats can reuse
- [sh.md](sh.md): spherical harmonics: the codecs (ext, packed), per-splat bundles and palettes (RAD's clustered SH, SOG's), loading, writing, and drawing them, and their costs
- [files.md](files.md): PLY, SPZ, RAD, and RDX files: `loadSplats`, `writeSplats`, and `SplatFiles`
- [rdx.md](rdx.md): RDX files, whole or chunked, loaded over HTTP range requests
- [workers.md](workers.md): `WorkerPool`, leases, transfers, and progress

### GPU

- [renderer.md](renderer.md): `createRenderer`, device limits, `getGpuCaps`, HDR output, and `GpuProfiler`
- [gpu-arrays.md](gpu-arrays.md): `GpuArrays`, `GpuArrayReader`, and `GpuArrayWriter`
- [shaders.md](shaders.md): writing TSL against Radix: splat structs, readers, codecs, and patterns
- [wgpu.md](wgpu.md): WebGPU compute: kernels, buffers, compute writers and stores, radix sort, and compaction

### Internals and design

- [projection.md](projection.md): how a renderer projects splats: the four methods, the camera, the projected words, and the draw
- [multi-splat.md](multi-splat.md): why the render model has collections, views, versioned orders, and releases
- [performance.md](performance.md): where the time goes, and the settings that change it

### Reference

- [api.md](api.md): all exports, in alphabetical order
- [checks.md](checks.md): the tests, and how to run them and the benchmarks

## In a browser

`npm run build` (or `npm run docs` alone) writes these pages as HTML to `ref/`, and the docs site links to them. Start at [index.html](index.html). Run `npm run serve` and open `http://localhost:8000/docs/`: the pages also open from disk in Chrome, but some editor previews do not follow links between `file://` pages. The site has these pages of its own:

- [index.html](index.html): the front page, with a summary of Radix and a map of its layers
- [why.html](why.html): a comparison with SparkJS
- [bench.html](bench.html) and [bench-report.html](bench-report.html): benchmarks against SparkJS, a summary and every result
- [ideas.html](ideas.html): the main design ideas, with interactive examples
- [model.html](model.html): how the classes fit together, frame by frame
- [data.html](data.html) and [pipeline.html](pipeline.html): detailed pages on the data and the render pipeline
- [multi-splat.html](multi-splat.html): the multi-splat render model, step by step
