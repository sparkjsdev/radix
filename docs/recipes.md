# Recipes

Short solutions to common tasks. Most come from `/build/examples/scenes/index.html` (`examples/scenes/scenes.ts`), where each one runs on both backends. They assume a `renderer`, `scene`, and `camera` as in [quickstart.md](quickstart.md).

## Several files in one sort

Objects that overlap must be drawn by one renderer, so they are sorted together:

```ts
const [a, b] = await Promise.all([loadSplats(urlA), loadSplats(urlB)]);
const splatsA = GpuArrays.fromData(renderer, a);
const splatsB = GpuArrays.fromData(renderer, b);

const left = new THREE.Object3D();
const right = new THREE.Object3D();
left.position.x = -1;
right.position.x = 1;
scene.add(left, right);

const collection = new SplatCollection([
  SplatCollection.arrays(splatsA, { matrixWorld: left.matrixWorld }),
  SplatCollection.arrays(splatsB, { matrixWorld: right.matrixWorld }),
]);
const splatRenderer = new SplatRenderer({ renderer, collection });
scene.add(splatRenderer);
```

Files of the same layout share one program. The same arrays can be listed twice, with two matrices, to draw two copies.

## Moving, scaling, and animating objects

An object's `matrixWorld` is read every render: move its `Object3D`, or pass a function.

```ts
// In the frame loop
left.rotation.y = seconds * 0.4;

// Or a function that returns the matrix
const bob = new THREE.Matrix4();
const object = {
  generator,
  count,
  matrixWorld: () => bob.makeTranslation(0, Math.sin(time.value) * 0.15, 0),
};
```

Moving an object never needs a new collection. A non-uniform scale or a mirror is applied to each splat's covariance, without compiling anything ([generators.md](generators.md#transforms)). On the CPU sort, a moved object re-sorts its view (`autoSort` checks each object's matrix).

## Splats generated in a shader

```ts
const { cos, float, sin, uint, uniform, vec3, vec4 } = TSL;
const time = uniform(0);

const ring = (count: number): SplatGenerator => ({
  generateSplat: (index) => {
    const t = float(index).div(count);
    const angle = t.mul(Math.PI * 2).add(time.mul(0.3));
    const wave = sin(t.mul(Math.PI * 24).add(time.mul(2))).mul(0.06);
    const center = vec3(cos(angle), wave, sin(angle));
    const scales = vec3(0.008, 0.008, 0.004);
    const quat = vec4(0, 0, 0, 1);
    const rgb = vec3(t, sin(t.mul(Math.PI)), float(1).sub(t));
    return GpuSplats.Splat(center, scales, quat, rgb, float(0.9), uint(index));
  },
});

// Make it once
const ringGenerator = ring(4000);
splatRenderer.collection = new SplatCollection([
  ...files,
  { generator: ringGenerator, count: 4000, matrixWorld: ringObject.matrixWorld },
]);

// Each frame: time.value = seconds
```

It is sorted with the files around it. On the CPU sort, call `splatRenderer.requestSort()` when its splats have moved enough, because the CPU sort doesn't detect uniform changes ([generators.md](generators.md#custom-generators)).

## A subset chosen per camera

Draw some of a file's splats (the nearest, a LoD subset, the ones in a box) through an index list, pooled and returned in each object's `release`:

```ts
// Made once: one program for every list
const listed = SplatGenerator.fromSplats({ remap: "indices" });
const pool: GpuArrays[] = [];

// Called with each new subset, for example when the camera moved enough
function choose(chosen: Uint32Array) {
  const indices = SplatGenerator.indices(renderer, chosen, pool.pop());
  const object = SplatCollection.object({
    generator: listed,
    data: { splats, indices },
    count: chosen.length,
    matrixWorld: model.matrixWorld,
    // Once nothing draws or sorts this object
    release: () => pool.push(indices),
  });
  splatRenderer.collection = new SplatCollection([object]);
}
```

