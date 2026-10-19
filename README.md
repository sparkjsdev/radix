# @sparkjsdev/radix

> [!CAUTION]
> ⚠️ **Radix is experimental.** Its API may change completely in any version.

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

## Credits

The library follows these papers, formats and projects:

- `ewa`, the default projection method: [3D Gaussian Splatting for Real-Time Radiance Field Rendering](https://arxiv.org/abs/2308.04079) (Kerbl et al., SIGGRAPH 2023) and [EWA Volume Splatting](https://vcg.seas.harvard.edu/publications/20011001-ewa-volume-splatting) (Zwicker et al., IEEE Visualization 2001).
- `3dgut`: [3DGUT: Enabling Distorted Cameras and Secondary Rays in Gaussian Splatting](https://arxiv.org/abs/2412.12507) (Wu et al., CVPR 2025). Its ray evaluation, which `htgs` shares, is the maximum response of [3D Gaussian Ray Tracing](https://arxiv.org/abs/2407.07090) (Moenne-Loccoz et al., SIGGRAPH Asia 2024).
- `htgs`: the exact outline of [Efficient Perspective-Correct 3D Gaussian Splatting Using Hybrid Transparency](https://arxiv.org/abs/2410.08129) (Hahlbohm et al., Eurographics 2025), without its hybrid-transparency blending.
- `raygs`, and the anti-aliasing of `3dgut` and `htgs`: [Hardware-Rasterized Ray-Based Gaussian Splatting](https://arxiv.org/abs/2503.18682) (Rota Bulò et al., CVPR 2025).
- PLY: the layout of the 3DGS reference implementation, [graphdeco-inria/gaussian-splatting](https://github.com/graphdeco-inria/gaussian-splatting).
- SPZ: Niantic's format and its coordinate systems, [nianticlabs/spz](https://github.com/nianticlabs/spz).
- Compressed PLY: the format of PlayCanvas's [SuperSplat](https://github.com/playcanvas/supersplat), with the scale and SH mappings of [splat-transform](https://github.com/playcanvas/splat-transform).
- The quaternion of a rotation basis: `Quat::from_rotation_axes` in [glam](https://github.com/bitshifter/glam-rs), after `XMQuaternionRotationMatrix` in [DirectXMath](https://github.com/microsoft/DirectXMath).
- The FSE coding of the Zstandard encoder: `fse_compress.c` and `fse.h` in [zstd](https://github.com/facebook/zstd).

The examples also follow:

- MPM water: Yuanming Hu's [mpm88](https://github.com/taichi-dev/taichi/blob/master/python/taichi/examples/simulation/mpm88.py) (Taichi), in the units of nialltl's [MPM guide](https://nialltl.neocities.org/articles/mpm_guide), with the position clamp of nialltl's [incremental_mpm](https://github.com/nialltl/incremental_mpm) and the fixed-point grid sums of [WebGPU-Ocean](https://github.com/matsuoka-601/WebGPU-Ocean).
- SOG viewer: PlayCanvas's [SOG format](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/), and level-of-detail selection and streaming after the [PlayCanvas engine](https://github.com/playcanvas/engine).
- Effect editor: Inigo Quilez's [distance functions](https://www.shadertoy.com/view/Xds3zN) and [palettes](https://www.shadertoy.com/view/ll2GD3), Matt Zucker's [polynomial approximations of matplotlib colormaps](https://www.shadertoy.com/view/WlfXRN), five colormaps of [CMasher](https://github.com/1313e/CMasher), Melissa O'Neill's [PCG](https://www.pcg-random.org/) hash in the GPU form of [Hash Functions for GPU Rendering](https://jcgt.org/published/0009/03/02/) (Jarzynski and Olano, JCGT 2020), and bryc's [cyrb53](https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js).

The examples load this third-party sample data:

- [Knock Community Hall](https://superspl.at/scene/0ff2e6dc) by [scbenoit](https://superspl.at/user/scbenoit), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Sunnyvale Heritage Park Museum](https://superspl.at/scene/d5d397aa) by [zeitgeistarchivescans](https://superspl.at/user/zeitgeistarchivescans), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Cluster fly](https://github.com/danybittel/splats/releases/tag/splat) by [Dany Bittel](https://danybittel.ch/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), reduced in size.
- [SharedTestModels](https://github.com/raymondyfei/SharedTestModels), [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
- Food scans by [Tipatat](https://x.com/tipatat).
- [Sutro Tower](https://vincentwoo.com/2025/02/18/sutro-tower-in-3d/) by Vincent Woo and Daylen Yang.
- [Grace Cathedral](https://vincentwoo.com/3d/grace_cathedral/) by Vincent Woo.

## License

MIT
