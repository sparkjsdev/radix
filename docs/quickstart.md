# Quickstart

The code below is a complete page that loads a splat file and draws it with orbit controls. After it come the first things most apps change. It assumes three.js and a bundler; the imports come from `@sparkjsdev/radix`.

## A page that draws a file

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

// 1. The renderer: WebGPU, or the WebGL2 backend where WebGPU is missing
const renderer = await createRenderer();
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);

// 2. A scene, a camera, and controls
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 0.5, 3);
const controls = new CameraControls({
  canvas: renderer.domElement,
  object: camera,
  storageKey: "my-page",
  settings: { mode: "orbit" },
});
controls.lookAt(new THREE.Vector3(0, 0, 0));

// 3. Load the file on a worker, then upload it
const data = await loadSplats("scene.spz", {
  onProgress: (fraction, stage) => console.log(stage, fraction),
});
const splats = GpuArrays.fromData(renderer, data);

// 4. Place it, and draw it
const model = new THREE.Object3D();
// Most captures are stored upside down (y down)
model.rotation.x = Math.PI;
scene.add(model);
const collection = new SplatCollection([
  SplatCollection.arrays(splats, { matrixWorld: model.matrixWorld }),
]);
const splatRenderer = new SplatRenderer({ renderer, collection });
scene.add(splatRenderer);

// 5. Render every frame
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
```

## What each step does

1. **`createRenderer()`** returns an initialized `WebGPURenderer`. It picks WebGPU when the browser has it and the WebGL2 backend otherwise, and asks the device for the limits that about 95% of devices support. URL parameters can override its options: `?gpu=webgpu-gl` forces WebGL2, `?profile=1` turns on GPU timing ([renderer.md](renderer.md)).
2. **`CameraControls`** moves the camera from the pointer, touch, keyboard, and gamepads. `update()` applies the input once per frame. Press F to switch between orbit and fly ([controls.md](controls.md)).
3. **`loadSplats(url)`** downloads and decodes PLY, SPZ, RAD, or RDX on a worker and returns an `ArrayData`: a table with one row per splat, here in the `extSplats` layout (32 bytes per splat). **`GpuArrays.fromData`** uploads the table into textures, so row `i` on the CPU is row `i` on the GPU ([files.md](files.md), [gpu-arrays.md](gpu-arrays.md)).
4. **`SplatCollection`** lists what to draw: here one object, the uploaded splats placed in the world by `model.matrixWorld`. **`SplatRenderer`** is a `THREE.Mesh` that draws a collection. The matrix is read on every render, so moving `model` moves the splats ([rendering.md](rendering.md)).
5. **Each render** projects every splat for the camera, sorts them back to front, and draws them in one draw call. The app needs no other per-frame calls and no views.

## Test the WebGL2 fallback

Open the page with `?gpu=webgpu-gl`. The page works unchanged, with two visible differences:

- The sort runs on a worker. The first frames draw nothing until the first order arrives, and while the camera moves the order lags a few frames behind it.
- The splats appear a moment after loading, and a new collection replaces the old one a few frames after it is set.

[sorting.md](sorting.md) explains why, and [views.md](views.md) shows how to control it.

## Change the look

```ts
// "ewa" (default), "3dgut", "htgs", or "raygs"
splatRenderer.method = "raygs";
// Less anti-aliasing blur
splatRenderer.objectParams.blurAmount = 0.1;
// Draw each Gaussian a little farther out
splatRenderer.params.maxStdDev = 3;
```

The four methods are four ways to rasterize a splat. `ewa` is classic 3D Gaussian splatting and the cheapest. The ray methods evaluate each splat along the pixel's ray, which is exact for large and close splats ([projection.md](projection.md)). Changing a param recompiles nothing, so params can change every frame ([params.md](params.md)).

## Load another layout

```ts
// 16 bytes per splat: half the memory
const data = await loadSplats(url, { layout: "packedSplats" });
```

`packedSplats` keeps colors, scales, and rotations in 8 bits each. Use it for very large files or low-memory devices ([splats.md](splats.md)).

## Spherical harmonics

Spherical harmonics load (into `extSh`, 64 bytes per splat at degree 3) and draw by default; no extra code is needed. To save memory or skip them:

```ts
// 48 bytes per splat, near-lossless
const smaller = await loadSplats(url, { sh: "packed" });

// Base colors only
const plain = await loadSplats(url, { sh: false });

// Or keep them and draw fewer bands (0: none). Nothing recompiles
splatRenderer.objectParams.maxShDegree = 1;
```

[sh.md](sh.md) covers the codecs, palettes, and drawing SH in your own generator.

## Clean up

```ts
splatRenderer.collection = new SplatCollection([
  SplatCollection.arrays(splats, {
    matrixWorld: model.matrixWorld,
    release: () => splats.dispose(),
  }),
]);

// Later: dispose runs the release, which frees the textures
scene.remove(splatRenderer);
splatRenderer.dispose();
```

`release` runs once nothing draws the object any more. Radix doesn't free an app's data; it calls `release` when freeing it is safe ([lifetimes.md](lifetimes.md)).

## Next

- [recipes.md](recipes.md): several files, generated splats, subsets, effects, split screens, and stills.
- [concepts.md](concepts.md): definitions of the terms the other pages use.
- The example pages in this repo: `/build/examples/splats/index.html` (a full viewer: `examples/splats/`), `/build/examples/scenes/index.html` (short usage examples: `examples/scenes/scenes.ts`), and `/build/examples/xr/index.html` (WebXR: `examples/xr/main.ts`). The same pages run as static pages on the library bundle (`npm run build`, `npm run serve`, then `http://localhost:8000/build/examples/index.html`), with the ports of Spark's examples and larger examples, each self-contained in its folder of `examples/`: SOG and LCC viewers with level of detail (`sogs/`, `lcc/`), 3D fractals (`fractals/`), MLS-MPM water (`mpm/`, WebGPU), and an effect-graph editor (`fxedit/`). `npm run build:single` also builds each of these pages as one HTML file (`build/examples/<name>/<name>.html`).