The pool settles at two or three lists: on the CPU sort an old list stays in use until a newer order is applied. A procedural subset needs no list: `SplatGenerator.fromSplats({ remap: (i) => i.mul(uint(4)) })` draws every fourth splat.

## An effect on every splat

```ts
const tint = (rgb: (s: SplatNode) => TslNode): SplatModifier => (s) => {
  const out = s.toVar();
  out.get("rgb").assign(rgb(s));
  return out;
};

const height = tint((s) => {
  const y = clamp(s.get("center").y.mul(0.8).add(0.5), 0, 1);
  return mix(vec3(0.1, 0.3, 1), vec3(1, 0.3, 0.1), y);
});
const normals = tint((s) => abs(GpuSplats.normalOf(s)));

// Made once each: switching compiles nothing after the first use
splatRenderer.modifier = height;
splatRenderer.modifierSpace = "world";
```

`modifierSpace` picks the space the modifier sees: `"view"` (depth, view-dependent effects), `"world"`, `"object"`, or a frame's `matrixWorld`, so a gizmo can move a wave around ([generators.md](generators.md#modifiers)).

## Split screen: two cameras

One renderer draws any number of cameras. A view gives one of them settings of its own:

```ts
const otherView = splatRenderer.viewFor(otherCamera, {
  // The same objects, fewer of them
  collection: new SplatCollection([rightObject, ringObject]),
  modifier: tint((s) => mix(s.get("rgb"), vec3(1, 0.55, 0.15), 0.5)),
});

renderer.autoClear = false;
renderer.clear();
renderer.setScissorTest(true);
for (const [x, cam] of [[0, camera], [1, otherCamera]] as const) {
  renderer.setViewport(x * width / 2, 0, width / 2, height);
  renderer.setScissor(x * width / 2, 0, width / 2, height);
  renderer.render(scene, cam);
}
renderer.setScissorTest(false);
renderer.autoClear = true;
```

On WebGPU, `scene.background` clears the whole canvas in each render, scissor or not: clear once with `setClearColor` and draw both halves without a background. On the CPU sort each camera gets its own view and order automatically.

## Thumbnails with different settings

This draws one camera twice with different settings. Each setting has a view under a key chosen by the app, selected with `splatRenderer.view` before each render.

```ts
const thumbs = [
  // Without the renderer's modifier
  splatRenderer.viewFor("thumb rgb", { modifier: null }),
  splatRenderer.viewFor("thumb depth", {
    modifier: depth,
    modifierSpace: "view",
  }),
];

thumbs.forEach((view, i) => {
  splatRenderer.view = view;
  renderer.setRenderTarget(targets[i]);
  renderer.render(scene, thumbCamera);
});

splatRenderer.view = undefined;
renderer.setRenderTarget(null);
renderer.render(scene, camera);
```

## An offline still

This renders a still at a fixed size on either backend, with the order sorted for its camera. It uses a separate renderer with the CPU sort, sorts once, and renders once.

```ts
async function still(width: number, height: number) {
  const cam = camera.clone();
  cam.aspect = width / height;
  cam.updateProjectionMatrix();

  const stillSplats = new SplatRenderer({
    renderer,
    collection,
    sortMode: "cpu",
    autoSort: false,
    method: "raygs",
  });
  const stillScene = new THREE.Scene().add(stillSplats);
  const target = new THREE.RenderTarget(width, height);

  try {
    const view = stillSplats.viewFor(cam);
    view.apply(await view.sort(cam));

    renderer.setRenderTarget(target);
    renderer.render(stillScene, cam);
    renderer.setRenderTarget(null);
    // WebGL2 rows are bottom up
    return await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  } finally {
    target.dispose();
    stillSplats.dispose();
  }
}
```

The collection is shared with the live renderer; its objects are released only after both renderers stop using them.

## Render only when needed

```ts
// Set it after the app's own changes too
let needsRender = true;
const splatRenderer = new SplatRenderer({
  renderer,
  collection,
  onInvalidate: () => (needsRender = true),
});

renderer.setAnimationLoop(() => {
  const moved = controls.update();
  if (moved || needsRender) {
    needsRender = false;
    renderer.render(scene, camera);
  }
});
```

