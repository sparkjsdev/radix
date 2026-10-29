# Projection

This page explains how a `SplatRenderer` turns splats into what it draws: the methods, their costs, and the code. All of it is internal to `render/`. Apps choose a `method` and params on a renderer, its views, and its objects ([rendering.md](rendering.md), [params.md](params.md)).

Code: `src/render/SplatProjection.ts` (one object per method), `projections.tsl.ts` (the four methods), `projection.tsl.ts` (their shared parts), `splatCamera.ts` (the camera as uniforms), `splatTransform.tsl.ts` (each object's transforms), `splatParams.ts`, `SplatProjector.ts` (the programs and the dispatch), `splatDraw.ts` (the draw material), and `gpu/sortKey.tsl.ts` (`GpuSortKeys`, in `gpu/` because `wgpu/` reads the keys too). All of it is TSL, so it runs on both backends.

The projection turns each splat into a few uint32 **words**, holding what the draw needs to place and shade a quad for every eye, plus one **sort key**. It is a writer body like any other, so `GpuArrayWriter` (a fragment pass, both backends) and `WgpuArrayWriter` (compute, WebGPU) can both run it, with the same bits. `SplatProjector` builds one program per generator; the program generates each splat, transforms it to head space (applying the modifier), and projects it.

```ts
// What SplatRenderer does on each render (internal functions)

// Its settings, with the render's view's over them
const settings = splatRenderer.settingsOf(view);

// The head plus 1 eye, or 2 eyes from an XR ArrayCamera
SplatCamera.set(renderer, camera);

const projection = SplatProjection.get(settings.method);
const arrays = new GpuArrays({
  renderer,
  bundles: projection.outputs(SplatCamera.eyes),
  storage: true,
});

projectCollection({
  renderer,
  settings,
  collection: settings.collection,
  arrays,
  pass: "full",
  cullKeys: true,
});
```

## Generate and project in one pass

A generator is a splat reader or a TSL function that computes splat `index` in the shader ([generators.md](generators.md)). Generation and projection run in one kernel, with no intermediate splat arrays:

```ts
const ring: SplatGenerator = {
  generateSplat: (i) =>
    GpuSplats.Splat(
      centerOf(i),
      vec3(0.01),
      vec4(0, 0, 0, 1),
      colorOf(i),
      float(1),
      uint(i),
    ),
};

splatRenderer.collection = new SplatCollection([
  { generator: ring, count, matrixWorld: ringObject.matrixWorld },
]);
```

Each method reads one splat form (`projection.input`, `"cov"` or `"splat"`): ewa reads a covariance, and the others read scales and a rotation. When the generator's form differs, the program converts (`GpuSplats.toCov` / `fromCov`), so a projection only sees one kind of splat node.

## Methods

| Method | How it rasterizes a splat | Cost | Choose it for |
|---|---|---|---|
| `ewa` (default) | classic 3DGS / EWA splatting: each eye gets a 2D Gaussian from the projection's Jacobian at the splat's center | the cheapest | most scenes; the look 3DGS captures were trained for |
| `3dgut` | a 2D bound from the unscented transform of 7 sigma points, then the 3D Gaussian evaluated at its maximum along each pixel's ray | within 25% of ewa from outside an object; 4-25x slower inside a scene | large or close splats and wide fields of view, where ewa's linearization at the center is inaccurate |
| `htgs` | the exact outline of the ellipsoid (a dual quadric), then the same ray evaluation | like 3dgut, slower inside scenes | the tightest exact bounds |
| `raygs` | a 3D quad facing the eye in the splat's whitened frame, with the density interpolated across it | within 10% of ewa | ray-evaluated look at nearly ewa's cost |

- The ray methods (3dgut, htgs, raygs) use their outline only to place the quad. Each pixel then finds where its ray passes closest to the splat's center in 3D, so the shading stays exact even where the outline is approximate.
- In the splat's whitened frame the ray is `o + t d`, and the density uses `|o × d|² / |d|²`, with `o × d` interpolated across the quad. The mathematically equal `|o|² - (o·d)² / |d|²` loses all precision to float32 rounding once a splat is thousands of times its own size away.
- Inside a scene, a ray-method splat whose ellipsoid contains or crosses the camera correctly covers the whole screen. In the benchmarks that meant 800 to 4,500 fragments per pixel, against ewa's 30 to 250.

Each method has four steps: `project` (the words of one splat), `look` (rgb, opacity, and whether it is culled), `vertex` (one quad corner from the words), and `density` (per fragment). They share the LoD opacity stretch, depth of field, culling, `boundFromCov`, the anti-aliasing filter, and screen clipping. ewa projects covariances directly; the ray methods need a rotation and scales, so they diagonalize each cov splat once.

## SplatProjection: one object per method

`SplatProjection.get(method)` returns the object for a method (`SplatProjection.METHODS` lists them):

- `input`, `headWords`, `eyeWords`, and `words(eyes)`.
- `bundle(eyes)` / `outputs(eyes)`: the `projected` bundle (`w0`, `w1`, ...) and a projection writer's outputs (`projected` and `sortKeys`).
- `project(splatNode, eyes)`: the TSL that projects one head-space splat; returns its words, whether any eye shows it, whether it is invisible regardless of the view (zero opacity or size), and its distance from the head.
- `write(splat, eyes)`: the writer body that projects `splat(index)` and writes its sort key.
- `SplatProjection.writeKeys(splat, form)`: a body that writes only the sort key, for any method (the CPU sort's pass). `SplatProjection.setKeys(bits, cull)`: the key width and culling uniforms.
- For the draw: `reader(eyes)`, `loadWords(reader, eyes, index)`, `look`, `vertex`, and `density`.

## The camera: head and eyes

Every splat is read once and projected for all eyes; the loop over the eyes unrolls in JavaScript when the shader is built.

- The **head** is the camera in mono and the XR rig's pose in stereo. Splats reach the projection in head space. Words the eyes share are computed once, in head space: the center, color, opacity, rotation and scales, and the filter inflation.
- Each **eye** computes only what differs, through `fromHead` (a uniform per eye; the identity in mono): its 2D bound or, for raygs, its quad frame.
- The draw rebuilds eye-space data from the head words with the same `fromHead`. In the draw's shaders, `SplatCamera.viewIndex` is the eye being drawn.
- `SplatCamera.set(renderer, camera)` (or `setViews({ head, eyes, size, ndcZMin })`) sets the uniforms. The size comes from an `ArrayCamera`'s viewport, the render target, or the canvas. It never modifies the camera: when an eye's projection uses the other clip-space convention (a camera made for WebGL used on WebGPU), the uniforms hold a converted projection.
- The ray methods inflate splats by the head's pixel footprint, exact in mono and nearly exact for each eye in stereo.

## Words

The words of one splat (the head words, then each eye's) fill the `uint32x4` channels `w0`, `w1`, and `w2` of the bundle `projected`; the last channel is `uint32x2` when only 1 or 2 words remain. In the table, semicolons separate words:

| Method | Head words | Words per eye | Mono | Stereo |
|---|---|---|---|---|
| ewa | none | ndc 2x16; depth20 and angle12; rgb; opacity8 and 2x12 log2 scales | 4 words, 16 B | 8 words, 32 B |
| 3dgut, htgs | center direction; center distance; rgb; quat; 3 half log scales, opacity8 and the center direction's low bits | bound ndc 2x16; angle10 and 2x11 log2 scales | 8 words, 32 B | 10 words, 40 B |
| raygs | center direction; center distance; rgb; opacity8 and the center direction's low bits | frame quat; float32 c²; 2 half log axis lengths | 7 words, 32 B | 10 words, 40 B |

- `center` is an octahedral direction of 20 + 20 bits (the top 16 + 16 in the first head word, the low 4 + 4 in bits 24 to 31 of the last head word) and a float32 distance from the head. The direction is within 4e-6 rad, 0.3 px at 4K through a 0.5° lens. The distance is the only depth value, and it is precise enough for ray evaluation and the sort.
- ewa's `depth20` is the view depth's float32 bits above 2^-14, rounded to 20: 5 exponent bits (2^-14 to 2^18 units) and 15 mantissa bits, so steps of 1.5e-5 to 3e-5 of the distance (1.5 to 3 cm at 1 km). Its `angle12` is the bound's angle on [0, π) in steps of π / 4096. The depth only places the quad for the depth test: the sort keys come from the unquantized distance.
- Quaternions in words are `QuatOct32` codes.
- The ray methods' bounds are rounded outward, since their quads only need to cover the splat.
- An eye is culled when its opacity byte (ewa) or its second word (the others) is zero.
- The sort key adds 4 B per splat: 20 / 36 B (mono / stereo) for ewa and 36 / 44 B for the ray methods. Every layout fits both writers' limits of 4 channels and 64 B.

## Sort keys

The bundle `sortKeys` (`SortKeys.KEYS`) holds one RGBA8 texel per splat: a back-to-front key from the splat's distance to the head (`GpuSortKeys.compute`, then `pack`). The width (16, 24, or 32 bits) is a uniform. `cullKeys` (a uniform) chooses which splats get the invalid key. For the GPU sort, which compacts invalid keys away, these are the splats culled in every eye. For the CPU sort, whose order arrives late, they are only invisible splats and splats outside `sortGuard`, and the draw culls per eye. More: [sorting.md](sorting.md#sort-keys).

## The draw

- The draw has no vertex attributes, only an index buffer of 1024 quads (`quadIndices`: `4q + [0, 1, 2, 2, 1, 3]`). It is a single draw call, and each instance draws 1024 splats (`WgpuSplatSorter.QUADS_PER_INSTANCE`): splat `instanceIndex × 1024 + vertexIndex / 4`, with the corner in bits 0 and 1 of `vertexIndex`. GPUs run vertex shaders in batches, and an instance per quad left most of each batch idle (10-15% of the draw).
- Because the draw is indexed, each quad's 2 shared corners are shaded once: 4 vertex shader invocations per splat, not 6.
- The order comes from the GPU sorter's values (an indirect draw) or from the applied CPU order's index list. The vertex stage loads the splat's words, rebuilds its eye-space data, and places the corner; the varyings each method's density reads are written explicitly, so the fragment stage repeats none of the vertex work.
- There is one material, built against real (empty) projected arrays from the start, and rebuilt in place when the method, the eye count, or the order source changes.
- Splats blend premultiplied "over" (one, one minus source alpha), back to front, in sRGB-encoded color as they were trained; they test depth but do not write it, so opaque meshes drawn first hide them.

## Params

`SplatParams` holds the defaults and the uniform nodes every program and draw reads (`SplatParams.nodes`, set before each dispatch and draw). `SplatViewParams` (`maxStdDev`, `minAlpha`, `falloff`) are read by the draw too, so there is one set per render. `SplatObjectParams` (`lodInflate`, `blurAmount`, `preBlurAmount`, `clipXY`, `minPixelRadius`, `maxPixelRadius`, `minContribution`, `focalDistance`, `apertureTan`, and `sortGuard`) are set per object. Renderers, views, and objects hold plain values. Every param and its default: [params.md](params.md).

With `lodInflate`, the projection grows a stretched splat (an opacity above 1) and stores opacity 1; without it, the stretched opacity is stored as is, and the draw treats any stored opacity above 1 as a stretch.
