# @sparkjsdev/radix

Radix draws 3D Gaussian splats with three.js r186's `WebGPURenderer`, on WebGPU or its WebGL2 backend. Splats live in typed-array tables that are the same on the CPU and the GPU. The package has two entry points:

- `@sparkjsdev/radix`: everything, including rendering, GPU arrays, WebGPU compute, workers and camera controls. `three` is a peer dependency.
- `@sparkjsdev/radix/core`: the CPU layer alone: tables, codecs, file formats (PLY, compressed PLY, SPZ, RAD, RDX) and sort keys. It imports nothing, so it runs in workers and in Node without three or a DOM.

Built by [World Labs](https://www.worldlabs.ai).

## Install

From GitHub (npm builds `dist/` on install through the `prepare` script):

```sh
npm install three@0.186 github:sparkjsdev/radix
```

From a local checkout:

```sh
cd radix && npm install          # also builds dist/
cd ../my-app && npm install three@0.186 ../radix
```

Or as a tarball: `npm pack` in the checkout, then `npm install path/to/sparkjsdev-radix-0.0.1.tgz`.

TypeScript apps need TypeScript 5.7 or newer, and the WebGPU types: TypeScript 6's DOM types include them, older versions need `@webgpu/types`.

## Use

```ts
import * as THREE from "three";
import { CameraControls, GpuArrays, SplatCollection, SplatRenderer, createRenderer, loadSplats } from "@sparkjsdev/radix";

const renderer = await createRenderer(); // WebGPU, or the WebGL2 backend where WebGPU is missing
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 0.5, 3);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "orbit" } });

const data = await loadSplats("scene.spz"); // decoded on a worker
const model = new THREE.Object3D();
model.rotation.x = Math.PI; // most captures are stored y down
scene.add(model);
const collection = new SplatCollection([SplatCollection.arrays(GpuArrays.fromData(renderer, data), { matrixWorld: model.matrixWorld })]);
scene.add(new SplatRenderer({ renderer, collection }));

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

The CPU layer, in Node or a worker:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { SplatFiles } from "@sparkjsdev/radix/core";

const { splats } = await SplatFiles.decode(new Uint8Array(readFileSync("scene.ply")), { name: "scene.ply" });
console.log(`${splats.count} splats`);
writeFileSync("scene.spz", await SplatFiles.encode(splats, "spz"));
```

The bundles leave `three`, `three/webgpu` and `three/tsl` to your bundler, or to an import map on a page without one. The workers' code is inlined into the bundle, so there is no separate worker file to serve.

## Develop

Development needs Node 22.15 or newer (the core checks compare against Node's zstd).

```sh
npm install
npm run build      # dist/, the example pages (build/examples/), the test pages (build/test/) and docs/ref/
npm run build:site # optional: the static site in build/site/ (also runs npm run build)
npm run serve      # http-server on the repo root, port 8000
```

Then open:

- `http://localhost:8000/build/site/`: the place to start, after `npm run build:site`. It's a landing page that links to the examples and the docs, all copied into one folder that can be put on any static host.
- `http://localhost:8000/build/examples/index.html`: the example pages (a splat viewer, short scenes, WebXR, an SPZ reader and writer, MPM water, the fx node editor, fractals, and LCC and SOG viewers) and the ports of the SparkJS 2.3.1 examples.
- `http://localhost:8000/docs/index.html`: the docs (guide, API reference, recipes, and the comparison with SparkJS).
- `http://localhost:8000/build/test/gpu/index.html`: the GPU checks (`?gpu=webgpu-gl` for the WebGL2 backend).

The pages load their splat files from Google Cloud Storage and sparkjs.dev, so they need a network connection. They run on WebGPU, or on the WebGL2 backend with `?gpu=webgpu-gl`.

| Command | What it does |
|---|---|
| `npm run build:watch` | rebuild the library, the example pages and `docs/ref/` as files change |
| `npm run typecheck` / `npm run lint` | types of the library, core, examples and tests; then ESLint |
| `npm run check:core` | the core checks in Node |
| `npm run check:docs` | write `docs/ref/`, and check every link and that every export is documented |
| `npm run docs` | regenerate `docs/ref/` after editing a docs `.md` page |
| `npm run check:test` | the GPU test page on both backends in headless Chrome (needs `npm run serve`) |
| `npm run check:examples` | every example page on both backends in headless Chrome (needs `npm run serve`) |
| `npm run bench` / `npm run bench:core` | the GPU benchmark page over the hosted samples / core benchmarks in Node |
| `npm run build:site` / `npm run serve:site` | a static site of the examples and docs in `build/site/`, served on port 8002 |

## Layout

- `src/`: the library. Its layers (`core/`, `gpu/`, `wgpu/`, `worker/`, `render/`, `controls/`) import downwards only, and ESLint enforces that.
- `docs/`: Markdown pages, the generated `ref/` HTML, and the HTML guide.
- `examples/`: the example pages as TypeScript; the build strips their types file by file.
- `test/`: the GPU test page and the benchmark page.
- `scripts/`: builds, checks and benchmarks.

`AGENTS.md` describes the design, the conventions and every example in depth.

## License

MIT
