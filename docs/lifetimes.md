# Lifetimes

When to render, when to free data, and what to dispose. Radix does not free anything the app made and does not read an object's data. It tells the app when a render has something new to show (`onInvalidate`) and when an object is no longer drawn by anything (`release`).

Code: `src/render/SplatRenderer.ts` and `SplatView.ts`.

```ts
const splatRenderer = new SplatRenderer({
  renderer,
  collection,
  onInvalidate: () => requestRender(),
});

splatRenderer.collection = new SplatCollection([
  // Freed once nothing draws it
  SplatCollection.arrays(splats, { matrixWorld, release: () => splats.dispose() }),
]);
```

## On-demand rendering

`onInvalidate(view?)` is called when work that Radix did, or was asked to do, needs a render to be shown:

- an order `autoSort` applied (with the view it is for);
- a `requestSort()` (of a view, or `undefined` for every view of the renderer), unless a sort in flight will call it when its order lands.

It is never called for the app's own changes (a new collection, new params, a moved object), which the app already knows about.

- With the GPU sort, a render shows each change immediately, so only the app's changes need renders.
- With the CPU sort, a render starts a sort, its order lands later, `onInvalidate` asks for the render that shows it, and that render starts another sort only if the camera moved meanwhile. When nothing changes, rendering stops.

## Object releases

An object's `release` runs once, when that object is in no renderer's live collection. A renderer's live collections are:

- its `collection`, and its views' own collections;
- with the CPU sort, each view's applied order's collection;
- the collections of sorts in flight, and of the finished order that can still be applied.

```ts
const indices = SplatGenerator.indices(renderer, chosen, pool.pop());
const object = SplatCollection.object({
  generator: listed,
  data: { splats, indices },
  count: chosen.length,
  matrixWorld,
  // Once nothing draws or sorts this object; the splats stay
  release: () => pool.push(indices),
});
splatRenderer.collection = new SplatCollection([object]);
```

- **An object frees what it owns**: a LoD subset's index list, or a file's arrays when one object draws the whole file. Resources shared by several objects (one file behind many LoD subsets) are freed by the app once all their objects are released.
- **Use the same object wherever it is shared**: in several collections, views, or renderers. It is released after the last of them. To move an object to another renderer, add it to the new one before removing it from the old one.
- **Synchronous**: a release runs inside the call that retired the object's last live collection (`apply`, setting a collection, a sort finishing, or `dispose()`), after the bookkeeping, so it may set a collection itself.
- Only objects that have a `release` are tracked.

On WebGPU an old collection is retired at the next assignment; on the CPU sort it stays live until a newer order is applied, a few frames later. Code that frees data on assignment instead of in `release` crashes or draws garbage on the WebGL2 path.

## Disposal

| Call | What it frees |
|---|---|
| `splatRenderer.dispose()` | the renderer's projected arrays, sorter, material, and its views; objects only it held are released. The shared sort pool (`SplatRenderer.sortPool`) stays for other renderers. It also hides the renderer (`visible = false`), and `prepare` or a render of it does nothing, so one left in the scene costs nothing and makes no GPU resources again. Remove it from the scene too |
| `view.dispose()` | the view's order and key arrays; takes it off its renderer, releasing objects only it held |
| `SplatProjector.dispose(generator)` | a generator's compiled programs, once no live collection uses it. Garbage collection does not free GPU pipelines. Apps that make generators once never need this |
| `arrays.dispose()` | a `GpuArrays`'s textures: an object's `release` is the place for it |
| `pool.dispose()` | a `WorkerPool`'s workers; later calls reject instead of making new ones |

A renderer that is garbage-collected without `dispose()` logs a console warning, and its objects are released at that point. Dispose renderers explicitly: the warning means GPU memory was held longer than needed.

## Gotchas

- Views are held until disposed. On the CPU sort, each new camera object gets a new view, and they pile up; use `viewKey` ([views.md](views.md#view-keys)).
- A sort in flight when its view or renderer is disposed rejects its promise, makes no worker, and keeps no key arrays. A renderer disposes its views at once, and a view's sort checks for that after each step that waits (the key readback, the worker sort), so a sort never reaches a disposed renderer. An autoSort that ends this way is not reported.
- Showing a disposed renderer again (`visible = true`) makes three draw its disposed material, as with any disposed three.js mesh: make a new renderer instead.
- `release` may run later than expected on the CPU sort (an old order is still shown), and never if the object is still in some renderer. Check both when debugging leaks.
