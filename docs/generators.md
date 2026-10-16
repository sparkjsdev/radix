# Generators and modifiers

A generator is TSL code that makes splat `i` inside the projection's shader, so no intermediate splat arrays are written. A reader of stored splats is one kind of generator; a function that computes splats from their index is another. A modifier is a TSL function applied to each splat a renderer draws. This page also covers how objects are transformed and the program cache, which keeps changes to data, matrices, and params from recompiling.

Code: `src/gpu/splatGenerator.ts` (`SplatGenerator`), `src/render/splatTransform.tsl.ts` (transforms and modifier spaces), and `SplatProjector.ts` (the program cache).

```ts
const { cos, float, sin, uint, uniform, vec3, vec4 } = TSL;

// The app's: time.value = seconds, each frame
const time = uniform(0);

const ring: SplatGenerator = {
  generateSplat: (i) => {
    const a = float(i).mul(0.002).add(time);
    return GpuSplats.Splat(
      vec3(cos(a), 0, sin(a)),
      vec3(0.01),
      vec4(0, 0, 0, 1),
      vec3(1, 0.6, 0.2),
      float(0.9),
      uint(i),
    );
  },
};

splatRenderer.collection = new SplatCollection([
  { generator: ring, count: 3142, matrixWorld: ringObject.matrixWorld },
]);
```

## SplatGenerator

A generator is a plain object with one or both of:

- `generateSplat(index, context)`: returns a `SplatNode` (scales and a rotation).
- `generateCovSplat(index, context)`: returns a `CovSplatNode` (a covariance).

and optionally `bind(data, context)`, which points the generator's inputs (readers, uniforms) at an object's data before that object's dispatch. `SplatGenerator<Data>` is the type; `Data` is what its objects' `data` must be. `AnySplatGenerator` accepts any data. A generator may ignore `context`; one that wraps another passes its own on (`base.generateSplat(i, context)`; left out, it defaults to `SplatGenerator.context`).

## The generator context

`context` describes the object being projected and the viewpoint. View-dependent effects (spherical harmonics, rim light, view-facing sprites, distance fades) read it, so object data never needs a camera. It is a `SplatGeneratorContext` of TSL nodes in the object's space:

| Member | Type | What it is |
|---|---|---|
| `viewOrigin` | vec3 | the head's position: the camera, or the eye pair's center in XR |
| `viewForward` | vec3 | the head's viewing direction, unit |
| `objectToHead`, `headToObject` | mat4 | the whole object-to-head transform and its inverse, whatever the modifier space |
| `objectToWorld` | mat4 | the object's world matrix |

