# Shaders

Radix's shaders are written in TSL (three.js Shading Language), which three compiles to WGSL on WebGPU and GLSL on WebGL2, so one source runs on both backends. This page covers what a shader needs from Radix: the `TSL` helper, the splat structs, reading and writing tables, the codecs, and the patterns generators and modifiers use.

Code: `src/gpu/tsl.ts`, `splats.tsl.ts`, `splatAccess.ts`, `encoding.tsl.ts`, `math.tsl.ts`, and `sortKey.tsl.ts`.

```ts
const { float, hash, mix, uniform, vec3 } = TSL;

// The app's: time.value = seconds
const time = uniform(0);

splatRenderer.modifier = (s) => {
  const out = s.toVar(); // a copy to change
  // A random phase per splat, flickering between 0 and 1 over time
  const phase = hash(s.get("index")).mul(6.28).add(time);
  const flicker = phase.sin().mul(0.5).add(0.5);
  const warm = vec3(1, 0.8, 0.3);
  out.get("rgb").assign(mix(s.get("rgb"), warm, flicker.mul(0.3)));
  return out;
};
```

## TSL and TslNode

`TSL` is `three/tsl` with its export names checked but its node types loosened: `const { Fn, If, vec3, uint, uniform } = TSL;`. `TslNode` is the type of any TSL node. TSL infers shader types when a material or kernel is built, and three's per-type node typings would need a cast on nearly every expression, so Radix's APIs take and return `TslNode`.

- Shader code is built once, when a program first runs, from JavaScript functions. Loops and branches in JavaScript unroll at build time; TSL's `If` and `Loop` become shader branches and loops.
- TSL drops nodes that do not reach an output, so a modifier that only changes color costs nothing in a pass that only writes sort keys.
- Values that change should be uniforms (`uniform(value)`, then `.value = ...`), not new nodes, because a new node means a new program.

## Splat structs

A splat in a shader is a TSL struct. Generators return one, readers load one, and modifiers take and return one.

| `SplatNode` field | Type | |
|---|---|---|
| `center` | `vec3` | position |
| `scales` | `vec3` | the three standard deviations (linear, not log) |
| `quaternion` | `vec4` | rotation, `xyzw` |
| `rgb` | `vec3` | color; may be above 1 or below 0 |
| `opacity` | `float` | 1 is opaque; up to about 2 for merged LoD nodes |
| `index` | `uint` | the source splat's index (through a remap, the stored splat's) |

| `CovSplatNode` field | Type | |
|---|---|---|
| `center` | `vec3` | position |
| `xxyyzz` | `vec3` | the covariance's diagonal |
| `xyxzyz` | `vec3` | the covariance's off-diagonal entries |
| `rgb`, `opacity`, `index` | | as above |
| `normal` | `vec3` | zero for none |

`PbrNode` has `normal` (`vec3`), `roughness`, and `metallic` (`float`). Make structs with `GpuSplats.Splat(center, scales, quaternion, rgb, opacity, index?)`, `GpuSplats.CovSplat(center, xxyyzz, xyxzyz, rgb, opacity, normal, index?)`, and `GpuSplats.Pbr(normal, roughness, metallic)`; fields left out are zero.

Struct nodes are typed by brand: `get()` accepts only the struct's own field names, and a `CovSplatNode` is refused where a `SplatNode` is expected. To change a struct, copy it with `toVar()` and assign to its fields:

```ts
const grow = (s: SplatNode): SplatNode => {
  const out = s.toVar();
  out.get("scales").assign(s.get("scales").mul(1.5));
  return out;
};
```

Converting between the forms: `GpuSplats.toCov(splat)` is cheap; `GpuSplats.fromCov(cov)` diagonalizes the covariance (an eigendecomposition per splat). `GpuSplats.splatOf(generator, i)` and `covSplatOf(generator, i)` give a generator's splat in the asked form, converting only when the generator lacks it.

## Reading and writing tables

