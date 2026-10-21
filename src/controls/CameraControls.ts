// Based on Spark's SparkControls
import * as THREE from "three";

/** Fly turns about the camera, and orbit about the target in front of it. */
export type CameraControlsMode = "fly" | "orbit";

/** The inertia of keys, sticks and pointer glides. */
export interface CameraControlsInertia {
  /**
   * Seconds for keys and sticks to reach or leave full turn speed, or 0 for
   * none.
   *
   * @default 0.15
   */
  look: number;
  /**
   * Seconds for keys and sticks to reach or leave full speed, or 0 for none.
   *
   * @default 0.15
   */
  move: number;
  /**
   * Seconds a pointer turn glides on after release, or 0 for none.
   *
   * @default 0.15
   */
  pointerLook: number;
  /**
   * Seconds a pointer pan or slide glides on after release, or 0 for none.
   *
   * @default 0.15
   */
  pointerMove: number;
}

/** The settings of CameraControls. */
export interface CameraControlsSettings {
  /**
   * The current mode.
   *
   * @default "fly"
   */
  mode: CameraControlsMode;
  /**
   * The speed of keys and sticks, in meters per second.
   *
   * @default 1
   */
  moveSpeed: number;
  /**
   * The turn speed of keys and sticks, in radians per second.
   *
   * @default 2
   */
  lookSpeed: number;
  /**
   * Radians turned per pixel dragged.
   *
   * @default 0.003
   */
  pointerLookSpeed: number;
  /**
   * Meters panned or slid per pixel, per unit of distance in orbit mode.
   *
   * @default 0.002
   */
  pointerPanSpeed: number;
  /**
   * The zoom per wheel unit, about 100 to a notch: meters in fly mode, a factor
   * of exp(zoomSpeed) in orbit mode.
   *
   * @default 0.0015
   */
  zoomSpeed: number;
  /**
   * The closest orbit distance, in meters.
   *
   * @default 0.05
   */
  minDistance: number;
  /**
   * The farthest orbit distance, in meters.
   *
   * @default 1000
   */
  maxDistance: number;
  /**
   * The speed factor of Shift and the fast gamepad and XR buttons.
   *
   * @default 5
   */
  fastMultiplier: number;
  /**
   * The speed factor of Ctrl and the slow gamepad and XR buttons.
   *
   * @default 0.2
   */
  slowMultiplier: number;
  /**
   * The speed factor while Caps Lock is on.
   *
   * @default 10
   */
  capsMultiplier: number;
  /**
   * Inverts horizontal pointer turns.
   *
   * @default true in mobile browsers, else false
   */
  invertLookX: boolean;
  /**
   * Inverts vertical pointer turns.
   *
   * @default true in mobile browsers, else false
   */
  invertLookY: boolean;
  /**
   * Inverts pans and slides.
   *
   * @default false
   */
  invertPan: boolean;
  /**
   * Inverts zooming.
   *
   * @default false
   */
  invertZoom: boolean;
  /**
   * Inverts the gamepad's look stick vertically.
   *
   * @default false
   */
  invertStickY: boolean;
  /**
   * In fly mode, a click captures the pointer for looking until a click or Esc.
   *
   * @default false
   */
  pointerLock: boolean;
  inertia: CameraControlsInertia;
  /**
   * The KeyboardEvent.code that switches mode, or "" for none.
   *
   * @default "KeyF"
   */
  modeKey: string;
  /**
   * Milliseconds between two presses that make the second drag slide, or 0 for
   * never.
   *
   * @default 300
   */
  doublePress: number;
  /**
   * Stick values below this fraction of the travel count as 0.
   *
   * @default 0.1
   */
  stickDeadZone: number;
  /**
   * The speed of the XR sticks, in meters per second.
   *
   * @default 1
   */
  xrMoveSpeed: number;
  /**
   * The turn speed of the XR sticks, in radians per second.
   *
   * @default 4
   */
  xrTurnSpeed: number;
}