`bind(data, context)` gets the same members as three.js values (`SplatBindContext`: `Vector3`s and `Matrix4`s) for this object and render. A generator can use them for per-object CPU decisions, such as a LoD level or culling. A modifier also gets a context, in its own space ([Modifiers](#modifiers)).

The nodes are uniforms. The renderer sets them before each object's dispatch, along with the object's transform and params. three.js writes a dispatch's uniforms when it encodes that dispatch, so each object sees its own values. A splat is generated once for all eyes, so the view is the head, not each eye.

Set the splat's `index` field (the last argument of `GpuSplats.Splat` and `CovSplat`): effects use it for per-splat randomness.

## Forms

The four methods read one form each: `ewa` reads covariances, and the ray methods (`3dgut`, `htgs`, `raygs`) read scales and a rotation. A generator implements the forms it can, and the program converts when needed: splat to covariance is cheap, and covariance to splat is an eigendecomposition per splat. Forms are chosen once per program, for each step (the generator, the modifier, the projection), so a program converts only where the generator does not provide the form a step takes.

## Stored splats: fromSplats

```ts
// Make it once
const listed = SplatGenerator.fromSplats({
  layout: "extSplats",
  remap: "indices",
});

// Upload the chosen splats' indices as an index list
const nearest = SplatGenerator.indices(renderer, chosenIndices);
const subset = SplatCollection.object({
  generator: listed,
  data: { splats, indices: nearest },
  count: chosenIndices.length,
  matrixWorld,
});
splatRenderer.collection = new SplatCollection([subset]);
```

`SplatGenerator.fromSplats({ layout?, remap?, modifiers?, sh? })` returns a generator of stored splats. Splat `i` is the arrays' splat `remap(i)`, plus its SH color when `sh` is given, then each modifier in turn.

| Option | Default | What it does |
|---|---|---|
| `layout` | `"extSplats"` | the layout of the arrays it reads |
| `remap` | none: `i` itself | `"indices"`: entry `i` of an index list; or any TSL function of the index, such as `(i) => i.mul(uint(4))` for every fourth splat |
| `modifiers` | `[]` | `SplatModifier`s applied in turn, in object space, as part of this generator |
| `sh` | none | `{ codec, degree, palette? }` (`SplatShOptions`): the SH it reads, per splat or through a palette, seen from `context.viewOrigin` ([sh.md](sh.md)) |

Its objects' data is `StoredSplats`: `{ splats }`, plus `indices` with `remap: "indices"` and `shPalette` with an SH palette. One `fromSplats` generator serves all files of its kind and all index lists. A new file or subset only changes the data, so nothing recompiles.

`SplatGenerator.forArrays(arrays, { remap?, modifiers?, sh?, shPalette? })` returns the generator for given arrays. It finds their splat layout and SH storage (like `Splats.findBundle` and `Sh.find`) and returns a `fromSplats` generator shared by all arrays of the same kind, so loaded files draw their SH without extra code. `sh` caps the degree (0 or `false`: no SH). With `modifiers` it makes a new generator. `SplatCollection.arrays(arrays, { sh?, shPalette? })` uses it to make objects.

Through a remap, a splat's `index` stays the stored splat's index, so effects stay on the same splat when a subset changes.

## Index lists

`SplatGenerator.indices(renderer, list, into?)` uploads a list of element indices as `GpuArrays` (the bundle `indices`, `ArrayData.INDICES`, 4 per texel). With `into`, it reuses those arrays, and their count becomes the list's.

An index list draws a subset of stored splats:

- a **LoD subset**: the splats of a LoD tree that the app chose for the current camera;
- one object of a **splat atlas**: several objects stored together in one set of arrays;
- any selection: the splats in a box, the nearest ones, every visible one of a previous frame.

Pool index lists and return them in each object's `release`, once nothing draws the object ([lifetimes.md](lifetimes.md#object-releases); a full example: [recipes.md](recipes.md#a-subset-chosen-per-camera)).

## Custom generators

A generator's TSL is built once per program. Values that change are uniforms, either the app's own or set by `bind(data)`. `bind` runs before each object's dispatch, so one program serves objects with different data:

```ts
// Set per object by bind
const radius = uniform(1);

const ring: SplatGenerator<{ radius: number }> = {
  generateSplat: (i) => {
    const a = float(i).mul(0.002).add(time);
    const center = vec3(cos(a), 0, sin(a)).mul(radius);
    return GpuSplats.Splat(
      center,
      vec3(0.01), // scales
      vec4(0, 0, 0, 1), // quaternion
      vec3(1, 0.6, 0.2), // rgb
      float(0.9), // opacity
      uint(i), // index
    );
  },
  bind: ({ radius: r }) => (radius.value = r),
};

const inner = SplatCollection.object({
  generator: ring,
  data: { radius: 1 },
  count: 3142,
});
const outer = SplatCollection.object({
  generator: ring,
  data: { radius: 2 },
  count: 3142,
  matrixWorld: tilted.matrixWorld,
});
splatRenderer.collection = new SplatCollection([inner, outer]);
```

- `SplatCollection.object` checks `data` against the generator's type at compile time.
- A generator may read anything a shader can: `GpuArrayReader`s bound in `bind`, `WgpuBuffer`s of a simulation, textures, uniforms. The particles of a compute simulation can be a generator that reads their buffers.
- A custom generator can draw stored spherical harmonics with a `GpuShReader` (the reader `fromSplats` uses): bind it in `bind`, and add `sh.color(index, context.viewOrigin, center)` to the splat's rgb ([sh.md](sh.md#in-your-own-generator)).
- The GPU sort sees splats moved by a uniform in the same frame. The CPU sort does not: call `splatRenderer.requestSort()` when they have moved enough ([sorting.md](sorting.md#the-cpu-sort)).

## Modifiers

```ts
// A SplatModifier: a TSL function of a splat
splatRenderer.modifier = (s) => {
  const out = s.toVar();
  // Color by depth, in view space
  const depth = s.get("center").z.negate().div(10);
  out.get("rgb").assign(vec3(depth));
  return out;
};

// "view" (default) | "world" | "object" | a Matrix4
splatRenderer.modifierSpace = "view";
```

A renderer's `modifier(splat)`, or `covModifier(cov)` for the covariance form, runs on each splat it draws, after the object's transform and before the projection. Like three's `scene.overrideMaterial`, it changes what is drawn without editing any generator. A view can set its own, or `null` for none ([views.md](views.md)).

- When both are given, the one matching the generator's form runs; otherwise the program converts.
- Modifiers are part of the program cache key: make each one once and switch among them. After the first frame of each, switching compiles nothing.
- A modifier gets the splat and a context in its own space ([the generator context](#the-generator-context); for `"world"`, `viewOrigin` is the camera's world position). Time, light positions, and similar values are the app's own uniforms. Per-splat randomness comes from `index`.
- `fromSplats({ modifiers })` applies modifiers in object space as part of one generator, for effects that belong to an object rather than to the viewpoint; they get the generator's context.

Types: `SplatModifier` (`(splat: SplatNode, context?: SplatGeneratorContext) => SplatNode`) and `CovSplatModifier` (`(cov: CovSplatNode, context?) => CovSplatNode`).

### Modifier spaces

| `modifierSpace` | The modifier sees | Use it for |
|---|---|---|
| `"view"` (default) | head space: the camera at the origin, looking down -z | depth, view-dependent coloring, screen-space effects |
| `"world"` | world space | height coloring, effects anchored in the scene |
| `"object"` | each object's own space | an object-local wobble or deformation |
| a `Matrix4` | the space of that frame (read every render), such as a gizmo's `matrixWorld` | a wave or a cut anchored to a movable frame |

`ModifierSpace` is the type. The space changes only matrices, so one program serves all spaces and frames, and moving a frame compiles nothing.

## Transforms

Splats arrive at the projection in head space (the camera in mono, the XR rig's pose in stereo). For each object, the CPU computes object to head in float64 and uploads one matrix, so objects far from the origin keep their precision. With a modifier, the transform splits around the modifier's space:

- no modifier: head × object;
- `"view"`: head × object, then the modifier;
- `"object"`: the modifier, then head × object;
- `"world"` or a frame F: F⁻¹ × object, the modifier, then head × F.

A matrix that is a rotation times a uniform scale is applied directly: it rotates the quaternion and multiplies the scales. Any other matrix (a non-uniform scale, a shear, a mirror) is applied to the covariance, Σ' = M Σ Mᵀ. The CPU tests each matrix (`G = MᵀM` within 1e-6 of `trace(G)/3 · I`, and `det M > 0`) and sets a uniform flag, so dragging a gizmo into a non-uniform scale switches paths without compiling anything.

In the world and frame paths, world coordinates far from the origin lose float32 precision; the view, object, and no-modifier paths do not.

## The program cache

`SplatProjector` keeps one program per generator, modifier, cov modifier, method, eye count, pass (`full`, or `keys` for the CPU sort), and backend, shared by every renderer and view. A program's inputs are uniforms set before each dispatch (the camera, the params, the object's transforms) and the inputs that `bind(data)` sets.

| Member | What it does |
|---|---|
| `SplatProjector.programs` | the number of programs compiled so far (for stats and tests) |
| `SplatProjector.dispose(generator)` | frees a generator's programs. Garbage collection does not free GPU pipelines; call this once a generator you stop using has no live objects (an object's `release` can) |

Changing data, matrices, params, the modifier space, or a frame compiles nothing. A new generator or modifier compiles once per method and eye count.

## Gotchas

- Generators and modifiers made per frame compile per frame. Make them once.
- Each object costs one dispatch. Tens of objects are fine; for thousands, store them together (a splat atlas) and draw them as one object through one generator.
- WebGPU's baseline allows 16 sampled textures per shader stage, and one stored layout uses 2 or more: a generator that reads many arrays at once can run out.
