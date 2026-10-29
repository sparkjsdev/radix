# Multi-splat design

Radix draws many splat objects in one sort through collections, a renderer with per-viewpoint views, versioned orders, and object releases. What each part does is described in [rendering.md](rendering.md), [views.md](views.md), [lifetimes.md](lifetimes.md), and [projection.md](projection.md). This page explains why the parts exist: what each one is for, which constraint requires it, and which simpler designs were tried first and dropped. [multi-splat.html](multi-splat.html) covers the same material step by step, with interactive diagrams.

The model (generators, immutable collections, a renderer with per-viewpoint views, versioned orders, and object releases) has more parts than drawing splats might seem to need. Each part addresses a constraint that a simpler design does not meet:

- Overlapping splats blend correctly only when they are sorted together, so every object is projected into one shared set and drawn in one draw call.
- WebGL2 has no compute shaders, so its sort runs on a worker and finishes a few frames late. An order is valid only for the exact collection of splats it was sorted for, and for one viewpoint.
- Therefore that collection must be a value that can be stored and compared (a `SplatCollection`), each viewpoint must keep drawing an old collection while a new one is sorted (a `SplatView` per camera, `SplatOrder.version`), and nothing the old collection uses can be freed until nothing draws it (an object's `release`).
- Shader compilation is slow, so programs are cached by generator, and a generator must be a program only, without its data.

An app that targets only WebGPU needs little of this: it creates a `SplatRenderer` of a collection, adds it to the scene, and renders from any camera. The sort runs on the GPU in the same frame, so nothing depends on the camera between renders and no views are needed.

```ts
const collection = new SplatCollection([
  SplatCollection.arrays(splats, { matrixWorld: model.matrixWorld }),
]);
const splatRenderer = new SplatRenderer({ renderer, collection });
scene.add(splatRenderer);

renderer.render(scene, camera);
```

## The constraints

### 1. Splats must be sorted together

Gaussian splats are blended back to front. Two objects drawn in separate draw calls, each sorted separately, blend incorrectly wherever they overlap: one is drawn entirely over the other, even where their splats interleave in depth (for example a hand inside a cloud, or two scans of the same room). Therefore every object a renderer draws is projected into one shared set of projected splats, sorted as one list, and drawn in one draw call.

A single draw call requires some settings to be the same for every splat in it:

- **One method.** The four methods (`ewa`, `3dgut`, `htgs`, and `raygs`) store different words and decode them in different shaders. Mixing them in one draw would require a method tag per splat, the union of every word layout, and branches in both shader stages. The method is a property of the renderer, which owns the projected arrays and the draw material that the method determines.
- **The params the draw reads.** `maxStdDev`, `minAlpha`, and `falloff` set the size and shading of the quads in the draw, so a splat projected with one value and drawn with another has the wrong size. These are `SplatViewParams`, one set per render (the renderer's, or a view's over them). Every param that only the projection reads (`lodInflate`, the blurs, clipping, pixel radius limits, `minContribution`, depth of field, and `sortGuard`) is in `SplatObjectParams`, with defaults on the renderer, overrides on a view, and overrides per object. `lodInflate` moved to `SplatObjectParams` once the projection handled it completely: the projection stores opacity 1 for an inflated splat, so the draw does not depend on it.
- **`sortBits`.** The number of sort key bits (16, 24, or 32). Sort keys with different numbers of bits in one sort would be ordered incorrectly.

### 2. Each object has its own transform and its own generator

An object can be a file read from arrays, a subset of a file drawn through an index list, or a TSL function that generates splats in the shader (a ring, a particle system, or an effect). A typical subset is a Level-of-Detail (LoD) subset: the splats of a LoD tree chosen for the current camera. Radix does not build LoD trees itself: the app picks the subset and passes its index list (`SplatGenerator.indices`). Each object has its own world transform (its `matrixWorld`: object to world, such as an `Object3D`'s `matrixWorld`), which can change every frame.

One shared set is possible because the projection's output never depends on an object's world transform. Every splat is first transformed into head space (the camera in mono, the XR rig's pose in stereo), and the words store head-relative data: a direction and distance from the head, a rotation and scales in head space, and 2D bounds per eye. The draw reads only the head-to-eye matrices. The sort key is the distance from the head. Therefore any mix of objects with any transforms projects into the same set and sorts correctly, for all four methods.

The per-object transform is applied once per splat, during projection:

- The CPU combines head x object in float64 and uploads one matrix, so objects far from the origin keep their precision.
- A rotation times a uniform scale can be applied directly: it rotates the quaternions and multiplies the scales. Non-uniform scale, shear, and mirrors cannot (a mirror has no rotation quaternion), so they are applied to the covariance: Σ' = M Σ Mᵀ. `isUniformScale` selects the path on the CPU and sets a uniform flag, so dragging a gizmo into a non-uniform scale switches paths without compiling anything.

### 3. Shader compilation is slow, and the same objects are drawn every frame

Compiling a pipeline stalls the frame in which it happens, and a projection program is large (a generator, transforms, a modifier, and a method). A design that compiles every frame, or for every object every frame, is not usable. Therefore:

- **Programs are cached statically by generator.** `SplatProjector` holds one program per generator, modifier (and cov modifier), method, eye count, pass (`full` or `keys`), and backend, shared by every renderer and view. The generator's identity is the cache key, so apps create generators once and keep them.
- **A generator is a program; its data is bound per dispatch.** Before each object's dispatch, `generator.bind(object.data, context)` points the program's readers and uniforms at that object's data: anything its generator accepts, or `{ splats, indices?, shPalette? }` for the stored-splat template. Without this separation, every file and every LoD subset would be a new generator and a new compile. With it, one `SplatGenerator.fromSplats({ remap: "indices" })` program draws every file of a layout through any index list: a new LoD subset is new data, not a new program.
- **The inputs every program shares are static uniforms** (the camera, the params, the object's transforms, and the generator context), set before each dispatch. This is safe because in three r186 each compute node and each render object has its own copy of a uniform's buffer, written when it is dispatched or encoded, and `renderer.compute` submits immediately. The checks confirm this by dispatching one program twice in a frame and drawing two renderers in one render.
- **The modifier space is not in the cache key.** Moving a modifier from view space to world space, or to another frame, changes only the A and B matrices (below), so it compiles nothing.

### 4. Batching across objects is limited

Each object costs one dispatch. Running many objects in one program would reduce dispatches, but WebGPU's baseline allows 16 sampled textures per shader stage, and one stored splat file already uses 2 or more. Batching therefore has to happen in the data, not in the program: a splat atlas stores many objects together in one large `GpuArrays` (like a texture atlas), with a table of per-object matrices, read by a single generator. This fits the model as another generator. It is not built yet; one dispatch per object is sufficient for tens of objects.

### 5. Compute runs before the frame's draws

three.js submits each compute dispatch immediately, but submits a render's draws only when `render()` finishes. Two `SplatRenderer`s in one scene therefore both project and both sort before either one draws. If they shared a projected buffer or a sorter, both would draw the second renderer's results. Therefore each `SplatRenderer` owns its projected splats and its `WgpuSplatSorter`. Only things that are not written per draw are shared: the program cache, the uniforms, and the quad index buffer. Rendering one renderer from several cameras in separate `render()` calls works: each call submits its compute and then its draws, in order.

### 6. WebGL2 has no compute shaders, so its sort arrives late

On WebGPU the sort runs on the GPU in the same frame as the projection, so any collection is drawn immediately. On WebGL2 there is no compute shader to sort with. The fallback computes the sort keys on the GPU (in a fragment pass), reads them back asynchronously, and sorts them on a worker. Sorting never runs on the main thread, because a large sort would drop frames. The resulting order arrives several frames later.

An order is a list of indices into the projected set: index 5,000 means "the 5,000th splat of this exact collection of objects, in this order, with these counts". If an object is added or removed, or changes its count or its LoD subset, the same indices refer to different splats, and drawing with the old order draws the wrong splats. A camera move is different: the order becomes slightly out of date, but every index still refers to the same splat, so a late order is still usable.

The rest of the model follows from this constraint.

### 7. Several viewpoints

Two cameras (split screen, a mirror, a thumbnail, or an offline still) need two orders on WebGL2, because an order is sorted for one camera position. They can also draw different things: their own LoD subsets of the same file, or a different modifier. Most of what a renderer draws is the same for every viewpoint, though, and on WebGPU only the camera differs. Therefore a viewpoint holds only what is its own: its order, and any settings it changes. One XR stereo pair is a single viewpoint, because sort keys are distances from the head and an order is valid for every direction at one position.

### 8. Effects that apply to every splat

Effects such as depth coloring, normal coloring, and a wave in a gizmo's frame should apply to everything a renderer draws, like three.js's `scene.overrideMaterial`, without editing every generator. Switching between them each frame (RGB, then a depth thumbnail) should compile nothing after the first time.

## How the model follows from the constraints

### `SplatCollection`: the collection an order is sorted for

Constraint 6 requires the collection of splats to be a value that can be stored, so that an order can record which collection it belongs to and a viewpoint can keep drawing that collection. A `SplatCollection` is an immutable collection of objects: it makes each object's generator, data, and count read-only on the object itself, without copying, and computes offsets once, so the order of its objects matters.

- **Its identity is its version.** Any structural change (an object added or removed, a new count, or a new index list) is a new `SplatCollection`. Whether an order is for the collection being drawn is checked with `order.collection === collection`. No collection comparison is needed, and there is no counter to keep synchronized.
- **Matrices and params stay live.** They don't change which splat an index refers to, so they are read every render: an object's `matrixWorld` (its world transform) can be an `Object3D.matrixWorld` or a function returning a matrix. Moving an object never creates a new collection, and an old collection that is drawn while a new one is sorted still shows each object at its current position.
- **Splat objects are plain JavaScript objects.** Several renderers and views can share one collection, or build their own from the same generators and data.

### `SplatRenderer`: the settings every viewpoint shares

The scene mesh holds what is the same for every viewpoint: the collection, the method and draw params (constraint 1), per-object param defaults, the modifier (constraint 8), the sort mode, `autoSort`, and its own projected arrays and sorter (constraint 5). In each render it projects its collection for that render's camera, sorts it on the GPU or uses the viewpoint's CPU order, and draws. On WebGPU an app needs nothing more: one renderer can be rendered from any number of cameras.

### `SplatView`: what one viewpoint changes

A view is one viewpoint of a renderer, made on first use by `splatRenderer.viewFor(key)`, where the key is a camera or any value of the app's. It holds the viewpoint's CPU order (constraints 6 and 7) and any settings it changes; unset ones follow the renderer, field by field, and an object's params override both. A render draws the explicit `splatRenderer.view` if the app set one, else its camera's view, else the renderer's own settings.

- **Keyed by camera, made when needed.** With the CPU sort every camera needs an order, so the renderer makes a view for each camera it renders; the app never has to point the renderer at the right view before each render. With the GPU sort no view is made unless the app asks for one.
- **The app chooses the key.** Keying by the camera object breaks down when an app makes cameras anew (a clone per frame): each would make a view. `viewKey(camera)` maps a camera to its view's key (one key for all, or a stable id per viewpoint), and setting `splatRenderer.view` draws one view for every render. Past 32 views made by renders, the renderer warns.
- **Explicit when the camera is not the viewpoint.** Some viewpoints are not one camera object: an XR page renders through the desktop camera, a stereo preview, and the XR camera, all one head. Others are one camera drawn twice with different settings (an RGB and a depth thumbnail). A view of the app's own key, set as `splatRenderer.view`, covers both.
- **What a view cannot change.** The method decides the projected arrays and the draw material, and the sort mode decides between the renderer's GPU sorter and its views' orders, so both stay on the renderer. Two methods take two renderers.

### `SplatOrder` and versions: using every finished sort

In CPU mode a view draws `view.order.collection`, not the current collection. Setting `splatRenderer.collection` (or a view's `collection`) specifies what to draw next; the old collection is still drawn until an order for a newer one is applied. The first frames, before any order exists, draw nothing.

```ts
// The applied order's collection is still drawn
splatRenderer.collection = next;

// Sort keys of `next` computed on the GPU now, sorted on a worker
const view = splatRenderer.viewFor(camera);
const order = await view.sort(camera);

// Drawn from now on, unless a later sort's order is shown
view.apply(order);
```

Several rules for choosing which order to show were considered:

- **Discard orders whose collection is no longer current (rejected).** While the scene keeps changing (a LoD subset recomputed as the camera moves, or objects streaming in), every order would be obsolete by the time it arrives, and nothing new would be shown until the scene stopped changing.
- **Apply any order newer than the shown one**, even if the collection has changed since. The display advances by one sort at a time.
- **"Newer" means started later.** `SplatOrder.version` counts the view's sorts in the order they started. Sorts can finish out of order (on a pool of several workers, a smaller collection finishes first). Once a later sort's order arrives or is applied, an earlier order can never be applied, so it is discarded immediately along with its collection: at most one finished order waits, and an app that never applies one keeps at most one old collection alive.
- **The app runs the sort explicitly, or lets `autoSort` run it.** `sort` and `apply` are separate calls so an app can sort ahead of time and switch when it chooses (the offline still sorts once, then renders). `autoSort` runs the same loop automatically: one sort in flight per view, started when the collection, an object's world transform, or the camera changed, and each order applied as it arrives. Some changes are invisible to it, such as a generator whose splats moved through a uniform; `view.requestSort()` (or `splatRenderer.requestSort()` for every view) asks for a new sort in that case, also with `autoSort` off.
- **One call creates an order.** Apps never handle sort keys themselves: `sort(camera)` runs the sort-keys-only pass, the readback, and the worker sort. The sort-keys pass is a separate cached program with one RGBA8 output, and it skips the projection, because nothing draws that projection.

Sorts run on one worker pool shared by every renderer and view, `SplatRenderer.sortPool`, so views sort in parallel up to its size (`SplatRenderer.sortWorkers`, 4 by default), the number of parallel sorts stays bounded however many renderers and views a page has, and sorts never wait behind file loads in `WorkerPool.default`. It is created on the first CPU sort and makes workers as sorts need them. Alternatively, `sortWorker` points a renderer at a pool the app owns.

### On-demand rendering

An app that renders only when something changed needs to know when Radix has something new to show. With the GPU sort nothing happens between renders, so only the app's own changes matter, and the app knows about those. With the CPU sort an order lands between renders, and the next sort can only start in a render (it needs the render's camera). `onInvalidate(view?)` is called whenever Radix did or was asked to do something that needs a render: an order applied, or a sort requested. The loop then stops by itself: the order lands, the app renders, that render starts another sort only if the camera moved meanwhile, and rendering stops when nothing changes.

### Object releases: freeing what an old collection still uses

Because a viewpoint can keep drawing an old collection for several frames, and sorts can be in flight for collections the app has already replaced, the app cannot know when it is safe to free an index list or a file's arrays. Freeing something that an applied order still draws causes a crash or incorrect output on screen.

A renderer's live collections are:

- its `collection`, and its views' own collections;
- each view's applied order's collection;
- the collections of sorts in flight, and of orders that have arrived but are not applied yet and are newer than the shown one (they can still be applied). The tests found this case.

Therefore an object can have a `release` callback, and Radix calls it once that object is in no live collection of any renderer:

```ts
const subset = SplatCollection.object({
  generator: listed,
  data: { splats, indices },
  count: chosen.length,
  matrixWorld,
  // Return the LoD subset's index list to the pool; the splats stay
  release: () => pool.push(indices),
});
splatRenderer.collection = new SplatCollection([subset]);
```

Radix determines only when to release, which is the part the app can't see. What to free, and how, is up to the app: Radix never looks inside `data` and frees nothing itself.

- **The object is the unit.** The renderers track which objects their live collections hold, so nothing has to be inferred from data of unknown shape. An object listed in several collections, views, or renderers is released after the last of them.
- **An object frees what it owns.** For LoD subsets that is the index list: the original splats behind every subset remain, and the app decides when to free them (when the model is removed and its objects are released). When one object draws a whole file, its release can free the file's arrays (the `/build/examples/splats/index.html` viewer does this).
- **Synchronous, with no promises.** A release runs inside the call that retired the object's last live collection (`apply`, setting a collection, a sort finishing, or `dispose()`), after the bookkeeping, so it can set a collection.
- **Generators' programs.** Garbage collection does not free GPU pipelines; `SplatProjector.dispose(generator)` does. An app that stops using a generator calls it once the generator's objects are released. Apps that create generators once never need to call it.

The first design was a sweep that tracked the generators and data in live collections and freed whatever the app had released once nothing referenced it. Finding what an object uses required looking inside its data, which works only for data shapes Radix knows, and freeing shared resources for the app made Radix responsible for lifetimes it has no information about. Reference counts have the same problem, and the counts can also be wrong.

### Modifiers and their spaces

A renderer's `modifier(splat)` (or `covModifier(cov)`; a view can set its own, or `null` for none) is a TSL function applied to every splat it draws, before projection, so the draw material never changes. It is part of the program cache key, so define it once; switching between a few stored modifiers compiles nothing after the first frame of each.

- **The space is selectable.** Depth and view-dependent normal coloring use view space, height coloring uses world space, an object-local wobble uses object space, and a wave anchored to a gizmo uses that gizmo's frame. Therefore the CPU splits object-to-head into A (object to the modifier's space) and B (that space to head), and the program runs generate, A, modifier, B, and project. Each space is another pair of matrices for the same program. With no modifier, A is the whole transform and B is skipped.
- **Two forms, chosen once per program.** A splat is given as scales and a rotation (`generateSplat`) or as a covariance (`generateCovSplat`). `ewa` reads covariances, and the ray methods read scales and rotation. Converting to a covariance is cheap; converting back requires an eigendecomposition per splat. So instead of declaring a form, a generator implements one or both functions, and the program chooses, for each step, the form that step takes, avoiding conversions where possible. A modifier given in both forms runs in whichever form it receives.
- **A context argument, in each step's own space.** A generator gets `context` (`viewOrigin`, `viewForward`, `objectToHead`, `headToObject`, `objectToWorld`) in the object's space, and a modifier gets the same members in its space. View-dependent color needs the camera in the object's space, which differs per object and per view. The examples first kept a camera in object data or in a global set before each render; both broke when one collection was drawn from two cameras. The renderer already sets each object's transform before its dispatch, so it sets the context uniforms there too, and the argument makes them explicit instead of a hidden global. Per-splat randomness still uses the `index` field of both splat structs. Through a remap it is the source index, so an effect stays on the same splat when a LoD subset changes. Time, light positions, and similar values are the app's own uniforms.
- **Template modifiers are separate.** `SplatGenerator.fromSplats({ modifiers })` applies modifiers in object space as part of one generator, for effects that belong to the object rather than the viewpoint.

## Dropped designs

Each of these designs was considered while developing the model, and each fails one of the constraints above or asks more of the app:

- **A `SplatProjector` instance per source with its own camera-and-model uniforms (the old API).** It works for one file. With many objects, each object needed its own projector and uniforms, and no programs could be shared.
- **A public `ProjectedSplats` collection with `add(source, options)` called per object each frame, or a `collect` / `generate` callback on the renderer.** The app has to repeat the same calls every frame. On WebGL2 the renderer would also have to infer the collection by comparing this frame's calls with the previous frame's, and replay an old frame's calls while a new order is sorted. An explicit immutable collection replaces both the comparison and the replay.
- **Collection version numbers kept by the renderer, and a `settled()` promise for safe disposal.** The collection object's identity is a simpler version, and object releases are synchronous.
- **Reference counts, or a sweep that frees released data and generators for the app.** See object releases above.
- **Views as the only holder of settings, with the renderer pointed at one before each render (`renderer.view = view`).** Every app, WebGPU-only ones too, had to create a view and switch the renderer's view before rendering another camera, though only the CPU order depends on the camera. The renderer now holds the shared settings, and views hold what differs, made per camera when the CPU sort needs them; `splatRenderer.view` remains for an explicit choice.
- **One mesh per camera through `camera.layers`.** This duplicates buffers and scene nodes.
- **A `SplatModifier` object with a context, a `colorOnly` flag, and per-object modifiers.** TSL already removes nodes that don't affect an output, so a color-only modifier costs nothing in the sort-keys pass. A per-object modifier is a generator wrapping another generator.
- **A `form` field on generators, and a `SplatSubset` class.** The functions a generator implements already define its forms, and a subset (such as a LoD subset) is a remap of the index in `fromSplats`, by an index list or any TSL function.
- **A static, shared `WgpuSplatSorter` and projected buffer.** It fails constraint 5.
- **The modifier space in the program cache key.** It changes only matrices.
- **Sorting on the shared worker pool, or on the main thread.** Large file loads would queue ahead of sorts, and a main-thread sort drops frames.

## What this asks of an app

- Create generators and modifier functions once and keep them. A new one every frame causes a compile every frame.
- Change matrices and params in place; create a new `SplatCollection` when the collection of drawn objects changes.
- Set `count` on every object, and free what an object owns in its `release`, not when replacing the collection.
- If the app makes camera objects anew, set `viewKey` (or `view`) so they share views.
- Dispose renderers that are no longer needed (their views go with them), and views of keys that are gone: their live collections keep their objects until then (a warning is logged for a renderer that is garbage-collected without being disposed).
- On WebGL2 (or with `sortMode: "cpu"`), nothing is drawn for a few frames before the first order, and the old collection is drawn for a few frames after each change. `autoSort` handles the sorting, and `onInvalidate` tells an on-demand app when to render.
