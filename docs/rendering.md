# Rendering

Three classes draw splats. A `SplatObject` is one thing to draw. A `SplatCollection` lists the objects drawn together. A `SplatRenderer` is the `THREE.Mesh` that draws a collection: add it to a scene and render from any camera. An app that targets only WebGPU needs only these three. Views ([views.md](views.md)) are for drawing a viewpoint with different settings, and for the WebGL2 path.

Code: `src/render/SplatCollection.ts` and `SplatRenderer.ts`. The reasons for this design: [multi-splat.md](multi-splat.md).

```ts
const model = new THREE.Object3D();
scene.add(model);

const collection = new SplatCollection([
  SplatCollection.arrays(splats, { matrixWorld: model.matrixWorld }),
]);
const splatRenderer = new SplatRenderer({
  renderer,
  collection,
  method: "raygs",
});
scene.add(splatRenderer);

renderer.render(scene, camera);
// Projected and sorted again for this camera
renderer.render(scene, otherCamera);
```

## What a render does

In each render, the renderer's `onBeforeRender`:

1. **Projects** the collection for the render's camera: every object, one dispatch each, into the renderer's projected arrays. Each splat is generated (read from arrays, or computed), transformed by its object's `matrixWorld` into head space, run through the renderer's modifier if there is one, and projected into a few words plus a sort key ([projection.md](projection.md)). An XR `ArrayCamera`'s two eyes share one projection.
2. **Orders** the splats back to front ([sorting.md](sorting.md)):
   - `sortMode: "gpu"` (WebGPU's default): `WgpuSplatSorter` compacts and sorts them in the same frame, and the draw is indirect. Nothing is read back, so a new collection or camera draws in the same render.
   - `sortMode: "cpu"` (WebGL2, or chosen on WebGPU): the applied order of the render's view, which draws the collection that order was sorted for. Nothing is drawn until an order is applied; `autoSort` sorts and applies orders by itself ([views.md](views.md)).
3. **Draws** every visible splat as a quad, in one draw call ([projection.md](projection.md#the-draw)). Colors are clamped at 0 there: stored colors may be negative (LoD merges and spherical harmonics leave them so), and a negative one would decode to NaN or darken a float target.

With the GPU sort nothing depends on the camera between renders, so one renderer draws any number of cameras, viewports, and render targets. Changes take effect at the next render: set `collection` to change what is drawn, and the settings to change how.

## SplatObject

One thing to draw: `count` splats of a generator, placed in the world by `matrixWorld`.

| Field | What it is |
|---|---|
| `generator` | the `SplatGenerator` that makes each splat: a reader of stored splats, or TSL code ([generators.md](generators.md)) |
| `data` | what `generator.bind` receives before this object's dispatch (with the generator context): `{ splats, indices?, shPalette? }` for `fromSplats`, anything for an app's own generator, or nothing |
| `count` | the number of splats; always given |
| `matrixWorld` | the object's world transform (object to world): a `Matrix4` such as an `Object3D`'s `matrixWorld`, or a function returning one; read every render. Default: the identity |
| `params` | object params over the view's and the renderer's (`Partial<SplatObjectParams>`; [params.md](params.md)) |
| `release` | runs once this object is in no live collection of any renderer: free what the object owns there ([lifetimes.md](lifetimes.md#object-releases)) |

A collection locks `generator`, `data`, and `count` on the object itself (they become read-only properties). `matrixWorld`, `params`, and `release` stay live and can be reassigned at any time. When the same thing is drawn in several collections, views, or renderers, list the same object in each.

Matrices made of a rotation and a uniform scale take the fast path. Any other matrix (a non-uniform scale, a shear, a mirror) is applied to each splat's covariance, without compiling anything new ([generators.md](generators.md#transforms)).

## SplatCollection

An immutable, ordered list of objects: which splats to draw.

```ts
const collection = new SplatCollection([
  // Stored splats
  SplatCollection.arrays(fileA, { matrixWorld: a.matrixWorld }),
  SplatCollection.arrays(fileB, {
    matrixWorld: b.matrixWorld,
    params: { blurAmount: 0 },
  }),
  // Splats made in a shader
  { generator: ring, count: 4000, matrixWorld: ringObject.matrixWorld },
]);
```

| Member | What it does |
|---|---|
| `new SplatCollection(objects)` | a collection of objects, in order; locks each object's `generator`, `data`, and `count` |
| `objects` | the objects as `MappedObject`s: `{ object, offset }`, where `offset` is the object's first splat in the projected arrays |
| `count` | splats in all |
| `SplatCollection.arrays(arrays, rest?)` | an object for splat arrays, drawn with their spherical harmonics. It uses one shared generator per kind (`SplatGenerator.forArrays`), so every file of a kind runs one program. `count` defaults to `arrays.count`. `rest` sets `matrixWorld`, `params`, `release`, `count`, `sh` (caps the degree; 0 or `false`: no SH), and `shPalette` (an SH palette's arrays, [sh.md](sh.md)) |
| `SplatCollection.object(object)` | returns the object unchanged, but checks its `data` against its generator's type at compile time |
| `SplatCollection.matrixWorldOf(object)` | the object's world transform this render, or the identity |
| `SplatCollection.EMPTY` | the empty collection (a renderer's default) |

**A collection object is a version.** A change in which objects it lists, their order, or their counts needs a new collection. Matrices and params are not part of it: moving an object never needs a new collection. On the CPU sort an order indexes the projected splats of one exact collection, which is why collections are immutable ([multi-splat.md](multi-splat.md#6-webgl2-has-no-compute-shaders-so-its-sort-arrives-late)).

Types: `SplatObject<Data>`, `AnySplatObject` (an object of any data), and `MappedObject`.

## SplatRenderer

```ts
const splatRenderer = new SplatRenderer({
  renderer,
  collection,
  method: "ewa",
  objectParams: { blurAmount: 0.2 },
});
```

| Option | Default | What it does |
|---|---|---|
| `renderer` | | the `WebGPURenderer` (from `createRenderer`) |
| `collection` | `SplatCollection.EMPTY` | what every viewpoint draws unless its view sets its own |
| `method` | `"ewa"` | `"ewa"`, `"3dgut"`, `"htgs"`, or `"raygs"` (`ProjectionMethod`; [projection.md](projection.md#methods)) |
| `sortBits` | 24 | sort key bits: 16, 24, or 32 ([sorting.md](sorting.md#sort-keys)) |
| `params` | [the defaults](params.md) | the view params every splat of a render shares (`maxStdDev`, `minAlpha`, `falloff`); given fields override the defaults |
| `objectParams` | [the defaults](params.md) | the object param defaults; given fields override them |
| `modifier`, `covModifier` | none | a TSL function run on every splat, in splat or covariance form ([generators.md](generators.md#modifiers)) |
| `modifierSpace` | `"view"` | where the modifier runs: `"view"`, `"world"`, `"object"`, or a `Matrix4` (a frame's `matrixWorld`) |
| `sortMode` | `"gpu"` on WebGPU, else `"cpu"` | the GPU sort every render, or each view's applied CPU order |
| `autoSort` | `{ distance: 0, angle: 0 }` | the CPU sort's automatic loop, or `false` ([views.md](views.md#autosort)) |
| `sortWorker` | `SplatRenderer.sortPool` | a `WorkerPool` or `WorkerLease` for CPU sorts ([sorting.md](sorting.md#the-cpu-sort)) |
| `viewKey` | `(camera) => camera` | the key of the view a render from a camera draws ([views.md](views.md#view-keys)) |
| `onInvalidate` | none | `(view?) => void`, called when Radix has something new to show ([lifetimes.md](lifetimes.md#on-demand-rendering)) |

| Member | What it does |
|---|---|
| `collection`, `method`, `sortBits`, `modifier`, `covModifier`, `modifierSpace`, `autoSort`, `sortWorker`, `viewKey`, `onInvalidate` | the options above, settable at any time |
| `params`, `objectParams` | complete objects, changed in place: `splatRenderer.objectParams.blurAmount = 0.5` |
| `sortMode` | settable; switching to `"gpu"` drops every view's orders |
| `viewFor(key, options?)` | the view of `key`, made on first use; `options` are set on it ([views.md](views.md)) |
| `views` | the views made so far, by key (a `ReadonlyMap`) |
| `view` | the view every render draws, when set (for example one XR head drawn through several cameras) |
| `requestSort()` | sort every view again at its next render, and call `onInvalidate()` (CPU sort) |
| `prepare(camera)` | projects and sorts for `camera` now, outside a render; the next render draws that instead of projecting again. Use it to keep WebGL2 timer queries from nesting |
| `phase` | `(name, run) => run()` wrapper for the `"project"` and `"sort"` steps, for example `GpuProfiler.phase` |
| `readSortedCount()` | the GPU sort's visible count of the latest render (a readback) |
| `dispose()` | frees the renderer's arrays, sorter, material, and views, and releases objects only it held |
| `SplatRenderer.sortPool` | static: the `WorkerPool` every renderer's CPU sorts share, all views of all renderers without a `sortWorker`. Made on first use, starting workers as sorts need them; it lives with the page |
| `SplatRenderer.sortWorkers` | static: the shared pool's size, 4 by default. It is read when the pool is made, at the first CPU sort, so set it before then |

The settings a render uses resolve field by field: the view's when it sets one, else the renderer's ([views.md](views.md#how-settings-resolve)). `method` and `sortMode` belong to the renderer only, because the method decides the projected arrays and the draw material. Drawing with two methods takes two renderers.

## Several renderers

Two renderers drawn in one render each keep their own projected splats and sorter, because a frame's compute runs before its draws: shared buffers would draw the second renderer's results twice. The quad index buffer, the param uniforms, and the program cache are shared. Splats of different renderers are not sorted together, so use one renderer for everything that overlaps.

## Gotchas

- Each renderer sorts only its own splats: objects that overlap must be in the same renderer's collection to blend correctly.
- A collection made per frame is fine on WebGPU, but on the CPU sort each new collection needs a new sort before it shows. Make a new collection only when the set of objects changes.
- `frustumCulled` is off: the projection culls splats itself.
- Splats are depth tested against what is drawn before them (opaque meshes) but write no depth. Each quad sits at its splat center's depth, so a splat crossing a mesh is hidden or shown whole. That depth is stored in steps of 1.5e-5 to 3e-5 of the distance ([projection.md](projection.md#words)), and works the same with a logarithmic depth buffer (`createRenderer({ logarithmicDepthBuffer: true })`).
- `dispose()` renderers you no longer need. A renderer that is garbage-collected undisposed logs a warning, and its objects are released at that point.