On the CPU sort, `onInvalidate` asks for the renders that show each landed order; rendering stops once nothing changes ([lifetimes.md](lifetimes.md#on-demand-rendering)).

## One code path for both backends

The app needs no separate code for WebGL2: `createRenderer` picks the backend, and the renderer picks `sortMode`. Test the WebGL2 path with `?gpu=webgpu-gl`, or with `sortMode: "cpu"` on WebGPU. The differences an app may need to handle:

- the first frames draw nothing until the first order lands, and a new collection shows a few frames after it is set;
- free data in `release`, not when replacing a collection;
- give cameras made anew a stable `viewKey`;
- set `objectParams.sortGuard` (0.5) for large scenes.

## Save and export

```ts
// The format: "spz", "ply", "compressed-ply", "rad", or "rdx"
const bytes = await writeSplats(data, "spz", { version: 3 });

const link = Object.assign(document.createElement("a"), {
  href: URL.createObjectURL(new Blob([bytes])),
  download: "scene.spz",
});
link.click();
```

To save the GPU's copy (for example after a writer has edited it), read it back first: `const data = await arrays.read()`. Every format writes the table's spherical harmonics too (`sh: false` leaves them out). Compressed PLY clamps them to ±4 and SPZ to ±1; PLY and RDX keep them exactly ([files.md](files.md#what-each-format-keeps)). For SPZ, `version: 4` writes SPZ 4 (`NGSP` header, zstd) for readers that need it. Version 3 is about as small and more widely supported ([files.md](files.md#spz)).

## Change a scan's axes

SPZ files record their axes (`meta.coordinateSystem`, `"RUB"` by default). Convert while loading, or convert any table later; SH is converted too:

```ts
// y up, z toward the viewer (three.js), whatever the file holds
const splats = await loadSplats("scan.spz", { coordinateSystem: "RUB" });

// A PLY in the usual y-down, z-forward axes, turned in place
const ply = await loadSplats("scan.ply");
Axes.convert(ply, "RUB", { from: "RDF" });

// One splat, or a few values
const c = Axes.converter("RFU", "RUB");
c.splat(splat);
c.sh(coeffs, 3);
```

Pass `shPalette` to `Axes.convert` to convert a palette's entries too. Flips are exact; quarter turns mix the coefficients within each SH band ([files.md](files.md#coordinate-systems)).

## A view-dependent effect

A generator reads the camera position from its `context`, in the object's space, so the effect works for any view and placement:

```ts
const { dot, max, normalize, pow } = TSL;
const base = SplatGenerator.fromSplats();

// Splats facing away from the camera glow at their rims
const rim: SplatGenerator<StoredSplats> = {
  generateSplat(i, context = SplatGenerator.context) {
    const s = base.generateSplat!(i, context).toVar();
    const toCamera = normalize(context.viewOrigin.sub(s.get("center")));
    const facing = max(dot(GpuSplats.normalOf(s), toCamera).abs(), 0);
    s.get("rgb").addAssign(pow(facing.oneMinus(), 3).mul(0.5));
    return s;
  },
  bind: (data, context) => base.bind!(data, context),
};
```

The same `context.viewOrigin` drives stored spherical harmonics: a `GpuShReader` adds them in a generator of your own ([sh.md](sh.md#in-your-own-generator)).

## Stream a large file

Save it as a chunked RDX (`RdxFile.encodeFiles`, or `npm run convert:ply -- in.ply out.rdx`), then upload chunk by chunk and draw what has arrived ([rdx.md](rdx.md#streaming-into-the-gpu)).

## Time each step

```ts
const renderer = await createRenderer({ profile: true });
const profiler = renderer.inspector as GpuProfiler;
splatRenderer.phase = (name, run) => profiler.phase(name, run);
```

[renderer.md](renderer.md#gpuprofiler) shows the frame loop; [performance.md](performance.md) lists the settings worth changing.