/** The part of renderer.xr that the controls read. */
export interface XrInput {
  isPresenting: boolean;
  getSession(): XRSession | null;
}

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, -1], KeyS: [0, 0, 1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0], KeyE: [0, 1, 0], KeyQ: [0, -1, 0],
  ArrowUp: [0, 0, -1], ArrowDown: [0, 0, 1], ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0], PageUp: [0, 1, 0], PageDown: [0, -1, 0],
};
// Yaw right, pitch up
const LOOK_KEYS: Record<string, [number, number]> = { Insert: [-1, 0], Delete: [1, 0], Home: [0, 1], End: [0, -1] };

const Y = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const MAX_PITCH = Math.PI / 2 - 1e-4;
// A released drag glides at its average speed over this many milliseconds
const RELEASE_WINDOW = 100;
// Pixels per second
const GLIDE_STOP = 0.5;

interface Pointer {
  x: number;
  y: number;
  button: number;
  touch: boolean;
  // Orbits the picked point
  pivots: boolean;
  // Started by a double press
  slides: boolean;
}

/**
 * Orbit and fly camera controls for pointer, touch, keys, gamepads and WebXR.
 *
 * Fly turns about the camera, orbit about the target distance ahead, both in
 * the parent frame. Switching mode keeps the view.
 *
 * - Left drag, one finger: look, or orbit the target.
 * - Double press, then drag: slide.
 * - Right drag, two fingers: pan. In fly mode with pick set, orbit the picked
 *   point.
 * - Wheel, middle drag, pinch: move forward and back, or zoom.
 * - WASD, arrows, Q, E, PgUp, PgDn: move. Shift is fast, Ctrl slow, Caps Lock
 *   faster.
 * - Insert, Delete: turn. Home, End: look up and down. F: switch mode.
 * - Gamepad: left stick moves, right stick looks, LB and RB move down and up,
 *   LT and RT are slow and fast.
 * - WebXR: left stick moves, right stick turns, left trigger and grip move up
 *   and down, right trigger and grip are fast and slow.
 */
export class CameraControls {
  static readonly DEFAULTS: CameraControlsSettings = {
    mode: "fly",
    moveSpeed: 1,
    lookSpeed: 2,
    pointerLookSpeed: 0.003,
    pointerPanSpeed: 0.002,
    zoomSpeed: 0.0015,
    minDistance: 0.05,
    maxDistance: 1000,
    fastMultiplier: 5,
    slowMultiplier: 0.2,
    capsMultiplier: 10,
    // Touch screens drag the scene
    invertLookX: isMobile(),
    invertLookY: isMobile(),
    invertPan: false,
    invertZoom: false,
    invertStickY: false,
    pointerLock: false,
    inertia: { look: 0.15, move: 0.15, pointerLook: 0.15, pointerMove: 0.15 },
    modeKey: "KeyF",
    doublePress: 300,
    stickDeadZone: 0.1,
    xrMoveSpeed: 1,
    xrTurnSpeed: 4,
  };

  readonly canvas: HTMLCanvasElement;
  /** The camera, or an object carrying it. */
  object: THREE.Object3D;
  /**
   * The current settings. Assigning them skips onChange.
   */
  settings: CameraControlsSettings;
  /**
   * The orbit radius, in meters.
   *
   * @default 2
   */
  distance = 2;
  /**
   * Whether input moves the object.
   *
   * @default true
   */
  enabled = true;
  /** Called after set, reset or the mode key change the settings. */
  onChange?: (settings: CameraControlsSettings) => void;
  /** The XR manager whose controllers move the rig while presenting. */
  xr?: XrInput;
  /**
   * What the XR sticks move. Its parent must be the scene.
   *
   * @default the object's parent
   */
  rig?: THREE.Object3D;
  /**
   * The point under a canvas position in CSS pixels, in the parent frame, which
   * a fly-mode right drag orbits.
   */
  pick?: (x: number, y: number) => Promise<THREE.Vector3 | undefined>;

