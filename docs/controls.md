# Camera controls

`CameraControls` moves a camera (or any object that carries one) from the pointer, touch, keyboard, gamepads, and WebXR controllers, with one `update()` call per frame. Its two modes, orbit and fly, share one state, so switching between them does not move the view. It is based on Spark's SparkControls, and adds a double-press slide.

Code: `src/controls/CameraControls.ts` (imports three.js only; nothing else in Radix imports it).

```ts
const controls = new CameraControls({
  canvas: renderer.domElement,
  object: camera,
  settings: { mode: "orbit" },
});
// Face a point and orbit around it
controls.lookAt(new THREE.Vector3(0, 0, 0));

renderer.setAnimationLoop(() => {
  controls.update(); // true when the camera moved
  renderer.render(scene, camera);
});
```

## Modes and state

The state is the object's pose plus `distance`. The orbit target lies that distance in front of the object (`getTarget()`). Fly mode turns about the camera; orbit mode turns about the target. Switching modes (`controls.mode = "fly"`, or the F key) keeps the pose. Movement is in the object's parent frame, and turns are about `object.up`.

| Input | fly | orbit |
|---|---|---|
| left drag, one finger | look | orbit around the target |
| double press, then drag | slide sideways, forward, and back | the same |
| right drag, two fingers | pan (the scene follows the pointer) | pan, scaled by the distance |
| wheel, middle drag, pinch | move forward and back | zoom between `minDistance` and `maxDistance` |
| WASD / arrows, Q E, PgUp PgDn | move; move down / up | the same |
| Insert Delete, Home End | turn; look up / down | orbit |
| gamepad | left stick moves, right stick looks, LB / RB move down / up, LT slow, RT fast | the same |

- Shift applies `fastMultiplier`, Ctrl `slowMultiplier`, and Caps Lock (while on) `capsMultiplier`, to keys and sticks.
- Keys are ignored while an input, textarea, or select has focus, and released when the window loses focus.
- Inertia is set per input (`settings.inertia`, in seconds). Keys and sticks ease to and from full speed. Pointer looks, pans, and slides keep gliding after release, in both modes: the glide starts at the drag's average speed over its last 100 ms, so a short pause before letting go still glides (more slowly), and a longer pause does not.
- `pointerLock` (fly mode): a click captures the pointer, which then looks without a button held. A click or Esc releases it.
- `pick`: an async lookup of the point under the pointer (for example, a depth readback). While it is set, a right drag in fly mode orbits that point (Shift + right drag pans).
- WebXR (`xr: renderer.xr`, `rig`): while presenting, the left stick moves the rig along the head's horizontal facing, the left trigger and grip move it down and up, the right stick turns it about the head, and the right trigger and grip make movement fast and slow.

## Members

| Member | What it does |
|---|---|
| `new CameraControls({ canvas, object, settings?, xr?, rig? })` | `settings`: the page's defaults over `CameraControls.DEFAULTS`. `xr`: `renderer.xr`. `rig`: the object the XR sticks move (default the object's parent) |
| `update()` | applies the input since the last call; whether the object moved |
| `mode` | `"fly"` or `"orbit"` (`CameraControlsMode`); settable |
| `lookAt(target)` | faces a point and sets `distance` to it |
| `getTarget(out?)` | the orbit target: `distance` in front of the object |
| `distance` | the orbit radius (default 2) |
| `object` | the moved object; settable |
| `enabled` | `false` ignores input (a gizmo drag sets it) |
| `settings` | the current settings; assigning changes them without calling `onChange` |
| `set(partial)` | changes settings |
| `reset()` | goes back to the page's `settings` |
| `onChange` | called after settings change (by `set`, `reset`, or the mode key) |
| `pick` | `(x, y) => Promise<Vector3 \| undefined>`: the point under a canvas position, in CSS pixels |
| `xr`, `rig` | as in the constructor |
| `dispose()` | removes the event listeners |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `mode` | `"fly"` | the starting mode |
| `moveSpeed` | 1 | keys and sticks: meters per second |
| `lookSpeed` | 2 | keys and sticks: radians per second |
| `pointerLookSpeed` | 0.003 | radians per pixel dragged |
| `pointerPanSpeed` | 0.002 | meters per pixel panned or slid (orbit: per unit of distance) |
| `zoomSpeed` | 0.0015 | per wheel unit (a notch is about 100): meters (fly), or a factor of exp(zoomSpeed) (orbit) |
| `minDistance`, `maxDistance` | 0.05, 1000 | the orbit zoom range |
| `fastMultiplier`, `slowMultiplier`, `capsMultiplier` | 5, 0.2, 10 | Shift, Ctrl, and Caps Lock |
| `invertLookX`, `invertLookY` | `true` on touch screens | touch screens drag the scene rather than the view |
| `invertPan`, `invertZoom`, `invertStickY` | `false` | |
| `pointerLock` | `false` | fly mode: a click captures the pointer |
| `inertia` | 0.15 s each | `{ look, move, pointerLook, pointerMove }` (`CameraControlsInertia`): keys and sticks ramp, pointer glide; 0 for none |
| `modeKey` | `"KeyF"` | the key that switches mode (`""` for none) |
| `doublePress` | 300 | milliseconds between two presses that make the second drag slide (0: never) |
| `stickDeadZone` | 0.1 | |
| `xrMoveSpeed`, `xrTurnSpeed` | 1, 4 | XR sticks |

`controls.settings` starts from `CameraControls.DEFAULTS`, then the page's `settings`. Nothing is saved between visits: to keep settings, an app saves them in `onChange` and passes them back as `settings`.

Types: `CameraControlsSettings`, `CameraControlsInertia`, `CameraControlsMode`, and `XrInput` (the part of `renderer.xr` the controls read: `isPresenting` and `getSession()`).

`/build/examples/splats/index.html` binds every setting in its panel (`examples/splats/controlsPane.ts`). The checks are in `test/gpu/controlsTests.ts`.
