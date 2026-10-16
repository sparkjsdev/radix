# Views and CPU orders

A view (`SplatView`) is one viewpoint of a renderer, usually one camera. It holds the settings that this viewpoint overrides on its renderer and, on the CPU sort, the viewpoint's draw order. With the GPU sort a renderer needs no views: make one only to draw some viewpoint differently. With the CPU sort the renderer makes one for each camera it renders, because each viewpoint needs its own order.

Code: `src/render/SplatView.ts`.

```ts
const mini = splatRenderer.viewFor(minimapCamera, {
  collection: lodSubsetFor(minimapCamera),
  objectParams: { blurAmount: 0.5 },
});
// This viewpoint draws without the renderer's modifier
mini.modifier = null;

// The renderer's own settings (or the camera's view)
renderer.render(scene, camera);
// With mini's settings
renderer.render(scene, minimapCamera);
```

## Which view a render draws

1. `splatRenderer.view`, when set. It is used for every render.
2. Otherwise the view of the render's **view key**, `splatRenderer.viewKey(camera)` (by default the camera itself), if one exists.
3. Otherwise, with the GPU sort, no view: the renderer's own settings.
4. Otherwise, with the CPU sort, a new view of that key, made by `viewFor(key)`.

`splatRenderer.viewFor(key, options?)` makes a view on first use and returns it on later calls with the same key, setting `options` on it each time. The key can be a camera or any value of the app's.

## How settings resolve

A view overrides some of its renderer's settings, field by field; unset ones come from the renderer.

| View setting | Unset means | Notes |
|---|---|---|
| `collection` | the renderer's | for example a per-camera LoD subset |
| `params` | the renderer's, per field | a partial `SplatViewParams` |
| `objectParams` | the renderer's, per field | a partial `SplatObjectParams`; each object's `params` override both |
| `modifier`, `covModifier` | the renderer's | `null` draws without the renderer's modifier |
| `modifierSpace` | the renderer's | |
| `sortBits` | the renderer's | |
| `autoSort` | the renderer's | `false` turns it off for this view |

`method` and `sortMode` belong to the renderer only. The method decides the projected arrays and the draw material, and the sort mode decides between the renderer's GPU sorter and its views' orders.

`SplatViewOptions` is the options type of `viewFor`; it has the fields above.

## View keys

If an app creates new camera objects (a clone per frame, a new camera per request), the CPU sort makes a view for each one. Two settings prevent that:

```ts
// Every render shares one view
splatRenderer.viewKey = () => "main";

// Or one view per stable id of the app's
splatRenderer.viewKey = (camera) => camera.userData.slot;

// Or draw one explicit view for every render
splatRenderer.view = splatRenderer.viewFor("main");
```

Once renders have made 32 views, the renderer logs a warning that names these settings (once).

The explicit `view` also covers viewpoints that are not one camera object. An XR page renders one head through the desktop camera, a stereo preview, and the XR camera (`splatRenderer.view = splatRenderer.viewFor("head")`). One camera can also be drawn twice with different settings by switching `view` between renders (an RGB and a depth thumbnail; [recipes.md](recipes.md#thumbnails-with-different-settings)).

## Orders

On the CPU sort, a view draws its applied order, and the collection that order was sorted for:

```ts
const view = splatRenderer.viewFor(camera);
// The view's collection as of now: keys on the GPU, sorted on a worker
const order = await view.sort(camera);
// Drawn from now on, unless an order of a later sort was applied
view.apply(order);
```

| `SplatOrder` field | What it is |
|---|---|
| `collection` | the collection it was sorted for |
| `version` | counts the view's sorts, in the order they started |
| `ordering` | splat indices back to front (a `Uint32Array`) |
| `visible` | the number of them with valid keys; the rest are not drawn |
| `keysMs`, `sortMs` | wall milliseconds of the key pass and readback, and of the worker sort |

The rules for which order is shown:

- **The newest finished sort is shown**, even when the collection has changed since. Each sort shows what was current when it started, so the display advances by one sort at a time while the scene keeps changing.
- **Newer means started later.** Sorts can finish out of order (on a pool of several workers, a smaller collection finishes first). Once an order of a later sort lands or is applied, an earlier one can no longer be applied: `apply` returns `false`, and the order is dropped with its collection. At most one finished order waits.
- `apply` works in cpu mode only. Switching the renderer to `"gpu"` drops every view's orders.
- Hand-made `SplatOrder` objects are refused: an order must come from this view's `sort`.

Until a view's first order is applied, it draws nothing.

## autoSort

`autoSort` runs that loop for each view, so most apps never call `sort` or `apply`. It keeps one sort in flight per view and applies each order as it lands. It starts a sort at a render when:

- the view has no order yet, or its collection or `sortBits` changed;
- the camera moved more than `distance` (world units) since the last sort started;
- with a `sortGuard` set, the camera turned more than `angle` (radians) or its lens changed;
- an object's world transform (`matrixWorld`) changed;
- a sort was requested.

`AutoSort` is `{ distance, angle }`; the default `{ distance: 0, angle: 0 }` re-sorts on any change. `false` turns the loop off; then the view sorts only when asked (`requestSort`) or when the app calls `sort` itself. A view can set its own `autoSort` over the renderer's.

Sort keys are distances from the head, not depths along the view direction, so an order stays valid while the camera only turns. That is why turning re-sorts only with a `sortGuard`, whose band follows the view direction ([sorting.md](sorting.md#sortguard)).

## requestSort

`view.requestSort()` starts a new sort at the view's next render, for changes `autoSort` cannot see: a generator whose splats moved through a uniform, a uniform of the generator that changed which splats are visible. `splatRenderer.requestSort()` asks every view. Both also work with `autoSort: false`, where the view then sorts only when asked. `splatRenderer.requestSort()` only reaches views that already exist, so with `autoSort: false` request a view's first sort through `splatRenderer.viewFor(key).requestSort()`; a view made later, such as one made by its first render, never sorts until asked.

If a sort is in flight, the requested sort starts after it finishes, because the running sort may have read its keys before the change. `requestSort` calls `onInvalidate(view)` unless a sort in flight will call it when its order lands.

## SplatView members

| Member | What it does |
|---|---|
| `key` | the view's key |
| `splats` | its `SplatRenderer` |
| `collection`, `params`, `objectParams`, `modifier`, `covModifier`, `modifierSpace`, `sortBits`, `autoSort` | the settings above |
| `sort(camera)` | a `SplatOrder` of the view's collection from `camera`. In gpu mode, only with the renderer's `sortWorker`, and its orders cannot be applied |
| `apply(order)` | draws `order` from now on (cpu mode); whether it was applied |
| `order` | the applied order |
| `requestSort()` | sort again at the next render |
| `dispose()` | frees the view's arrays and takes it off its renderer; its orders no longer hold their objects |

Views are held by their renderer until `view.dispose()` or `splatRenderer.dispose()`. Dispose the views of cameras or keys the app no longer uses.

## Gotchas

- Do not make a view per frame: use a stable key, `viewKey`, or the explicit `view`.
- A view of another renderer set as `view` throws at the render.
- The promise of a sort in flight rejects when its view or renderer is disposed.