  private pageDefaults: CameraControlsSettings;
  // The right drag's pivot, its look delta in pixels, and the drag a pick is for
  private pivot?: THREE.Vector3;
  private pivotLook = new THREE.Vector2();
  private pivotDrag = 0;
  private pointers = new Map<number, Pointer>();
  private lastPress = -Infinity;
  private keys = new Set<string>();
  private capsLock = false;
  // Since the last update: look, pan and slide (z) in pixels, zoom in wheel units
  private look = new THREE.Vector2();
  private pan = new THREE.Vector3();
  private zoom = 0;
  private keyLookVelocity = new THREE.Vector2();
  private keyMoveVelocity = new THREE.Vector3();
  // Pixels per second
  private pointerLookVelocity = new THREE.Vector2();
  private pointerPanVelocity = new THREE.Vector3();
  // In event time, so frames without an event do not stop the glide
  private dragStart = 0;
  private dragMoves: { time: number; look: THREE.Vector2; pan: THREE.Vector3 }[] = [];
  private lastTime?: number;
  private abort = new AbortController();

  /**
   * Starts reading input from the canvas and the document.
   *
   * @param options.object The camera, or an object carrying it.
   * @param [options.settings] The page's defaults over CameraControls.DEFAULTS.
   * @param [options.xr] renderer.xr, for moving the rig with XR controllers.
   * @param [options.rig=object.parent] What the XR sticks move. Its parent must
   *   be the scene.
   */
  constructor({ canvas, object, settings, xr, rig }: {
    canvas: HTMLCanvasElement;
    object: THREE.Object3D;
    settings?: Partial<CameraControlsSettings>;
    xr?: XrInput;
    rig?: THREE.Object3D;
  }) {
    this.canvas = canvas;
    this.object = object;
    this.xr = xr;
    this.rig = rig;
    this.pageDefaults = mergeSettings(CameraControls.DEFAULTS, settings ?? {});
    this.settings = mergeSettings(this.pageDefaults, {});

    const signal = this.abort.signal;
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event), { signal });
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event), { signal });
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event), { signal });
    canvas.addEventListener("pointercancel", (event) => this.pointerUp(event), { signal });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoom += event.deltaY * (event.deltaMode === 1 ? 33 : 1);
      this.pan.x -= event.deltaX;
    }, { passive: false, signal });
    document.addEventListener("keydown", (event) => this.keyDown(event), { signal });
    document.addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
      this.capsLock = event.getModifierState("CapsLock");
    }, { signal });
    window.addEventListener("blur", () => this.keys.clear(), { signal });
  }

  dispose() {
    this.abort.abort();
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }

  /**
   * The current mode. Switching keeps the view.
   */
  get mode(): CameraControlsMode {
    return this.settings.mode;
  }

  set mode(mode: CameraControlsMode) {
    this.set({ mode });
  }

  /** Changes some settings and calls onChange. */
  set(settings: Partial<CameraControlsSettings>) {
    this.settings = mergeSettings(this.settings, settings);
    if (this.settings.mode !== "fly" && document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
    this.onChange?.(this.settings);
  }

  /** Goes back to the settings the page passed, and calls onChange. */
  reset() {
    this.settings = mergeSettings(this.pageDefaults, {});
    this.onChange?.(this.settings);
  }

  /** Returns the orbit target, in the parent frame. */
  getTarget(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(FORWARD).applyQuaternion(this.object.quaternion).multiplyScalar(this.distance).add(this.object.position);
  }

  /**
   * Faces a point and orbits it.
   *
   * @param target The point to face, in the parent frame.
   */
  lookAt(target: THREE.Vector3) {
    const position = this.object.position;
    this.distance = THREE.MathUtils.clamp(position.distanceTo(target), this.settings.minDistance, this.settings.maxDistance);
    const up = upFrame(this.object);
    const d = target.clone().sub(position).normalize().applyQuaternion(up.clone().invert());
    const e = new THREE.Euler(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), Math.atan2(-d.x, -d.z), 0, "YXZ");
    this.object.quaternion.setFromEuler(e).premultiply(up);
  }

  /**
   * Applies the input since the last call. Call it once per frame.
   *
   * @return Whether the object moved.
   */
  update(): boolean {
    const now = performance.now();
    const dt = (now - (this.lastTime ?? now)) / 1000;
    // A frame of no time keeps its input for the next
    if (!(dt > 0)) {
      this.lastTime ??= now;
      return false;
    }
    this.lastTime = now;
    if (!this.enabled) {
      this.clearInput();
      return false;
    }
    if (this.xr?.isPresenting) {
      this.clearInput();
      return this.updateXr(dt);
    }

    const s = this.settings;
    const orbit = s.mode === "orbit";

    const moveInput = new THREE.Vector3();
    const lookInput = new THREE.Vector2();
    for (const code of this.keys) {
      const move = MOVE_KEYS[code];
      if (move) {
        moveInput.add(new THREE.Vector3(...move));
      }
      const look = LOOK_KEYS[code];
      if (look) {
        lookInput.add(new THREE.Vector2(...look));
      }
    }
    let speed = 1;
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) {
      speed *= s.fastMultiplier;
    }
    if (this.keys.has("ControlLeft") || this.keys.has("ControlRight")) {
      speed *= s.slowMultiplier;
    }
    if (this.capsLock) {
      speed *= s.capsMultiplier;
    }

    const gamepad = navigator.getGamepads?.().find((pad) => pad?.connected);
    if (gamepad) {
      const dead = (value = 0) => (Math.abs(value) >= s.stickDeadZone ? value : 0);
      moveInput.x += dead(gamepad.axes[0]);
      moveInput.z += dead(gamepad.axes[1]);
      moveInput.y += (gamepad.buttons[5]?.value ?? 0) - (gamepad.buttons[4]?.value ?? 0);
      lookInput.x += dead(gamepad.axes[2]);
      lookInput.y -= dead(gamepad.axes[3]) * (s.invertStickY ? -1 : 1);
      speed *= THREE.MathUtils.lerp(1, s.slowMultiplier, gamepad.buttons[6]?.value ?? 0);
      speed *= THREE.MathUtils.lerp(1, s.fastMultiplier, gamepad.buttons[7]?.value ?? 0);
    }

    // Pans follow the pointer at the orbit distance
    const scale = orbit ? this.distance : 1;
    ease(this.keyMoveVelocity, moveInput.multiplyScalar(s.moveSpeed * speed), s.inertia.move, dt);
    ease(this.keyLookVelocity, lookInput.multiplyScalar(s.lookSpeed), s.inertia.look, dt);

    // pointerUp sets the glide, and a held pointer stops it
    if (this.pointers.size > 0 || this.locked()) {
      this.pointerLookVelocity.set(0, 0);
      this.pointerPanVelocity.set(0, 0, 0);
    } else {
      this.pointerLookVelocity.multiplyScalar(decay(s.inertia.pointerLook, dt));
      this.pointerPanVelocity.multiplyScalar(decay(s.inertia.pointerMove, dt));
      if (this.pointerLookVelocity.lengthSq() < GLIDE_STOP * GLIDE_STOP) {
        this.pointerLookVelocity.set(0, 0);
      }
      if (this.pointerPanVelocity.lengthSq() < GLIDE_STOP * GLIDE_STOP) {
        this.pointerPanVelocity.set(0, 0, 0);
      }
    }
    const lookDelta = this.look.clone().addScaledVector(this.pointerLookVelocity, dt)
      .multiply(new THREE.Vector2(s.invertLookX ? -1 : 1, s.invertLookY ? -1 : 1)).multiplyScalar(s.pointerLookSpeed);
    const panDelta = this.pan.clone().addScaledVector(this.pointerPanVelocity, dt).multiplyScalar(s.pointerPanSpeed * scale * (s.invertPan ? -1 : 1));
    const zoom = this.zoom * s.zoomSpeed * (s.invertZoom ? -1 : 1);
    this.look.set(0, 0);
    this.pan.set(0, 0, 0);
    this.zoom = 0;

    // Yaw right and pitch up, in radians
    const yaw = lookDelta.x + this.keyLookVelocity.x * dt;
    const pitch = -lookDelta.y + this.keyLookVelocity.y * dt;
    const move = this.keyMoveVelocity.clone().multiplyScalar(dt);
    move.x -= panDelta.x;
    move.y += panDelta.y;
    move.z += panDelta.z;

    const object = this.object;
    const before = object.position.clone();
    const beforeQuaternion = object.quaternion.clone();
    // Before the zoom changes the distance
    const target = this.getTarget();
    if (orbit) {
      this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(zoom), s.minDistance, s.maxDistance);
    } else {
      move.z += zoom;
    }

    if (yaw !== 0 || pitch !== 0) {
      turn(object, yaw, pitch);
    }
    if (orbit) {
      object.position.copy(target).addScaledVector(FORWARD.clone().applyQuaternion(object.quaternion), -this.distance);
    }
    object.position.add(move.applyQuaternion(object.quaternion));

    // A fly-mode right drag orbits the picked point once the pick settles
    if (this.pivot && this.pivotLook.lengthSq() > 0) {
      const look = new THREE.Vector2(this.pivotLook.x * (s.invertLookX ? -1 : 1), this.pivotLook.y * (s.invertLookY ? -1 : 1)).multiplyScalar(s.pointerLookSpeed);
      this.pivotLook.set(0, 0);
      const from = object.quaternion.clone().invert();
      turn(object, look.x, -look.y);
      object.position.sub(this.pivot).applyQuaternion(object.quaternion.clone().multiply(from)).add(this.pivot);
    }

    const moved = object.position.distanceToSquared(before) > 1e-12 || object.quaternion.angleTo(beforeQuaternion) > 1e-7;
    return moved || this.pointerLookVelocity.lengthSq() > 0 || this.pointerPanVelocity.lengthSq() > 0;
  }

  private clearInput() {
    this.look.set(0, 0);
    this.pan.set(0, 0, 0);
    this.zoom = 0;
    this.keyLookVelocity.set(0, 0);
    this.keyMoveVelocity.set(0, 0, 0);
    this.pointerLookVelocity.set(0, 0);
    this.pointerPanVelocity.set(0, 0, 0);
    this.pivotLook.set(0, 0);
  }

  private locked() {
    return document.pointerLockElement === this.canvas;
  }

  private pointerDown(event: PointerEvent) {
    this.capsLock = event.getModifierState("CapsLock");
    if (!this.enabled) {
      return;
    }
    if (this.locked() && event.button === 0) {
      document.exitPointerLock();
      return;
    }
    if (this.settings.pointerLock && this.settings.mode === "fly" && event.pointerType === "mouse" && event.button === 0 && !this.locked()) {
      void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    }
    // Locked, the right drag pans, since there is no pointer to pick under
    const s = this.settings;
    const pivots = event.button === 2 && event.pointerType === "mouse" && !event.shiftKey && s.mode === "fly" && !this.locked() && this.pick !== undefined;
    // The second of two quick presses slides
    const now = performance.now();
    const primary = event.button === 0 && this.pointers.size === 0;
    const slides = primary && now - this.lastPress < s.doublePress;
    if (primary) {
      this.lastPress = slides ? -Infinity : now;
    }
    if (this.pointers.size === 0) {
      this.dragStart = event.timeStamp;
      this.dragMoves.length = 0;
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button, touch: event.pointerType !== "mouse", pivots, slides });
    if (pivots) {
      const drag = ++this.pivotDrag;
      const rect = this.canvas.getBoundingClientRect();
      const [x, y] = [event.clientX - rect.left, event.clientY - rect.top];
      this.pivot = undefined;
      this.pivotLook.set(0, 0);
      const settle = (point?: THREE.Vector3) => {
        if (this.pivotDrag === drag) {
          this.pivot = point ?? this.getTarget();
        }
      };
      this.pick!(x, y).then(settle, () => settle());
    }
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Not allowed while the pointer is locked
    }
  }

  // Keeps the look and pan this move adds, for the glide
  private pointerMove(event: PointerEvent) {
    const [look, pan] = [this.look.clone(), this.pan.clone()];
    this.applyMove(event);
    if (this.locked()) {
      return;
    }
    look.subVectors(this.look, look);
    pan.subVectors(this.pan, pan);
    if (look.lengthSq() > 0 || pan.lengthSq() > 0) {
      const time = event.timeStamp;
      this.dragMoves.push({ time, look, pan });
      while (this.dragMoves[0].time < time - RELEASE_WINDOW) {
        this.dragMoves.shift();
      }
    }
  }

  private applyMove(event: PointerEvent) {
    if (this.locked()) {
      // Locked, the mouse looks without a button
      const pointer = this.pointers.get(event.pointerId);
      if (pointer?.pivots) {
        this.pivotLook.x += event.movementX;
        this.pivotLook.y += event.movementY;
        return;
      }
      const button = pointer && !pointer.touch ? pointer.button : 0;
      this.drag(button, event.movementX, event.movementY);
      return;
    }
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) {
      return;
    }

    const touches = [...this.pointers.values()].filter((p) => p.touch);
    if (pointer.touch && touches.length >= 2) {
      // The midpoint pans, the spread zooms
      const [a, b] = touches;
      const midBefore = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const spreadBefore = Math.hypot(a.x - b.x, a.y - b.y);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      this.pan.x += (a.x + b.x) / 2 - midBefore.x;
      this.pan.y += (a.y + b.y) / 2 - midBefore.y;
      this.zoom -= (Math.hypot(a.x - b.x, a.y - b.y) - spreadBefore) * 2;
      return;
    }

    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (pointer.pivots) {
      this.pivotLook.x += dx;
      this.pivotLook.y += dy;
      return;
    }
    if (pointer.slides) {
      this.pan.x -= dx;
      this.pan.z += dy;
      return;
    }
    this.drag(pointer.touch ? 0 : pointer.button, dx, dy);
  }

  private drag(button: number, dx: number, dy: number) {
    if (button === 2) {
      this.pan.x += dx;
      this.pan.y += dy;
    } else if (button === 1) {
      this.zoom += dy * 2;
    } else {
      this.look.x += dx;
      this.look.y += dy;
    }
  }

  private pointerUp(event: PointerEvent) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) {
      return;
    }
    this.pointers.delete(event.pointerId);

    // The glide is the drag's average speed over the last RELEASE_WINDOW
    if (this.pointers.size === 0 && !this.locked()) {
      const end = event.timeStamp;
      const start = Math.max(end - RELEASE_WINDOW, this.dragStart);
      const look = new THREE.Vector2();
      const pan = new THREE.Vector3();
      for (const move of this.dragMoves) {
        if (move.time > start) {
          look.add(move.look);
          pan.add(move.pan);
        }
      }
      const seconds = Math.max(end - start, 16) / 1000;
      this.pointerLookVelocity.copy(look).divideScalar(seconds);
      this.pointerPanVelocity.copy(pan).divideScalar(seconds);
      this.dragMoves.length = 0;
    }

    if (pointer.pivots) {
      // So a late pick is ignored
      this.pivotDrag += 1;
      this.pivot = undefined;
      this.pivotLook.set(0, 0);
    }
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Never captured under pointer lock
    }
  }

  private keyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT") {
      return;
    }
    if (event.code === this.settings.modeKey && !event.repeat && this.enabled) {
      this.mode = this.mode === "fly" ? "orbit" : "fly";
    }
    this.keys.add(event.code);
    this.capsLock = event.getModifierState("CapsLock");
  }

  // xr-standard mapping: axes 2 and 3 thumbstick, button 0 trigger, 1 grip
  private updateXr(dt: number) {
    const session = this.xr?.getSession();
    if (!session) {
      return false;
    }
    let left: Gamepad | undefined;
    let right: Gamepad | undefined;
    for (const source of session.inputSources) {
      if (source.gamepad && !source.hand) {
        if (source.handedness === "left") {
          left = source.gamepad;
        } else if (source.handedness === "right") {
          right = source.gamepad;
        }
      }
    }
    const s = this.settings;
    const dead = (value = 0) => (Math.abs(value) >= s.stickDeadZone ? value : 0);

    const move = new THREE.Vector3(
      dead(left?.axes[2]),
      (left?.buttons[0]?.value ?? 0) - (left?.buttons[1]?.value ?? 0),
      dead(left?.axes[3]),
    );
    const turn = dead(right?.axes[2]);
    let speed = s.xrMoveSpeed;
    if (right?.buttons[0]?.pressed) {
      speed *= s.fastMultiplier;
    }
    if (right?.buttons[1]?.pressed) {
      speed *= s.slowMultiplier;
    }
    if (move.lengthSq() === 0 && turn === 0) {
      return false;
    }

    const rig = this.rig ?? this.object.parent ?? this.object;
    // three writes the XR head pose into the camera
    const head = this.object.getWorldPosition(new THREE.Vector3());
    const facing = this.object.getWorldDirection(new THREE.Vector3());

    // Yaw about the head, so the viewer turns in place
    if (turn !== 0) {
      const yaw = new THREE.Quaternion().setFromAxisAngle(Y, -turn * s.xrTurnSpeed * dt);
      rig.quaternion.premultiply(yaw);
      rig.position.sub(head).applyQuaternion(yaw).add(head);
    }

    // The head's horizontal facing, or the rig's when looking straight down
    facing.y = 0;
    if (facing.lengthSq() < 1e-6) {
      facing.set(0, 0, -1).applyQuaternion(rig.quaternion);
      facing.y = 0;
    }
    facing.normalize();
    const rightward = new THREE.Vector3().crossVectors(facing, Y);
    const step = new THREE.Vector3().addScaledVector(rightward, move.x).addScaledVector(Y, move.y).addScaledVector(facing, -move.z);
    rig.position.addScaledVector(step, speed * dt);
    return true;
  }
}

