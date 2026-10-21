# @sparkjsdev/radix

Radix draws 3D Gaussian splats with three.js's `WebGPURenderer`, on WebGPU or WebGL2 from the same TSL shaders. It sorts the splats of all objects together and draws them in one call, on WebGPU entirely on the GPU.

Each splat is made in the projection shader, so it can come from a file, from arrays a GPU simulation writes, or from a formula. In XR, Radix projects and sorts the splats once for both eyes.

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

Or as a tarball: `npm pack` in the checkout, then `npm install path/to/sparkjsdev-radix-0.0.0.tgz`.

TypeScript apps need TypeScript 5.7 or newer, and the WebGPU types: TypeScript 6's DOM types include them, older versions need `@webgpu/types`.

## Use

```ts
import * as THREE from "three";
import { CameraControls, GpuArrays, SplatCollection, SplatRenderer, createRenderer, loadSplats } from "@sparkjsdev/radix";

const renderer = await createRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 0, 3);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "orbit" } });
controls.lookAt(new THREE.Vector3(0, 0, 0));

const splats = GpuArrays.fromData(renderer, await loadSplats("scene.spz"));
// Most captures are stored y down
const matrixWorld = new THREE.Matrix4().makeRotationX(Math.PI);
const collection = new SplatCollection([SplatCollection.arrays(splats, { matrixWorld })]);
scene.add(new SplatRenderer({ renderer, collection }));

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
```

This draws `scene.spz` with orbit controls. [The quickstart](docs/quickstart.md) explains each step.

`@sparkjsdev/radix` is the whole library, with `three` as a peer dependency. `@sparkjsdev/radix/core` is its CPU part alone, with the readers and writers for PLY, compressed PLY, SPZ, RAD and RDX ([docs/files.md](docs/files.md)). It needs neither three.js nor a browser, so it runs in workers and in Node, for example to convert a PLY file to SPZ:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { SplatFiles } from "@sparkjsdev/radix/core";

const { splats } = await SplatFiles.decode(new Uint8Array(readFileSync("scene.ply")), { name: "scene.ply" });
writeFileSync("scene.spz", await SplatFiles.encode(splats, "spz"));
```

The bundles leave `three`, `three/webgpu` and `three/tsl` to your bundler, or to an import map on a page without one. The workers' code is inlined into the bundle, so there is no separate worker file to serve.

## Docs and examples

The docs are the Markdown pages in `docs/`, listed in [docs/overview.md](docs/overview.md).

To build and serve the docs and the examples from a checkout, use Node 22.15 or newer:

```sh
npm install
npm run build   # the library, the examples and the docs' reference pages
npm run serve   # the repo on port 8000
```

Then open `http://localhost:8000/docs/index.html`. Its top bar links to the guide, the reference and the examples, which load their splat files over the network.

## License

MIT