- **Any bundle**: `new GpuArrayReader(def).bind(arrays, name)`, then `reader.load(channel, index)` in any shader stage ([gpu-arrays.md](gpu-arrays.md#gpuarrayreader)).
- **Splats**: `GpuSplatReader.for(layout).bind(arrays)` or `GpuSplatReader.from(arrays)`, then `loadSplat`, `loadCovSplat`, `loadCenter`, `loadRgb`, `loadOpacity`, and `loadPbr` (ext) ([splats.md](splats.md#gpusplatreader-the-shader-side)).
- **Writing bundles**: `GpuArrayWriter` (a fragment pass, both backends) or `WgpuArrayWriter` (compute, WebGPU), with `GpuSplats.storeExt`, `storeCov`, and `storePacked` for splats ([gpu-arrays.md](gpu-arrays.md#gpuarraywriter)).
- **Scattered writes and kernels** (WebGPU): `WgpuArrayStore`, `WgpuCompute`, and `WgpuBuffer` ([wgpu.md](wgpu.md)).

A reader's shader code depends only on its bundle definition. `bind` points it at data with uniforms and texture bindings, so a reader built once can read every table of that definition. This is how one `fromSplats` program draws every file of a layout.

## Codecs

The TSL twins of the CPU codecs give the same bits ([encoding.md](encoding.md)):

- `GpuSplats`: `decodeExt` / `encodeExt` / `decodeExtPbr`, `decodeCov` / `encodeCov`, `decodePacked` / `encodePacked` (with a `PackedEncoding` or a `vec4(rgbMin, rgbMax, lnScaleMin, lnScaleMax)` node), the `store*` functions, `toCov` / `fromCov`, `withIndex`, and `normalOf` (the axis of the smallest scale: a flat splat's normal).
- `GpuEncoding`: half floats, unorm8, LoD opacity, shared-exponent color, and octahedral directions and quaternions.
- `GpuSplatMath`: `quatRotate`, `quatMul`, `quatConj`, `mat3FromMat4`, `scaleQuatMatrix`, `covFromScaleQuat`, `covMatrix`, `symEigens`, and `basisToQuat`.
- `GpuSortKeys`: `compute(distance, bits)` (the sort key of a distance; non-finite distances give the invalid key), `invalid(bits)` (all ones), `pack(key)` (to the RGBA8 texel of a `SortKeys.KEYS` channel), and `unpack(rgba)`. `bits` is a `uint` node, so a uniform can switch widths without a rebuild ([sorting.md](sorting.md#sort-keys)).

## Patterns

**Per-splat randomness.** Key it on `index`, which stays the stored splat's index through remaps, so an effect stays on the same splat when a LoD subset changes: `hash(s.get("index"))`.

**Animation.** Read a uniform the app sets each frame. The GPU sort sees the moved splats in the same frame; the CPU sort sorts them again only when asked (`splatRenderer.requestSort()`), because it cannot see a uniform change ([sorting.md](sorting.md#the-cpu-sort)).

**Per-object values.** A generator's `bind(data)` runs before each object's dispatch; set uniforms there, so one program can draw objects with different values ([generators.md](generators.md#custom-generators)).

**Choosing a form.** Implement `generateCovSplat` when a covariance is what you have (the `ewa` method reads covariances), `generateSplat` when you have scales and a rotation, or both. The program picks the form each step needs and converts only when it must.

**Creating generators once.** Generators and modifiers are cache keys. Make them once, at startup, and switch among them; a modifier made inside the render loop compiles a new program every frame.

## Gotchas

- Index math: `index` is a `uint`. Mixing it with `float` needs `float(index)`; mixing with `int` needs `int(index)`.
- WebGL2 has no compute shaders and no storage textures: `Wgpu*` classes throw there. Everything else on this page runs on both backends.
- Assign only to the fields of a variable made with `toVar()`. The struct a modifier receives can feed other steps of the program, so change a copy of it.