// Yaw right about object.up and pitch up, in radians, short of vertical
function turn(object: THREE.Object3D, yaw: number, pitch: number) {
  const up = upFrame(object);
  const e = new THREE.Euler().setFromQuaternion(object.quaternion.clone().premultiply(up.clone().invert()), "YXZ");
  e.y -= yaw;
  e.x = THREE.MathUtils.clamp(e.x + pitch, -MAX_PITCH, MAX_PITCH);
  object.quaternion.setFromEuler(e).premultiply(up);
}

// The rotation from +Y to object.up in the parent frame
function upFrame(object: THREE.Object3D): THREE.Quaternion {
  const up = object.up.clone().normalize();
  if (object.parent) {
    up.applyQuaternion(object.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
  }
  return new THREE.Quaternion().setFromUnitVectors(Y, up);
}

// Exponential approach with time constant tau, 0 for at once
function ease<V extends THREE.Vector2 | THREE.Vector3>(value: V, target: V, tau: number, dt: number) {
  (value as THREE.Vector3).lerp(target as THREE.Vector3, 1 - decay(tau, dt));
}

function decay(tau: number, dt: number) {
  return tau > 0 ? Math.exp(-dt / tau) : 0;
}

// Keeps only settings keys whose types match
function mergeSettings(base: CameraControlsSettings, over: Partial<CameraControlsSettings>): CameraControlsSettings {
  const merged = { ...base, inertia: { ...base.inertia } } as CameraControlsSettings;
  for (const [key, value] of Object.entries(over)) {
    const current = (base as unknown as Record<string, unknown>)[key];
    if (key === "inertia" && value && typeof value === "object") {
      for (const [name, tau] of Object.entries(value)) {
        if (name in merged.inertia && typeof tau === "number") {
          merged.inertia[name as keyof CameraControlsInertia] = tau;
        }
      }
    } else if (current !== undefined && typeof value === typeof current && key !== "inertia") {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  if (merged.mode !== "fly" && merged.mode !== "orbit") {
    merged.mode = base.mode;
  }
  return merged;
}

function isMobile() {
  return typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile/.test(navigator.userAgent);
}
