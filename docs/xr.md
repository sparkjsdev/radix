# WebXR and stereo

Radix projects every splat once for both eyes of an XR frame, and sorts once for both, because sort keys are distances from the head and stay valid in every direction. WebXR runs on either backend: WebGPU through the WebXR / WebGPU binding (`XRGPUBinding`), with the GPU sort every frame, or the WebGL2 backend's XR, with the CPU sort on a worker.

Code: `src/render/splatCamera.ts` (the head and eyes); the example page `examples/xr/main.ts` (`/build/examples/xr/index.html`).

```ts
// An XR-compatible WebGPU adapter
const renderer = await createRenderer({ xr: true });
renderer.xr.setFramebufferScaleFactor(1);

const splatRenderer = new SplatRenderer({ renderer, collection });
// One viewpoint for every camera that shows the head
splatRenderer.view = splatRenderer.viewFor("head");
scene.add(splatRenderer);

const session = await navigator.xr.requestSession("immersive-vr", {
  requiredFeatures: ["webgpu", "local-floor"],
});
await renderer.xr.setSession(session);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
```

## Head and eyes

three renders an XR frame through an `ArrayCamera` with one camera per eye. Radix splits the work:

- **The head** is the camera in mono and the XR rig's pose in stereo. Splats are transformed into head space, and what both eyes share is computed once: the center (as a direction and distance from the head), color, opacity, rotation and scales, and the anti-aliasing inflation.
- **Each eye** computes only what differs: its 2D bound or, for `raygs`, its quad's frame, through the head-to-eye matrix.
- **One sort** orders the splats for both eyes.

Only the draw doubles. In the emulator, a stereo frame took about 1.15x the time of a mono frame, with one projection pass and one sort. The words per splat grow from 4 to 8 for `ewa`, from 8 to 10 for `3dgut` and `htgs`, and from 7 to 10 for `raygs` ([projection.md](projection.md#words)).

A stereo preview on the desktop takes the same path: render through an `ArrayCamera` of two cameras with viewports side by side (`/build/examples/xr/index.html?stereo=1`).

## One view for the head

An XR page renders one head through several camera objects: the desktop camera before a session, a stereo preview, and three's XR camera during one. On the CPU sort each camera object would make its own view and its own sort. Set one explicit view instead:

```ts
splatRenderer.view = splatRenderer.viewFor("head");
```

## WebGPU XR

- `createRenderer({ xr: true })` requests an XR-compatible adapter and enables `renderer.xr`. Ask for the session with `requiredFeatures: ["webgpu", ...]`.
- The GPU sort runs every frame, so the order always matches the current head pose.
- Status: written against the WebXR / WebGPU binding; not yet verified on headset hardware. The emulators (the Immersive Web Emulator extension and the `iwer` runtime) offer no `XRGPUBinding`, so they exercise the WebGL2 path.

## WebGL2 XR

The WebGL2 backend's XR uses the CPU sort. The order lags the head by a few frames:

- Set `objectParams.sortGuard` (0.5 works well) so the sort and the draw skip splats well outside the view. In the emulator, in a cave scene, this raised the frame rate from 96-101 fps to 134-139 fps.
- Re-sort on head turns as well as moves: `autoSort` does when a guard is set (`angle`, in radians), or sort manually with `autoSort: false`, `view.sort(camera)`, and `view.apply(order)` (`/build/examples/xr/index.html` re-sorts after 2 cm or 5 degrees).
- `createRenderer({ multiview: true })` draws both eyes in one draw where `OVR_multiview2` exists.
- Use `splatRenderer.prepare(camera)` before the render when profiling: it projects outside the render's passes, so WebGL2 timer queries do not nest.

## Controls

`CameraControls` moves an XR rig with the controllers while presenting: pass `xr: renderer.xr` and `rig` (default: the camera's parent, whose parent must be the scene). The left stick moves along the head's horizontal facing, the left trigger and grip move down and up, the right stick turns about the head, and the right trigger and grip are fast and slow ([controls.md](controls.md)).

## /build/examples/xr/index.html

The example page reads its options from the URL and from `radixXr.configure()`: `url`, `layout`, `method`, `bits`, `sort` (`gpu` or `cpu`), `gpu` (`webgpu` or `webgpu-gl`), `xrScale` (the eye-buffer scale), `multiview`, `stereo`, `profile`, `threshold` (the re-sort distance), and `guard` (the `sortGuard`). `radixXr.measure({ seconds, turn })` turns the head and returns frame rates, GPU time per phase, and sort statistics.

## Gotchas

- The emulators ignore the framebuffer scale and have no multiview layer: measure `xrScale` and `multiview` on a headset.
- Headset GPUs (Qualcomm Adreno 7xx, the Quest 3's family) mostly report the 128 MiB minimum storage binding size, so the GPU sort holds at most 32M keys there.
- Captures are usually y-down: place them with a half turn about x, in meters, in the session's reference space (`local-floor`).
