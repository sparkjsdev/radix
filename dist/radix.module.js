// src/controls/CameraControls.ts
import * as THREE from "three";
var PERSONAL = [
  "invertLookX",
  "invertLookY",
  "invertPan",
  "invertZoom",
  "invertStickY",
  "pointerLock",
  "inertia",
  "pointerLookSpeed"
];
var STORAGE_PREFIX = "radix-controls";
var MOVE_KEYS = {
  KeyW: [0, 0, -1],
  KeyS: [0, 0, 1],
  KeyA: [-1, 0, 0],
  KeyD: [1, 0, 0],
  KeyE: [0, 1, 0],
  KeyQ: [0, -1, 0],
  ArrowUp: [0, 0, -1],
  ArrowDown: [0, 0, 1],
  ArrowLeft: [-1, 0, 0],
  ArrowRight: [1, 0, 0],
  PageUp: [0, 1, 0],
  PageDown: [0, -1, 0]
};
var LOOK_KEYS = { Insert: [-1, 0], Delete: [1, 0], Home: [0, 1], End: [0, -1] };
var Y = new THREE.Vector3(0, 1, 0);
var FORWARD = new THREE.Vector3(0, 0, -1);
var MAX_PITCH = Math.PI / 2 - 1e-4;
var RELEASE_WINDOW = 100;
var GLIDE_STOP = 0.5;
var CameraControls = class _CameraControls {
  static DEFAULTS = {
    mode: "fly",
    moveSpeed: 1,
    lookSpeed: 2,
    pointerLookSpeed: 3e-3,
    pointerPanSpeed: 2e-3,
    zoomSpeed: 15e-4,
    minDistance: 0.05,
    maxDistance: 1e3,
    fastMultiplier: 5,
    slowMultiplier: 0.2,
    capsMultiplier: 10,
    // Touch screens drag the scene rather than the view
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
    xrTurnSpeed: 4
  };
  canvas;
  // The camera, or an object carrying it
  object;
  settings;
  // Orbit radius: the target is this far in front of the object
  distance = 2;
  enabled = true;
  // Called after settings change (set, reset, the mode key)
  onChange;
  xr;
  rig;
  // Fly mode, pointer not locked: the point (parent frame) under a canvas
  // position in CSS pixels, which a right drag orbits around while held;
  // undefined for nothing there (the drag then orbits the point `distance`
  // ahead). An async depth readback fits: the drag waits for it.
  pick;
  storageKey;
  pageDefaults;
  // The current right drag's pivot (once picked), its look delta in pixels,
  // and which drag the pending pick belongs to
  pivot;
  pivotLook = new THREE.Vector2();
  pivotDrag = 0;
  pointers = /* @__PURE__ */ new Map();
  lastPress = -Infinity;
  keys = /* @__PURE__ */ new Set();
  // Caps Lock's state from the latest key or pointer event
  capsLock = false;
  // Pointer deltas since the last update: look in pixels, pan (x, y) and
  // slide forward (z) in pixels, zoom in wheel units
  look = new THREE.Vector2();
  pan = new THREE.Vector3();
  zoom = 0;
  keyLookVelocity = new THREE.Vector2();
  keyMoveVelocity = new THREE.Vector3();
  // The glide after a release, in pixels per second (look; pan and slide)
  pointerLookVelocity = new THREE.Vector2();
  pointerPanVelocity = new THREE.Vector3();
  // The current drag's start and its recent moves (event times in ms), for
  // the glide's speed: from events, so frames without one do not stop it
  dragStart = 0;
  dragMoves = [];
  lastTime;
  abort = new AbortController();
  constructor({ canvas, object, settings, storageKey, xr, rig }) {
    this.canvas = canvas;
    this.object = object;
    this.storageKey = storageKey || void 0;
    this.xr = xr;
    this.rig = rig;
    this.pageDefaults = mergeSettings(_CameraControls.DEFAULTS, settings ?? {});
    this.settings = mergeSettings(mergeSettings(this.pageDefaults, loadSettings(STORAGE_PREFIX)), this.storageKey ? loadSettings(`${STORAGE_PREFIX}:${this.storageKey}`) : {});
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
  get mode() {
    return this.settings.mode;
  }
  // Switch at any time: the pose stays, only the pivot changes
  set mode(mode) {
    this.set({ mode });
  }
  // Change settings and save them (the personal ones only when one of them
  // is among the changes, so pages switching modes do not pin the defaults)
  set(settings) {
    this.settings = mergeSettings(this.settings, settings);
    if (this.settings.mode !== "fly" && document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
    this.save({ personal: Object.keys(settings).some((key) => PERSONAL.includes(key)) });
    this.onChange?.(this.settings);
  }
  // Personal settings for every page; the rest that differ from the page's
  // defaults for this storageKey
  save({ personal = true } = {}) {
    if (personal) {
      writeStorage(STORAGE_PREFIX, Object.fromEntries(PERSONAL.map((key) => [key, this.settings[key]])));
    }
    if (this.storageKey) {
      const page = Object.fromEntries(Object.entries(this.settings).filter(([key, value]) => !PERSONAL.includes(key) && JSON.stringify(value) !== JSON.stringify(this.pageDefaults[key])));
      writeStorage(`${STORAGE_PREFIX}:${this.storageKey}`, page);
    }
  }
  // Back to the page's defaults, forgetting this page's saved settings (and
  // with `personal`, the personal ones every page shares)
  reset({ personal = false } = {}) {
    if (this.storageKey) {
      writeStorage(`${STORAGE_PREFIX}:${this.storageKey}`, void 0);
    }
    if (personal) {
      writeStorage(STORAGE_PREFIX, void 0);
    }
    this.settings = mergeSettings(this.pageDefaults, personal ? {} : loadSettings(STORAGE_PREFIX));
    this.onChange?.(this.settings);
  }
  // The orbit target in the parent frame
  getTarget(out = new THREE.Vector3()) {
    return out.copy(FORWARD).applyQuaternion(this.object.quaternion).multiplyScalar(this.distance).add(this.object.position);
  }
  // Face `target` (parent frame) from where the object stands and orbit around it
  lookAt(target) {
    const position = this.object.position;
    this.distance = THREE.MathUtils.clamp(position.distanceTo(target), this.settings.minDistance, this.settings.maxDistance);
    const up = upFrame(this.object);
    const d = target.clone().sub(position).normalize().applyQuaternion(up.clone().invert());
    const e = new THREE.Euler(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), Math.atan2(-d.x, -d.z), 0, "YXZ");
    this.object.quaternion.setFromEuler(e).premultiply(up);
  }
  // Call once per frame; true when the object moved
  update() {
    const now = performance.now();
    const dt = (now - (this.lastTime ?? now)) / 1e3;
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
      const move2 = MOVE_KEYS[code];
      if (move2) {
        moveInput.add(new THREE.Vector3(...move2));
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
      const dead = (value = 0) => Math.abs(value) >= s.stickDeadZone ? value : 0;
      moveInput.x += dead(gamepad.axes[0]);
      moveInput.z += dead(gamepad.axes[1]);
      moveInput.y += (gamepad.buttons[5]?.value ?? 0) - (gamepad.buttons[4]?.value ?? 0);
      lookInput.x += dead(gamepad.axes[2]);
      lookInput.y -= dead(gamepad.axes[3]) * (s.invertStickY ? -1 : 1);
      speed *= THREE.MathUtils.lerp(1, s.slowMultiplier, gamepad.buttons[6]?.value ?? 0);
      speed *= THREE.MathUtils.lerp(1, s.fastMultiplier, gamepad.buttons[7]?.value ?? 0);
    }
    const scale = orbit ? this.distance : 1;
    ease(this.keyMoveVelocity, moveInput.multiplyScalar(s.moveSpeed * speed), s.inertia.move, dt);
    ease(this.keyLookVelocity, lookInput.multiplyScalar(s.lookSpeed), s.inertia.look, dt);
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
    const lookDelta = this.look.clone().addScaledVector(this.pointerLookVelocity, dt).multiply(new THREE.Vector2(s.invertLookX ? -1 : 1, s.invertLookY ? -1 : 1)).multiplyScalar(s.pointerLookSpeed);
    const panDelta = this.pan.clone().addScaledVector(this.pointerPanVelocity, dt).multiplyScalar(s.pointerPanSpeed * scale * (s.invertPan ? -1 : 1));
    const zoom = this.zoom * s.zoomSpeed * (s.invertZoom ? -1 : 1);
    this.look.set(0, 0);
    this.pan.set(0, 0, 0);
    this.zoom = 0;
    const yaw = lookDelta.x + this.keyLookVelocity.x * dt;
    const pitch = -lookDelta.y + this.keyLookVelocity.y * dt;
    const move = this.keyMoveVelocity.clone().multiplyScalar(dt);
    move.x -= panDelta.x;
    move.y += panDelta.y;
    move.z += panDelta.z;
    const object = this.object;
    const before = object.position.clone();
    const beforeQuaternion = object.quaternion.clone();
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
  clearInput() {
    this.look.set(0, 0);
    this.pan.set(0, 0, 0);
    this.zoom = 0;
    this.keyLookVelocity.set(0, 0);
    this.keyMoveVelocity.set(0, 0, 0);
    this.pointerLookVelocity.set(0, 0);
    this.pointerPanVelocity.set(0, 0, 0);
    this.pivotLook.set(0, 0);
  }
  locked() {
    return document.pointerLockElement === this.canvas;
  }
  pointerDown(event) {
    this.capsLock = event.getModifierState("CapsLock");
    if (!this.enabled) {
      return;
    }
    if (this.locked() && event.button === 0) {
      document.exitPointerLock();
      return;
    }
    if (this.settings.pointerLock && this.settings.mode === "fly" && event.pointerType === "mouse" && event.button === 0 && !this.locked()) {
      void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {
      });
    }
    const s = this.settings;
    const pivots = event.button === 2 && event.pointerType === "mouse" && !event.shiftKey && s.mode === "fly" && !this.locked() && this.pick !== void 0;
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
      this.pivot = void 0;
      this.pivotLook.set(0, 0);
      const settle = (point) => {
        if (this.pivotDrag === drag) {
          this.pivot = point ?? this.getTarget();
        }
      };
      this.pick(x, y).then(settle, () => settle());
    }
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
    }
  }
  // Applies the move, and keeps what it added to look and pan for the glide
  pointerMove(event) {
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
  applyMove(event) {
    if (this.locked()) {
      const pointer2 = this.pointers.get(event.pointerId);
      if (pointer2?.pivots) {
        this.pivotLook.x += event.movementX;
        this.pivotLook.y += event.movementY;
        return;
      }
      const button = pointer2 && !pointer2.touch ? pointer2.button : 0;
      this.drag(button, event.movementX, event.movementY);
      return;
    }
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) {
      return;
    }
    const touches = [...this.pointers.values()].filter((p) => p.touch);
    if (pointer.touch && touches.length >= 2) {
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
  drag(button, dx, dy) {
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
  pointerUp(event) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) {
      return;
    }
    this.pointers.delete(event.pointerId);
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
      const seconds = Math.max(end - start, 16) / 1e3;
      this.pointerLookVelocity.copy(look).divideScalar(seconds);
      this.pointerPanVelocity.copy(pan).divideScalar(seconds);
      this.dragMoves.length = 0;
    }
    if (pointer.pivots) {
      this.pivotDrag += 1;
      this.pivot = void 0;
      this.pivotLook.set(0, 0);
    }
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
    }
  }
  keyDown(event) {
    const target = event.target;
    if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT") {
      return;
    }
    if (event.code === this.settings.modeKey && !event.repeat && this.enabled) {
      this.mode = this.mode === "fly" ? "orbit" : "fly";
    }
    this.keys.add(event.code);
    this.capsLock = event.getModifierState("CapsLock");
  }
  // Controller locomotion of the rig from the session's handed input sources
  // (xr-standard mapping: axes 2 / 3 thumbstick, button 0 trigger, 1 grip).
  // Tracked hands have no controls here.
  updateXr(dt) {
    const session = this.xr?.getSession();
    if (!session) {
      return false;
    }
    let left;
    let right;
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
    const dead = (value = 0) => Math.abs(value) >= s.stickDeadZone ? value : 0;
    const move = new THREE.Vector3(
      dead(left?.axes[2]),
      (left?.buttons[0]?.value ?? 0) - (left?.buttons[1]?.value ?? 0),
      dead(left?.axes[3])
    );
    const turn2 = dead(right?.axes[2]);
    let speed = s.xrMoveSpeed;
    if (right?.buttons[0]?.pressed) {
      speed *= s.fastMultiplier;
    }
    if (right?.buttons[1]?.pressed) {
      speed *= s.slowMultiplier;
    }
    if (move.lengthSq() === 0 && turn2 === 0) {
      return false;
    }
    const rig = this.rig ?? this.object.parent ?? this.object;
    const head = this.object.getWorldPosition(new THREE.Vector3());
    const facing = this.object.getWorldDirection(new THREE.Vector3());
    if (turn2 !== 0) {
      const yaw = new THREE.Quaternion().setFromAxisAngle(Y, -turn2 * s.xrTurnSpeed * dt);
      rig.quaternion.premultiply(yaw);
      rig.position.sub(head).applyQuaternion(yaw).add(head);
    }
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
};
function turn(object, yaw, pitch) {
  const up = upFrame(object);
  const e = new THREE.Euler().setFromQuaternion(object.quaternion.clone().premultiply(up.clone().invert()), "YXZ");
  e.y -= yaw;
  e.x = THREE.MathUtils.clamp(e.x + pitch, -MAX_PITCH, MAX_PITCH);
  object.quaternion.setFromEuler(e).premultiply(up);
}
function upFrame(object) {
  const up = object.up.clone().normalize();
  if (object.parent) {
    up.applyQuaternion(object.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
  }
  return new THREE.Quaternion().setFromUnitVectors(Y, up);
}
function ease(value, target, tau, dt) {
  value.lerp(target, 1 - decay(tau, dt));
}
function decay(tau, dt) {
  return tau > 0 ? Math.exp(-dt / tau) : 0;
}
function mergeSettings(base, over2) {
  const merged = { ...base, inertia: { ...base.inertia } };
  for (const [key, value] of Object.entries(over2)) {
    const current = base[key];
    if (key === "inertia" && value && typeof value === "object") {
      for (const [name, tau] of Object.entries(value)) {
        if (name in merged.inertia && typeof tau === "number") {
          merged.inertia[name] = tau;
        }
      }
    } else if (current !== void 0 && typeof value === typeof current && key !== "inertia") {
      merged[key] = value;
    }
  }
  if (merged.mode !== "fly" && merged.mode !== "orbit") {
    merged.mode = base.mode;
  }
  return merged;
}
function loadSettings(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function writeStorage(key, value) {
  try {
    if (value === void 0 || Object.keys(value).length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
  }
}
function isMobile() {
  return typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile/.test(navigator.userAgent);
}

// src/core/formats.ts
var SCALARS = {
  uint8: { bytes: 1, array: Uint8Array },
  sint8: { bytes: 1, array: Int8Array },
  unorm8: { bytes: 1, array: Uint8Array },
  snorm8: { bytes: 1, array: Int8Array },
  uint16: { bytes: 2, array: Uint16Array },
  sint16: { bytes: 2, array: Int16Array },
  float16: { bytes: 2, array: Uint16Array },
  uint32: { bytes: 4, array: Uint32Array },
  sint32: { bytes: 4, array: Int32Array },
  float32: { bytes: 4, array: Float32Array }
};
var cache = /* @__PURE__ */ new Map();
var ArrayFormats = class {
  static info(format) {
    let info = cache.get(format);
    if (!info) {
      const [scalar, count] = format.split("x");
      const spec = SCALARS[scalar];
      const components = count === void 0 ? 1 : Number(count);
      if (!spec || !Number.isInteger(components) || components < 1) {
        throw new Error(`Invalid array format "${format}"`);
      }
      info = {
        format,
        scalar,
        components,
        scalarBytes: spec.bytes,
        bytes: spec.bytes * components,
        array: spec.array,
        gpu: components === 1 || components === 2 || components === 4
      };
      cache.set(format, info);
    }
    return info;
  }
  // Format of `scalar` with `components` components ("uint32", "uint32x4")
  static make(scalar, components) {
    return components === 1 ? scalar : `${scalar}x${components}`;
  }
};

// src/core/bundles.ts
function defineBundle(channels, { packing = 1, serialize = true } = {}) {
  for (const format of Object.values(channels)) {
    const texelComponents = ArrayFormats.info(format).components * packing;
    if (packing > 1 && ![1, 2, 4].includes(texelComponents)) {
      throw new Error(`Format ${format} cannot be packed ${packing} per texel`);
    }
  }
  return { channels, packing, serialize };
}

// src/core/layout.ts
var TextureLayout = class _TextureLayout {
  static WIDTH = 1024;
  static MAX_PACKING = 4;
  // One texture row for every packing (1, 2 or 4 elements per texel)
  static ROW_ELEMENTS = _TextureLayout.WIDTH * _TextureLayout.MAX_PACKING;
  // Array textures are limited by MAX_TEXTURE_SIZE (not MAX_3D_TEXTURE_SIZE),
  // >= 4096 on 100% of WebGL2 devices (web3dsurvey.com, Sep 2026)
  static MAX_HEIGHT = 4096;
  // WebGL2 MAX_ARRAY_TEXTURE_LAYERS: 100% of devices; WebGPU baseline 2048
  // (its default is 256, so createRenderer requests more)
  static MAX_LAYERS = 512;
  width;
  height;
  layers;
  xBits;
  yBits;
  // width * height * layers
  texels;
  constructor(height, layers) {
    this.width = _TextureLayout.WIDTH;
    this.height = height;
    this.layers = layers;
    this.xBits = Math.log2(this.width);
    this.yBits = Math.log2(height);
    this.texels = this.width * height * layers;
  }
  // Layout holding at least `texels` texels in 2 to 4 layers (at most 50%
  // padding) until the height reaches its cap, then one more 4096-row layer
  // at a time. At least 2 layers: the WebGL backend only renders to single
  // layers of targets with more than one layer.
  static for(texels) {
    const rows = Math.max(1, Math.ceil(texels / _TextureLayout.WIDTH));
    const height = Math.min(_TextureLayout.MAX_HEIGHT, 2 ** Math.max(0, Math.floor(Math.log2(rows / 2))));
    const layers = Math.max(2, Math.ceil(rows / height));
    if (layers > _TextureLayout.MAX_LAYERS) {
      throw new Error(`${texels} texels do not fit in an array texture`);
    }
    return new _TextureLayout(height, layers);
  }
  // Capacity for `count` elements: whole rows for every packing
  static alignCapacity(count) {
    return Math.max(1, Math.ceil(count / _TextureLayout.ROW_ELEMENTS)) * _TextureLayout.ROW_ELEMENTS;
  }
  // Texels [start, start + count) as few rectangles as possible: partial
  // rows at the ends, whole rows in between (one span per layer)
  spans(start, count) {
    const { width, height } = this;
    const layerSize = width * height;
    const spans = [];
    const end = start + count;
    let t = start;
    while (t < end) {
      const layer = Math.floor(t / layerSize);
      const inLayer = t - layer * layerSize;
      const y = Math.floor(inLayer / width);
      const x = inLayer - y * width;
      if (x > 0 || end - t < width) {
        const n = Math.min(width - x, end - t);
        spans.push({ x, y, layer, width: n, rows: 1, offset: t - start });
        t += n;
      } else {
        const rows = Math.min(Math.floor((end - t) / width), height - y);
        spans.push({ x: 0, y, layer, width, rows, offset: t - start });
        t += rows * width;
      }
    }
    return spans;
  }
  // Rectangles copying texels [srcStart, srcStart + count) of `src` to
  // dstStart of `dst`. Whole rows are copied together when both sides are
  // row-aligned; otherwise pieces stop at the row end of either side.
  static copySpans(src, srcStart, dst, dstStart, count) {
    const width = _TextureLayout.WIDTH;
    const position = (layout, t) => {
      const layerSize = width * layout.height;
      const layer = Math.floor(t / layerSize);
      const y = Math.floor((t - layer * layerSize) / width);
      return { x: t % width, y, layer };
    };
    const spans = [];
    let done = 0;
    while (done < count) {
      const s = position(src, srcStart + done);
      const d = position(dst, dstStart + done);
      const left = count - done;
      let span2;
      if (s.x === 0 && d.x === 0 && left >= width) {
        const rows = Math.min(Math.floor(left / width), src.height - s.y, dst.height - d.y);
        span2 = { src: s, dst: d, width, rows };
      } else {
        span2 = { src: s, dst: d, width: Math.min(left, width - s.x, width - d.x), rows: 1 };
      }
      spans.push(span2);
      done += span2.width * span2.rows;
    }
    return spans;
  }
};

// src/core/ArrayData.ts
var ArrayData = class _ArrayData {
  // A list of element indices, 4 per uint32x4 texel: a draw order, a subset
  static INDICES = defineBundle({ index: "uint32" }, { packing: 4 });
  count;
  capacity;
  bundles;
  meta;
  constructor({ bundles, count = 0, capacity, meta = {} } = {}) {
    this.count = count;
    this.capacity = capacity ?? TextureLayout.alignCapacity(count);
    if (this.capacity < count) {
      throw new Error(`Capacity ${this.capacity} is below count ${count}`);
    }
    this.bundles = {};
    this.meta = meta;
    for (const [name, def] of Object.entries(bundles ?? {})) {
      this.addBundle(name, def);
    }
  }
  // `data` arrays are used as given when they hold capacity elements, else
  // copied into a new array of that size
  addBundle(name, def, init = {}) {
    const channels = {};
    for (const [label, format] of Object.entries(def.channels)) {
      const info = ArrayFormats.info(format);
      const length6 = this.capacity * info.components;
      let data = init.data?.[label];
      if (data && data.constructor !== info.array) {
        throw new Error(`Channel ${name}.${label}: ${data.constructor.name} does not hold ${format}`);
      }
      if (!data || data.length < length6) {
        const sized = new info.array(length6);
        if (data) {
          sized.set(data);
        }
        data = sized;
      }
      channels[label] = { format, data };
    }
    this.anyBundles[name] = { def, channels, meta: { ...init.meta } };
    return this;
  }
  removeBundle(name) {
    if (!(name in this.bundles)) {
      return false;
    }
    delete this.anyBundles[name];
    return true;
  }
  // Resize every channel, keeping contents; count is clamped to the capacity
  setCapacity(capacity) {
    if (capacity === this.capacity) {
      return false;
    }
    for (const bundle of Object.values(this.anyBundles)) {
      for (const channel of Object.values(bundle.channels)) {
        const info = ArrayFormats.info(channel.format);
        const data = new info.array(capacity * info.components);
        data.set(channel.data.subarray(0, data.length));
        channel.data = data;
      }
    }
    this.capacity = capacity;
    this.count = Math.min(this.count, capacity);
    return true;
  }
  // Grow (at least doubling, whole rows) to hold `capacity` elements
  ensureCapacity(capacity) {
    if (capacity <= this.capacity) {
      return false;
    }
    return this.setCapacity(TextureLayout.alignCapacity(Math.max(capacity, this.capacity * 2)));
  }
  // Copy elements of matching bundles (default: all bundles both have)
  copyFrom(src, { bundles, srcStart = 0, dstStart = 0, count = src.count - srcStart } = {}) {
    if (srcStart < 0 || count < 0 || srcStart + count > src.capacity) {
      throw new Error(`Copy of ${count} elements from ${srcStart} exceeds the source capacity ${src.capacity}`);
    }
    this.ensureCapacity(dstStart + count);
    const names = bundles ?? Object.keys(this.bundles).filter((name) => name in src.bundles);
    for (const name of names) {
      const from = src.anyBundles[name];
      const to = this.anyBundles[name];
      if (!from || !to) {
        throw new Error(`Bundle ${name} missing`);
      }
      for (const [label, channel] of Object.entries(to.channels)) {
        const source = from.channels[label];
        if (source?.format !== channel.format) {
          throw new Error(`Channel ${name}.${label} missing or of another format`);
        }
        const components = ArrayFormats.info(channel.format).components;
        const values = source.data.subarray(srcStart * components, (srcStart + count) * components);
        channel.data.set(values, dstStart * components);
      }
    }
    this.count = Math.max(this.count, dstStart + count);
  }
  clone() {
    const copy = new _ArrayData({ count: this.count, capacity: this.capacity, meta: structuredClone(this.meta) });
    for (const [name, bundle] of Object.entries(this.anyBundles)) {
      const data = Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data.slice()]));
      copy.addBundle(name, bundle.def, { data, meta: structuredClone(bundle.meta) });
    }
    return copy;
  }
  // Swap contents with `other` (double buffering)
  swap(other) {
    [this.count, other.count] = [other.count, this.count];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
    [this.bundles, other.bundles] = [other.bundles, this.bundles];
    [this.meta, other.meta] = [other.meta, this.meta];
  }
  // The arrays are shared, not copied: pass transferables(t) to postMessage
  // and this ArrayData is unusable until setFromTransferable
  toTransferable() {
    const bundles = {};
    for (const [name, bundle] of Object.entries(this.anyBundles)) {
      const channels = Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data]));
      bundles[name] = { def: bundle.def, meta: bundle.meta, channels };
    }
    return { count: this.count, capacity: this.capacity, meta: this.meta, bundles };
  }
  // Take over `t` in place (e.g. data coming back from a worker). Bundles
  // and channels with the same names and formats keep their objects, so
  // references held elsewhere stay valid; others are replaced.
  setFromTransferable(t) {
    this.count = t.count;
    this.capacity = t.capacity;
    this.meta = t.meta;
    const bundles = {};
    for (const [name, value] of Object.entries(t.bundles)) {
      const existing = this.anyBundles[name];
      const labels = Object.keys(value.def.channels);
      const same = existing && existing.def.packing === value.def.packing && labels.length === Object.keys(existing.channels).length && labels.every((label) => existing.channels[label]?.format === value.def.channels[label]);
      if (same) {
        for (const label of labels) {
          existing.channels[label].data = value.channels[label];
        }
        existing.def = value.def;
        existing.meta = value.meta;
        bundles[name] = existing;
      } else {
        const channels = Object.fromEntries(labels.map((label) => [label, { format: value.def.channels[label], data: value.channels[label] }]));
        bundles[name] = { def: value.def, channels, meta: value.meta };
      }
    }
    this.bundles = bundles;
    return this;
  }
  static fromTransferable(t) {
    return new _ArrayData().setFromTransferable(t);
  }
  // The ArrayBuffers inside `value` (a TransferableArrayData or anything
  // else), for postMessage's transfer list
  static transferables(value) {
    const buffers = /* @__PURE__ */ new Set();
    const seen = /* @__PURE__ */ new Set();
    const visit = (item) => {
      if (!item || typeof item !== "object" || seen.has(item)) {
        return;
      }
      seen.add(item);
      if (item instanceof ArrayBuffer) {
        buffers.add(item);
      } else if (ArrayBuffer.isView(item)) {
        if (item.buffer instanceof ArrayBuffer) {
          buffers.add(item.buffer);
        }
      } else {
        Object.values(item).forEach(visit);
      }
    };
    visit(value);
    return [...buffers];
  }
  get anyBundles() {
    return this.bundles;
  }
};

// src/core/progress.ts
function span(progress, from, to) {
  return progress && ((fraction, stage) => progress(from + (to - from) * Math.min(1, Math.max(0, fraction)), stage));
}
function counter(progress, total, stage) {
  return progress ? (i) => (i & 65535) === 0 && progress(i / Math.max(1, total), stage) : () => {
  };
}
async function readResponse(response, progress) {
  const total = Number(response.headers.get("content-length") ?? 0);
  if (!progress || !response.body || !(total > 0)) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks = [];
  let read = 0;
  const reader = response.body.getReader();
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    read += value.byteLength;
    progress(Math.min(1, read / total), "downloading");
  }
  const bytes2 = new Uint8Array(read);
  let at2 = 0;
  for (const chunk of chunks) {
    bytes2.set(chunk, at2);
    at2 += chunk.byteLength;
  }
  return bytes2;
}

// src/core/encoding.ts
var floatViews = /* @__PURE__ */ new WeakMap();
var f32 = new Float32Array(1);
var u32 = new Uint32Array(f32.buffer);
var Float16 = globalThis.Float16Array;
var f16 = Float16 ? new Float16(1) : void 0;
var u16 = f16 ? new Uint16Array(f16.buffer) : void 0;
function makeOctCodec(bits) {
  if (bits < 1 || bits > 16) {
    throw new Error(`Octahedral codes take 1 to 16 bits per axis, not ${bits}`);
  }
  const max11 = 2 ** bits - 1;
  const allOnes = (max11 | max11 << bits) >>> 0;
  return {
    encode(v) {
      const l1 = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z);
      if (!(l1 > 0)) {
        return 0;
      }
      let px = v.x / l1;
      let py = v.y / l1;
      if (v.z < 0) {
        const ax = Math.abs(px);
        px = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1);
        py = (1 - ax) * (py >= 0 ? 1 : -1);
      }
      const code = (Math.round((px * 0.5 + 0.5) * max11) | Math.round((py * 0.5 + 0.5) * max11) << bits) >>> 0;
      return code === 0 ? allOnes : code;
    },
    decode(code, out) {
      if (code === 0) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        return out;
      }
      let x = (code & max11) / max11 * 2 - 1;
      let y = (code >>> bits & max11) / max11 * 2 - 1;
      const z = 1 - Math.abs(x) - Math.abs(y);
      const t = Math.max(-z, 0);
      x += x >= 0 ? -t : t;
      y += y >= 0 ? -t : t;
      const length6 = Math.sqrt(x * x + y * y + z * z);
      out.x = x / length6;
      out.y = y / length6;
      out.z = z / length6;
      return out;
    }
  };
}
function makeQuatCodec(axisBits, angleBits) {
  const axisCodeBits = 2 * axisBits;
  if (axisCodeBits + angleBits > 32) {
    throw new Error(`Quaternion codes hold at most 32 bits, not ${axisCodeBits + angleBits}`);
  }
  const oct = makeOctCodec(axisBits);
  const axisMask = 2 ** axisCodeBits - 1;
  const angleMax = 2 ** angleBits - 1;
  const axis = { x: 0, y: 0, z: 0 };
  return {
    encode(q) {
      const length6 = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
      if (!(length6 > 0)) {
        return 0;
      }
      const s = (q.w < 0 ? -1 : 1) / length6;
      axis.x = q.x * s;
      axis.y = q.y * s;
      axis.z = q.z * s;
      const angle = 2 * Math.acos(Math.min(1, q.w * s));
      const angleCode = Math.round(angle / Math.PI * angleMax);
      return (oct.encode(axis) | angleCode << axisCodeBits) >>> 0;
    },
    decode(code, out) {
      oct.decode(code & axisMask, out);
      const angle = (code >>> axisCodeBits & angleMax) / angleMax * Math.PI;
      const s = Math.sin(angle / 2);
      out.x *= s;
      out.y *= s;
      out.z *= s;
      out.w = Math.cos(angle / 2);
      return out;
    }
  };
}
var octCodecs = /* @__PURE__ */ new Map();
var quatCodecs = /* @__PURE__ */ new Map();
function octCodec(bits) {
  let codec = octCodecs.get(bits);
  if (!codec) {
    codec = makeOctCodec(bits);
    octCodecs.set(bits, codec);
  }
  return codec;
}
function quatCodec(axisBits, angleBits) {
  const key = `${axisBits}:${angleBits}`;
  let codec = quatCodecs.get(key);
  if (!codec) {
    codec = makeQuatCodec(axisBits, angleBits);
    quatCodecs.set(key, codec);
  }
  return codec;
}
var oct24 = octCodec(12);
var quatOct32 = quatCodec(10, 12);
var quatOct24 = quatCodec(8, 8);
var Encoding = class {
  // The same memory as floats, cached per array
  static floatView(u324) {
    let view = floatViews.get(u324);
    if (!view) {
      view = new Float32Array(u324.buffer, u324.byteOffset, u324.length);
      floatViews.set(u324, view);
    }
    return view;
  }
  // Half-float bits of f, rounded to nearest even (like the GPU's packHalf2x16)
  static encodeHalf(f) {
    if (f16 && u16) {
      f16[0] = f;
      return u16[0];
    }
    f32[0] = f;
    const bits = u32[0];
    const sign2 = bits >>> 16 & 32768;
    const exponent = bits >>> 23 & 255;
    const mantissa = bits & 8388607;
    if (exponent === 255) {
      return sign2 | 31744 | (mantissa ? 512 : 0);
    }
    const e = exponent - 127 + 15;
    if (e >= 31) {
      return sign2 | 31744;
    }
    if (e <= 0) {
      const m = Math.abs(f32[0]) * 2 ** 24;
      let rounded = Math.floor(m);
      const fraction = m - rounded;
      if (fraction > 0.5 || fraction === 0.5 && rounded & 1) {
        rounded += 1;
      }
      return sign2 | rounded;
    }
    const half = sign2 | e << 10 | mantissa >> 13;
    const rest = mantissa & 8191;
    return rest > 4096 || rest === 4096 && half & 1 ? half + 1 : half;
  }
  static decodeHalf(h) {
    const sign2 = h & 32768 ? -1 : 1;
    const exponent = h >> 10 & 31;
    const mantissa = h & 1023;
    if (exponent === 0) {
      return sign2 * mantissa * 2 ** -24;
    }
    if (exponent === 31) {
      return mantissa ? Number.NaN : sign2 * Number.POSITIVE_INFINITY;
    }
    return sign2 * (1 + mantissa / 1024) * 2 ** (exponent - 15);
  }
  static encodeUnorm8(v) {
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  // 128 = 1.0; merged LoD nodes can exceed 1, up to 255 / 128
  static encodeLodOpacity(opacity) {
    return Math.max(0, Math.min(255, Math.round(opacity * 128)));
  }
  static decodeLodOpacity(byte) {
    return byte / 128;
  }
  // 8-bit magnitudes, 3 sign bits and a 5-bit shared exponent, so colors may
  // exceed 1 or be negative
  static encodeExtRgb({ r, g, b }) {
    const maxAbs = Math.max(Math.abs(r), Math.abs(g), Math.abs(b));
    const base = Math.max(0, Math.min(31, (maxAbs > 0 ? Math.ceil(Math.log2(maxAbs)) : 0) + 15));
    const scale = 255 * 2 ** (15 - base);
    const mr = Math.min(255, Math.round(Math.abs(r) * scale));
    const mg = Math.min(255, Math.round(Math.abs(g) * scale));
    const mb = Math.min(255, Math.round(Math.abs(b) * scale));
    const signs = (r < 0 ? 1 : 0) | (g < 0 ? 2 : 0) | (b < 0 ? 4 : 0);
    return (mr | mg << 8 | mb << 16 | (base << 3 | signs) << 24) >>> 0;
  }
  static decodeExtRgb(encoded, out) {
    const unit = 2 ** ((encoded >>> 27 & 31) - 15) / 255;
    out.r = (encoded & 255) * unit * (encoded & 16777216 ? -1 : 1);
    out.g = (encoded >>> 8 & 255) * unit * (encoded & 33554432 ? -1 : 1);
    out.b = (encoded >>> 16 & 255) * unit * (encoded & 67108864 ? -1 : 1);
    return out;
  }
  // Octahedral direction with `bits` per axis (1 to 16)
  static encodeOct(v, bits) {
    return octCodec(bits).encode(v);
  }
  static decodeOct(code, bits, out) {
    return octCodec(bits).decode(code, out);
  }
  // Octahedral axis with `axisBits` per axis plus an `angleBits` angle (at
  // most 32 bits in all)
  static encodeQuatOct(q, axisBits, angleBits) {
    return quatCodec(axisBits, angleBits).encode(q);
  }
  static decodeQuatOct(code, axisBits, angleBits, out) {
    return quatCodec(axisBits, angleBits).decode(code, out);
  }
  static encodeOct24 = oct24.encode;
  static decodeOct24 = oct24.decode;
  static encodeQuatOct32 = quatOct32.encode;
  static decodeQuatOct32 = quatOct32.decode;
  static encodeQuatOct24 = quatOct24.encode;
  static decodeQuatOct24 = quatOct24.decode;
};

// src/core/sh.ts
var COEFFICIENTS = [0, 3, 8, 15, 24];
var MAX_DEGREE = 4;
var VALUES = COEFFICIENTS[MAX_DEGREE] * 3;
var PACKED_BAND_BYTES = [10, 16, 22, 28];
var PACKED_BYTES = [0, 10, 26, 48, 76];
var EXT_CHANNELS = { 1: ["A"], 2: ["A", "B"], 3: ["A", "B", "C", "D"], 4: ["A", "B", "C", "D", "E", "F"] };
var PACKED_CHANNELS = { 1: ["A"], 2: ["A", "B"], 3: ["A", "B", "C"], 4: ["A", "B", "C", "D", "E"] };
var SCALE_BIAS = 192;
var SCALE_STEPS = 16;
function encodeShScale(max11) {
  if (!(max11 > 0)) {
    return 0;
  }
  let code = Math.max(1, Math.min(255, Math.ceil(Math.log2(max11) * SCALE_STEPS) + SCALE_BIAS));
  while (code < 255 && decodeShScale(code) < max11) {
    code += 1;
  }
  return code;
}
function decodeShScale(code) {
  return code === 0 ? 0 : 2 ** ((code - SCALE_BIAS) / SCALE_STEPS);
}
var getByte = (words, at2, b) => words[at2 + (b >> 2)] >>> (b & 3) * 8 & 255;
var bytes = { out: new Uint32Array(0), at: 0, word: 0, shift: 0 };
var startBytes = (out, at2) => {
  bytes.out = out;
  bytes.at = at2;
  bytes.word = 0;
  bytes.shift = 0;
};
var putByte = (value) => {
  bytes.word |= (value & 255) << bytes.shift;
  bytes.shift += 8;
  if (bytes.shift === 32) {
    bytes.out[bytes.at++] = bytes.word >>> 0;
    bytes.word = 0;
    bytes.shift = 0;
  }
};
var endBytes = () => {
  if (bytes.shift > 0) {
    bytes.out[bytes.at++] = bytes.word >>> 0;
  }
};
var rgb = { r: 0, g: 0, b: 0 };
var ext = {
  name: "ext",
  words: (degree) => COEFFICIENTS[degree],
  channels: (degree) => EXT_CHANNELS[degree],
  encode(coeffs, degree, out, at2) {
    for (let k = 0; k < COEFFICIENTS[degree]; k += 1) {
      rgb.r = coeffs[k * 3];
      rgb.g = coeffs[k * 3 + 1];
      rgb.b = coeffs[k * 3 + 2];
      out[at2 + k] = Encoding.encodeExtRgb(rgb);
    }
  },
  decode(words, at2, degree, out) {
    for (let k = 0; k < COEFFICIENTS[degree]; k += 1) {
      Encoding.decodeExtRgb(words[at2 + k], rgb);
      out[k * 3] = rgb.r;
      out[k * 3 + 1] = rgb.g;
      out[k * 3 + 2] = rgb.b;
    }
    return out;
  }
};
var packed = {
  name: "packed",
  words: (degree) => Math.ceil(PACKED_BYTES[degree] / 4),
  channels: (degree) => PACKED_CHANNELS[degree],
  // Bands are contiguous (each its scale byte and values), so the bytes
  // go out in order
  encode(coeffs, degree, out, at2) {
    startBytes(out, at2);
    for (let band = 0; band < degree; band += 1) {
      const first = COEFFICIENTS[band] * 3;
      const end = COEFFICIENTS[band + 1] * 3;
      let max11 = 0;
      for (let v = first; v < end; v += 1) {
        max11 = Math.max(max11, Math.abs(coeffs[v]));
      }
      const code = encodeShScale(max11);
      const scale = decodeShScale(code);
      putByte(code);
      for (let v = first; v < end; v += 1) {
        putByte(scale > 0 ? Math.max(-127, Math.min(127, Math.round(coeffs[v] / scale * 127))) : 0);
      }
    }
    endBytes();
  },
  decode(words, at2, degree, out) {
    let byte = 0;
    for (let band = 0; band < degree; band += 1) {
      const first = COEFFICIENTS[band] * 3;
      const end = COEFFICIENTS[band + 1] * 3;
      const scale = decodeShScale(getByte(words, at2, byte)) / 127;
      for (let v = first; v < end; v += 1) {
        out[v] = (getByte(words, at2, byte + 1 + v - first) << 24 >> 24) * scale;
      }
      byte += PACKED_BAND_BYTES[band];
    }
    return out;
  }
};
var CODECS = { ext, packed };
var channelLookup = /* @__PURE__ */ new Map();
var channelCounts = {};
for (const codec of Object.values(CODECS)) {
  channelCounts[codec.name] = [0, 0, 0, 0, 0];
  for (const degree of [1, 2, 3, 4]) {
    const suffixes = codec.channels(degree);
    channelCounts[codec.name][degree] = suffixes.length;
    for (const suffix of suffixes) {
      const label = `${codec.name}Sh${suffix}`;
      const entry = channelLookup.get(label);
      if (entry) {
        entry.degrees |= 1 << degree;
      } else {
        channelLookup.set(label, { codec: codec.name, degrees: 1 << degree });
      }
    }
  }
}
var shDegreeOf = (n) => n === 1 || n === 2 || n === 3 || n === 4 ? n : void 0;
var Sh = class _Sh {
  // RGB coefficients per degree, the DC band excluded
  static COEFFICIENTS = COEFFICIENTS;
  static MAX_DEGREE = MAX_DEGREE;
  // Values of the highest degree's entry: a coefficient array that fits
  // any degree
  static VALUES = VALUES;
  static LABEL = defineBundle({ label: "uint16" });
  // A codec by name (a string from meta is checked)
  static codec(name) {
    const codec = CODECS[name];
    if (!codec) {
      throw new Error(`Unknown SH codec ${name}`);
    }
    return codec;
  }
  static texels(codec, degree) {
    return Math.ceil(_Sh.codec(codec).words(degree) / 4);
  }
  // The degree of `coefficients` RGB coefficients past DC (3, 8, 15, 24), else
  // undefined
  static degreeOf(coefficients) {
    return shDegreeOf(COEFFICIENTS.indexOf(coefficients));
  }
  static bundleName(codec) {
    return `${_Sh.codec(codec).name}Sh`;
  }
  static bundle(codec, degree) {
    return defineBundle(Object.fromEntries(_Sh.codec(codec).channels(degree).map((suffix) => [`${codec}Sh${suffix}`, "uint32x4"])));
  }
  // Adds an empty per-splat SH bundle to `data`
  static add(data, codec, degree) {
    data.addBundle(_Sh.bundleName(codec), _Sh.bundle(codec, degree), { meta: { codec, degree } });
    return data.bundles[_Sh.bundleName(codec)];
  }
  // The per-splat SH bundle among `bundles` (of an ArrayData or GpuArrays):
  // a bundle whose channels are exactly a codec's for some degree.
  // Renderers call it per object per frame, so it allocates only the result.
  static find(bundles) {
    for (const name in bundles) {
      const bundle = bundles[name];
      let codec;
      let degrees = 30;
      let count = 0;
      for (const label in bundle.channels) {
        const entry = channelLookup.get(label);
        if (!entry || bundle.channels[label]?.format !== "uint32x4" || codec !== void 0 && entry.codec !== codec) {
          codec = void 0;
          break;
        }
        codec = entry.codec;
        degrees &= entry.degrees;
        count += 1;
      }
      if (codec === void 0) {
        continue;
      }
      const counts = channelCounts[codec];
      for (let degree = MAX_DEGREE; degree >= 1; degree -= 1) {
        if ((degrees & 1 << degree) !== 0 && counts[degree] === count) {
          return { name, codec, degree };
        }
      }
    }
    return void 0;
  }
  // For file readers: a bundle for a file's `degree` (0..4) of SH in
  // `target` (default ext) and its encoder, or undefined when there is none
  // or it is skipped (then meta.ignoredShDegree is the degree)
  static prepare(data, degree, target = "ext") {
    const d = shDegreeOf(degree);
    data.meta.ignoredShDegree = d && target === false ? d : 0;
    if (!d || target === false) {
      return void 0;
    }
    _Sh.add(data, target, d);
    return _Sh.encoder(data);
  }
  // The encoder of a per-splat bundle: (i, coeffs) writes splat i
  static encoder(data, found = _Sh.find(data.bundles)) {
    if (!found) {
      throw new Error("No SH bundle");
    }
    const { degree } = found;
    const codec = _Sh.codec(found.codec);
    const channels = channelArrays(data.bundles[found.name]);
    const words = new Uint32Array(channels.length * 4);
    return (i, coeffs) => {
      codec.encode(coeffs, degree, words, 0);
      const at2 = i * 4;
      for (let t = 0; t < channels.length; t += 1) {
        const channel = channels[t];
        const w = t * 4;
        channel[at2] = words[w];
        channel[at2 + 1] = words[w + 1];
        channel[at2 + 2] = words[w + 2];
        channel[at2 + 3] = words[w + 3];
      }
    };
  }
  // The decoder of a per-splat bundle: (i, out) fills out with splat i's
  // coefficients (out holds at least COEFFICIENTS[degree] * 3 values)
  static decoder(data, found = _Sh.find(data.bundles)) {
    if (!found) {
      throw new Error("No SH bundle");
    }
    const { degree } = found;
    const codec = _Sh.codec(found.codec);
    const channels = channelArrays(data.bundles[found.name]);
    const words = new Uint32Array(channels.length * 4);
    return (i, out) => {
      const at2 = i * 4;
      for (let t = 0; t < channels.length; t += 1) {
        const channel = channels[t];
        const w = t * 4;
        words[w] = channel[at2];
        words[w + 1] = channel[at2 + 1];
        words[w + 2] = channel[at2 + 2];
        words[w + 3] = channel[at2 + 3];
      }
      return codec.decode(words, 0, degree, out);
    };
  }
  // `data` with its SH in `codec` (at most `degree`): `data` itself when it
  // already is, else a new ArrayData sharing every other bundle's arrays
  static convert(data, codec, { degree } = {}) {
    const found = _Sh.find(data.bundles);
    if (!found) {
      return data;
    }
    const to = Math.min(degree ?? found.degree, found.degree);
    if (found.codec === codec && to === found.degree) {
      return data;
    }
    const out = shareBundles(data, found.name);
    _Sh.add(out, codec, to);
    const decode = _Sh.decoder(data, found);
    const encode = _Sh.encoder(out);
    const coeffs = new Float32Array(VALUES);
    for (let i = 0; i < data.count; i += 1) {
      encode(i, decode(i, coeffs));
    }
    return out;
  }
  // The SH color of `coeffs` along unit `dir` (object space, from the view
  // to the splat) through `degree`, added to the base color by the caller
  static evaluate(coeffs, dir, degree, out = [0, 0, 0]) {
    _Sh.basis(dir, basis);
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    for (let k = 0; k < COEFFICIENTS[Math.max(0, Math.min(MAX_DEGREE, degree))]; k += 1) {
      out[0] += coeffs[k * 3] * basis[k];
      out[1] += coeffs[k * 3 + 1] * basis[k];
      out[2] += coeffs[k * 3 + 2] * basis[k];
    }
    return out;
  }
  // The 24 basis functions of bands 1-4 along unit `dir` (3DGS signs)
  static basis(dir, out = new Float64Array(COEFFICIENTS[MAX_DEGREE])) {
    const { x, y, z } = dir;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    out[0] = -0.4886025 * y;
    out[1] = 0.4886025 * z;
    out[2] = -0.4886025 * x;
    out[3] = 1.0925484 * x * y;
    out[4] = -1.0925484 * y * z;
    out[5] = 0.3153916 * (2 * zz - xx - yy);
    out[6] = -1.0925484 * x * z;
    out[7] = 0.5462742 * (xx - yy);
    out[8] = -0.5900436 * y * (3 * xx - yy);
    out[9] = 2.8906114 * x * y * z;
    out[10] = -0.4570458 * y * (4 * zz - xx - yy);
    out[11] = 0.3731763 * z * (2 * zz - 3 * xx - 3 * yy);
    out[12] = -0.4570458 * x * (4 * zz - xx - yy);
    out[13] = 1.4453057 * z * (xx - yy);
    out[14] = -0.5900436 * x * (xx - 3 * yy);
    out[15] = 2.5033429 * x * y * (xx - yy);
    out[16] = -1.7701308 * y * z * (3 * xx - yy);
    out[17] = 0.9461747 * x * y * (7 * zz - 1);
    out[18] = -0.6690465 * y * z * (7 * zz - 3);
    out[19] = 0.1057855 * (zz * (35 * zz - 30) + 3);
    out[20] = -0.6690465 * x * z * (7 * zz - 3);
    out[21] = 0.4730873 * (xx - yy) * (7 * zz - 1);
    out[22] = -1.7701308 * x * z * (xx - 3 * yy);
    out[23] = 0.6258357 * (xx * (xx - 3 * yy) - yy * (3 * xx - yy));
    return out;
  }
};
var basis = new Float64Array(COEFFICIENTS[MAX_DEGREE]);
var channelArrays = (bundle) => Object.values(bundle.channels).map((channel) => channel.data);
var channelRecord = (bundle) => Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data]));
function shareBundles(data, without) {
  const out = new ArrayData({ count: data.count, capacity: data.capacity, meta: { ...data.meta } });
  for (const [name, bundle] of Object.entries(data.bundles)) {
    if (name !== without) {
      out.addBundle(name, bundle.def, { data: channelRecord(bundle), meta: bundle.meta });
    }
  }
  return out;
}
var PALETTE = defineBundle({ shEntries: "uint32x4" });
var ShPalette = class _ShPalette {
  static BUNDLE = PALETTE;
  data;
  constructor(data) {
    if (data.bundles.shPalette?.channels.shEntries?.format !== "uint32x4") {
      throw new Error("Not an SH palette: no shPalette.shEntries channel");
    }
    this.data = data;
  }
  // The default stride of a codec's entries: its texels rounded up to a
  // power of two (1 / 2 / 4 / 8 for degree 1 / 2 / 3 / 4)
  static strideOf(codec, degree) {
    return 2 ** Math.ceil(Math.log2(Sh.texels(codec, degree)));
  }
  static create({ codec, degree, size, stride }) {
    const s = stride ?? _ShPalette.strideOf(codec, degree);
    if (s < Sh.texels(codec, degree)) {
      throw new Error(`Palette stride ${s} below the codec's ${Sh.texels(codec, degree)} texels`);
    }
    const data = new ArrayData({ count: size * s, meta: {} });
    data.addBundle("shPalette", PALETTE, { meta: { codec, degree, size, stride: s } });
    return new _ShPalette(data);
  }
  get meta() {
    return this.data.bundles.shPalette.meta;
  }
  get codec() {
    return Sh.codec(this.meta.codec).name;
  }
  get degree() {
    return this.meta.degree;
  }
  get size() {
    return this.meta.size;
  }
  get stride() {
    return this.meta.stride;
  }
  get words() {
    return this.data.bundles.shPalette.channels.shEntries.data;
  }
  set(n, coeffs) {
    Sh.codec(this.codec).encode(coeffs, this.degree, this.words, n * this.stride * 4);
  }
  get(n, out = new Float32Array(VALUES)) {
    return Sh.codec(this.codec).decode(this.words, n * this.stride * 4, this.degree, out);
  }
  // The same entries in another codec
  convert(codec, { stride } = {}) {
    const out = _ShPalette.create({ codec, degree: this.degree, size: this.size, stride });
    const coeffs = new Float32Array(VALUES);
    for (let n = 0; n < this.size; n += 1) {
      out.set(n, this.get(n, coeffs));
    }
    return out;
  }
  // Per-splat SH in `codec` for `labels` (one per splat), added to `data`
  expand(data, labels, codec = this.codec) {
    Sh.add(data, codec, this.degree);
    const encode = Sh.encoder(data);
    const coeffs = new Float32Array(VALUES);
    for (let i = 0; i < labels.length; i += 1) {
      encode(i, this.get(labels[i], coeffs));
    }
    return data;
  }
  // `data` with per-splat SH in place of its shLabel bundle: a new
  // ArrayData sharing every other bundle's arrays (`data` itself when it
  // has no labels)
  expanded(data, codec = this.codec) {
    const labels = data.bundles.shLabel?.channels.label?.data;
    if (!labels) {
      return data;
    }
    return this.expand(shareBundles(data, "shLabel"), labels.subarray(0, data.count), codec);
  }
};

// src/core/math.ts
var SplatMath = class _SplatMath {
  // Unit quaternion (identity for a zero one)
  static normalizeQuat(q, out) {
    const length6 = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (!(length6 > 0)) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      out.w = 1;
      return out;
    }
    out.x = q.x / length6;
    out.y = q.y / length6;
    out.z = q.z / length6;
    out.w = q.w / length6;
    return out;
  }
  // Sigma = M M^T with M = R(q) diag(scales)
  static covFromScaleQuat(scales, q, out) {
    const { x, y, z, w } = _SplatMath.normalizeQuat(q, { x: 0, y: 0, z: 0, w: 1 });
    const m = [
      scales.x * (1 - 2 * (y * y + z * z)),
      scales.x * 2 * (x * y + w * z),
      scales.x * 2 * (x * z - w * y),
      scales.y * 2 * (x * y - w * z),
      scales.y * (1 - 2 * (x * x + z * z)),
      scales.y * 2 * (y * z + w * x),
      scales.z * 2 * (x * z + w * y),
      scales.z * 2 * (y * z - w * x),
      scales.z * (1 - 2 * (x * x + y * y))
    ];
    const dot5 = (i, j) => m[i] * m[j] + m[i + 3] * m[j + 3] + m[i + 6] * m[j + 6];
    out.xx = dot5(0, 0);
    out.yy = dot5(1, 1);
    out.zz = dot5(2, 2);
    out.xy = dot5(0, 1);
    out.xz = dot5(0, 2);
    out.yz = dot5(1, 2);
    return out;
  }
  // Eigenvalues (descending) and eigenvectors (columns of `basis`,
  // right-handed) of a symmetric 3x3 matrix, by Jacobi rotations
  static symEigens(c) {
    const a = [c.xx, c.xy, c.xz, c.xy, c.yy, c.yz, c.xz, c.yz, c.zz];
    const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const at2 = (col, row) => col * 3 + row;
    const eps = 1e-9 * (Math.abs(c.xx) + Math.abs(c.yy) + Math.abs(c.zz));
    for (let iter = 0; iter < 16; iter += 1) {
      let p = 0;
      let q = 1;
      let max11 = Math.abs(a[at2(0, 1)]);
      if (Math.abs(a[at2(0, 2)]) > max11) {
        max11 = Math.abs(a[at2(0, 2)]);
        q = 2;
      }
      if (Math.abs(a[at2(1, 2)]) > max11) {
        max11 = Math.abs(a[at2(1, 2)]);
        p = 1;
        q = 2;
      }
      if (max11 <= eps) {
        break;
      }
      const phi = 0.5 * Math.atan2(2 * a[at2(p, q)], a[at2(q, q)] - a[at2(p, p)]);
      const cos4 = Math.cos(phi);
      const sin4 = Math.sin(phi);
      for (let r = 0; r < 3; r += 1) {
        const arp = a[at2(r, p)];
        const arq = a[at2(r, q)];
        a[at2(r, p)] = cos4 * arp - sin4 * arq;
        a[at2(r, q)] = sin4 * arp + cos4 * arq;
      }
      for (let r = 0; r < 3; r += 1) {
        const apr = a[at2(p, r)];
        const aqr = a[at2(q, r)];
        a[at2(p, r)] = cos4 * apr - sin4 * aqr;
        a[at2(q, r)] = sin4 * apr + cos4 * aqr;
      }
      a[at2(p, q)] = 0;
      a[at2(q, p)] = 0;
      for (let r = 0; r < 3; r += 1) {
        const vrp = v[at2(r, p)];
        const vrq = v[at2(r, q)];
        v[at2(r, p)] = cos4 * vrp - sin4 * vrq;
        v[at2(r, q)] = sin4 * vrp + cos4 * vrq;
      }
    }
    const pairs = [0, 1, 2].map((j) => {
      const vector = [v[at2(0, j)], v[at2(1, j)], v[at2(2, j)]];
      const length6 = Math.max(Math.hypot(vector[0], vector[1], vector[2]), 1e-30);
      return { value: a[at2(j, j)], vector: vector.map((x) => x / length6) };
    });
    pairs.sort((x, y) => y.value - x.value);
    const [v0, v1, v2] = pairs.map((pair) => pair.vector);
    const det = v0[0] * (v1[1] * v2[2] - v1[2] * v2[1]) - v1[0] * (v0[1] * v2[2] - v0[2] * v2[1]) + v2[0] * (v0[1] * v1[2] - v0[2] * v1[1]);
    if (det < 0) {
      v2[0] = -v2[0];
      v2[1] = -v2[1];
      v2[2] = -v2[2];
    }
    return { values: { x: pairs[0].value, y: pairs[1].value, z: pairs[2].value }, basis: [...v0, ...v1, ...v2] };
  }
  // Quaternion (w >= 0) of an orthonormal basis given as columns, after
  // glam's Quat::from_rotation_axes
  static basisToQuat(m, out) {
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
    let x;
    let y;
    let z;
    let w;
    if (m22 <= 0) {
      const dif10 = m11 - m00;
      const omm22 = 1 - m22;
      if (dif10 <= 0) {
        const four = omm22 - dif10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [four * inv, (m01 + m10) * inv, (m02 + m20) * inv, (m12 - m21) * inv];
      } else {
        const four = omm22 + dif10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [(m01 + m10) * inv, four * inv, (m12 + m21) * inv, (m20 - m02) * inv];
      }
    } else {
      const sum10 = m11 + m00;
      const opm22 = 1 + m22;
      if (sum10 <= 0) {
        const four = opm22 - sum10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [(m02 + m20) * inv, (m12 + m21) * inv, four * inv, (m01 - m10) * inv];
      } else {
        const four = opm22 + sum10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [(m12 - m21) * inv, (m20 - m02) * inv, (m01 - m10) * inv, four * inv];
      }
    }
    const s = w < 0 ? -1 : 1;
    return _SplatMath.normalizeQuat({ x: x * s, y: y * s, z: z * s, w: w * s }, out);
  }
};

// src/core/splats.ts
var EXT = defineBundle({ extA: "uint32x4", extB: "uint32x4" });
var COV = defineBundle({ covA: "uint32x4", covB: "uint32x4" });
var PACKED = defineBundle({ packed: "uint32x4" });
var LOD_TREE = defineBundle({ node: "uint32x2" });
var LAYOUTS = { extSplats: EXT, covSplats: COV, packedSplats: PACKED };
var DEFAULT_PACKED_ENCODING = { rgbMin: 0, rgbMax: 1, lnScaleMin: -12, lnScaleMax: 9 };
function hasLayout(bundle, layout) {
  const channels = LAYOUTS[layout].channels;
  const labels = Object.keys(channels);
  return labels.length === Object.keys(bundle.channels).length && labels.every((label) => bundle.channels[label]?.format === channels[label]);
}
var isExtBundle = (bundle) => "extA" in bundle.channels;
var isCovBundle = (bundle) => "covA" in bundle.channels;
var lnHalf = (v) => Encoding.encodeHalf(Math.log(v));
var expHalf = (h) => Math.exp(Encoding.decodeHalf(h));
function storeA(a, f, i4, center, opacity) {
  f[i4] = center.x;
  f[i4 + 1] = center.y;
  f[i4 + 2] = center.z;
  a[i4 + 3] = (a[i4 + 3] & 16777215 | Encoding.encodeLodOpacity(opacity) << 24) >>> 0;
}
function storeNormal(a, i4, normal) {
  a[i4 + 3] = (a[i4 + 3] & 4278190080 | Encoding.encodeOct24(normal)) >>> 0;
}
function loadCenterA(f, i4, out) {
  out.x = f[i4];
  out.y = f[i4 + 1];
  out.z = f[i4 + 2];
  return out;
}
function storeExtFields(a, f, b, i4, s) {
  storeA(a, f, i4, s.center, s.opacity);
  b[i4] = Encoding.encodeExtRgb(s.rgb);
  b[i4 + 1] = (lnHalf(s.scales.x) | lnHalf(s.scales.y) << 16) >>> 0;
  b[i4 + 2] = (b[i4 + 2] & 4294901760 | lnHalf(s.scales.z)) >>> 0;
  b[i4 + 3] = Encoding.encodeQuatOct32(s.quaternion);
}
function storeExtPbr(a, b, i4, p) {
  storeNormal(a, i4, p.normal);
  b[i4 + 2] = (b[i4 + 2] & 65535 | Encoding.encodeUnorm8(p.roughness) << 16 | Encoding.encodeUnorm8(p.metallic) << 24) >>> 0;
}
function loadExtFields(a, f, b, i4, out) {
  loadCenterA(f, i4, out.center);
  out.opacity = Encoding.decodeLodOpacity(a[i4 + 3] >>> 24);
  Encoding.decodeExtRgb(b[i4], out.rgb);
  out.scales.x = expHalf(b[i4 + 1] & 65535);
  out.scales.y = expHalf(b[i4 + 1] >>> 16);
  out.scales.z = expHalf(b[i4 + 2] & 65535);
  Encoding.decodeQuatOct32(b[i4 + 3], out.quaternion);
  return out;
}
function loadExtPbr(a, b, i4, out) {
  Encoding.decodeOct24(a[i4 + 3] & 16777215, out.normal);
  out.roughness = (b[i4 + 2] >>> 16 & 255) / 255;
  out.metallic = (b[i4 + 2] >>> 24) / 255;
  return out;
}
function encodeExtWords(a, f, b, i4, s) {
  a[i4 + 3] = 0;
  b[i4 + 2] = 0;
  storeExtFields(a, f, b, i4, s);
  storeExtPbr(a, b, i4, s);
}
function decodeExtWords(a, f, b, i4, out) {
  loadExtFields(a, f, b, i4, out);
  loadExtPbr(a, b, i4, out);
  return out;
}
function encodeCorrelation(value, a, b) {
  const c = Math.max(-1, Math.min(1, value / Math.sqrt(a * b)));
  if (c === 0 || !Number.isFinite(c)) {
    return 0;
  }
  return Math.sign(c) * Math.max(-100, Math.min(-1e-7, Math.log(Math.abs(c))));
}
function decodeCorrelation(encoded) {
  return encoded === 0 ? 0 : -Math.sign(encoded) * Math.exp(-Math.abs(encoded));
}
function storeCovFields(a, f, b, i4, center, cov, rgb2, opacity) {
  const { xx, yy, zz, xy, xz, yz } = cov;
  storeA(a, f, i4, center, opacity);
  b[i4] = Encoding.encodeExtRgb(rgb2);
  b[i4 + 1] = (lnHalf(xx) | lnHalf(yy) << 16) >>> 0;
  b[i4 + 2] = (lnHalf(zz) | Encoding.encodeHalf(encodeCorrelation(xy, xx, yy)) << 16) >>> 0;
  b[i4 + 3] = (Encoding.encodeHalf(encodeCorrelation(xz, xx, zz)) | Encoding.encodeHalf(encodeCorrelation(yz, yy, zz)) << 16) >>> 0;
}
function encodeCovWords(a, f, b, i4, c) {
  a[i4 + 3] = 0;
  storeCovFields(a, f, b, i4, c.center, c.cov, c.rgb, c.opacity);
  storeNormal(a, i4, c.normal);
}
function decodeCovWords(a, f, b, i4, out) {
  loadCenterA(f, i4, out.center);
  Encoding.decodeOct24(a[i4 + 3] & 16777215, out.normal);
  out.opacity = Encoding.decodeLodOpacity(a[i4 + 3] >>> 24);
  Encoding.decodeExtRgb(b[i4], out.rgb);
  const xx = expHalf(b[i4 + 1] & 65535);
  const yy = expHalf(b[i4 + 1] >>> 16);
  const zz = expHalf(b[i4 + 2] & 65535);
  out.cov.xx = xx;
  out.cov.yy = yy;
  out.cov.zz = zz;
  out.cov.xy = decodeCorrelation(Encoding.decodeHalf(b[i4 + 2] >>> 16)) * Math.sqrt(xx * yy);
  out.cov.xz = decodeCorrelation(Encoding.decodeHalf(b[i4 + 3] & 65535)) * Math.sqrt(xx * zz);
  out.cov.yz = decodeCorrelation(Encoding.decodeHalf(b[i4 + 3] >>> 16)) * Math.sqrt(yy * zz);
  return out;
}
function packedCodec({ rgbMin, rgbMax, lnScaleMin, lnScaleMax }) {
  const rgbRange = rgbMax - rgbMin;
  const lnStep = (lnScaleMax - lnScaleMin) / 254;
  const color = (v) => Encoding.encodeUnorm8((v - rgbMin) / rgbRange);
  const scale = (v) => v <= 0 ? 0 : Math.max(1, Math.min(255, Math.round((Math.log(v) - lnScaleMin) / lnStep) + 1));
  const colorOf = (byte) => rgbMin + byte / 255 * rgbRange;
  const scaleOf = (code) => code === 0 ? 0 : Math.exp(lnScaleMin + (code - 1) * lnStep);
  return {
    encode(data, i4, s) {
      const quat = Encoding.encodeQuatOct24(s.quaternion);
      data[i4] = (color(s.rgb.r) | color(s.rgb.g) << 8 | color(s.rgb.b) << 16 | Encoding.encodeUnorm8(s.opacity) << 24) >>> 0;
      data[i4 + 1] = (Encoding.encodeHalf(s.center.x) | Encoding.encodeHalf(s.center.y) << 16) >>> 0;
      data[i4 + 2] = (Encoding.encodeHalf(s.center.z) | (quat & 65535) << 16) >>> 0;
      data[i4 + 3] = (scale(s.scales.x) | scale(s.scales.y) << 8 | scale(s.scales.z) << 16 | quat >>> 16 << 24) >>> 0;
    },
    decode(data, i4, out) {
      const x = data[i4];
      const y = data[i4 + 1];
      const z = data[i4 + 2];
      const w = data[i4 + 3];
      out.rgb.r = colorOf(x & 255);
      out.rgb.g = colorOf(x >>> 8 & 255);
      out.rgb.b = colorOf(x >>> 16 & 255);
      out.opacity = (x >>> 24) / 255;
      out.center.x = Encoding.decodeHalf(y & 65535);
      out.center.y = Encoding.decodeHalf(y >>> 16);
      out.center.z = Encoding.decodeHalf(z & 65535);
      out.scales.x = scaleOf(w & 255);
      out.scales.y = scaleOf(w >>> 8 & 255);
      out.scales.z = scaleOf(w >>> 16 & 255);
      Encoding.decodeQuatOct24(z >>> 16 | w >>> 24 << 16, out.quaternion);
      return out;
    }
  };
}
var extWords = (bundle) => {
  const a = bundle.channels.extA.data;
  return { a, f: Encoding.floatView(a), b: bundle.channels.extB.data };
};
var covWords = (bundle) => {
  const a = bundle.channels.covA.data;
  return { a, f: Encoding.floatView(a), b: bundle.channels.covB.data };
};
var arraysOf = (bundle) => Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data]));
var covScratch = {
  center: { x: 0, y: 0, z: 0 },
  cov: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 },
  rgb: { r: 1, g: 1, b: 1 },
  opacity: 1,
  normal: { x: 0, y: 0, z: 0 }
};
var Splats = class _Splats {
  static EXT = EXT;
  static COV = COV;
  static PACKED = PACKED;
  static LOD_TREE = LOD_TREE;
  static LAYOUTS = LAYOUTS;
  static DEFAULT_PACKED_ENCODING = DEFAULT_PACKED_ENCODING;
  // --- Plain splat records ---
  static makeSplat() {
    return { center: { x: 0, y: 0, z: 0 }, scales: { x: 1, y: 1, z: 1 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, rgb: { r: 1, g: 1, b: 1 }, opacity: 1 };
  }
  static makePbr() {
    return { normal: { x: 0, y: 0, z: 0 }, roughness: 1, metallic: 0 };
  }
  static makeExtSplat() {
    return { ..._Splats.makeSplat(), ..._Splats.makePbr() };
  }
  static makeCovSplat() {
    return {
      center: { x: 0, y: 0, z: 0 },
      cov: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 },
      rgb: { r: 1, g: 1, b: 1 },
      opacity: 1,
      normal: { x: 0, y: 0, z: 0 }
    };
  }
  // --- Bundles and tables ---
  static packedEncodingOf(bundle) {
    return { ...DEFAULT_PACKED_ENCODING, ...bundle.meta.encoding };
  }
  static isExt(bundle) {
    return hasLayout(bundle, "extSplats");
  }
  static isCov(bundle) {
    return hasLayout(bundle, "covSplats");
  }
  static isPacked(bundle) {
    return hasLayout(bundle, "packedSplats");
  }
  static layoutOf(bundle) {
    return Object.keys(LAYOUTS).find((layout) => hasLayout(bundle, layout));
  }
  // The splat bundle among `bundles` (of an ArrayData or GpuArrays):
  // `name` when given, else the standard names first, then any bundle of a
  // splat layout
  static findBundle(bundles, name) {
    const names = name !== void 0 ? [name] : [...Object.keys(LAYOUTS), ...Object.keys(bundles)];
    for (const candidate of names) {
      const bundle = bundles[candidate];
      const layout = bundle && _Splats.layoutOf(bundle);
      if (layout) {
        return { name: candidate, layout };
      }
    }
    return void 0;
  }
  // The splat bundle of `data` (as findBundle), or undefined
  static find(data, name) {
    const found = _Splats.findBundle(data.bundles, name);
    return found && { ...found, bundle: data.bundles[found.name] };
  }
  // The splat bundle of `data`; throws when there is none
  static get(data, name) {
    const found = _Splats.find(data, name);
    if (!found) {
      throw new Error(name !== void 0 ? `Bundle ${name} is not a splat bundle` : "No extSplats, covSplats or packedSplats bundle");
    }
    return found;
  }
  // The tree beside the splats, when the data has one
  static findLodTree(data) {
    const bundle = data.bundles.lodTree;
    return bundle?.channels.node?.format === "uint32x2" ? bundle : void 0;
  }
  // Adds an empty splat bundle of `layout` (default extSplats), named after it
  static add(data, { layout = "extSplats", encoding } = {}) {
    const meta = layout === "packedSplats" ? { encoding: { ...DEFAULT_PACKED_ENCODING, ...encoding } } : {};
    data.addBundle(layout, LAYOUTS[layout], { meta });
    return data.bundles[layout];
  }
  // Empty splats of `layout` in a new ArrayData of `count` elements
  static make(count, { meta, ...target } = {}) {
    const data = new ArrayData({ count, meta });
    _Splats.add(data, target);
    return data;
  }
  // `data` with its splats in `layout` (packed: in `encoding`, default the
  // source's): `data` itself when they already are, else a new ArrayData
  // sharing every other bundle's arrays
  static convert(data, { layout, encoding }) {
    const found = _Splats.get(data);
    const source = found.layout === "packedSplats" ? _Splats.packedEncodingOf(found.bundle) : void 0;
    const sameEncoding = !encoding || layout !== "packedSplats" || source !== void 0 && Object.entries(encoding).every(([key, value]) => source[key] === value);
    if (found.layout === layout && found.name === layout && sameEncoding) {
      return data;
    }
    const out = new ArrayData({ count: data.count, capacity: data.capacity, meta: { ...data.meta } });
    for (const [name, bundle] of Object.entries(data.bundles)) {
      if (name !== found.name) {
        out.addBundle(name, bundle.def, { data: arraysOf(bundle), meta: bundle.meta });
      }
    }
    if (found.layout === layout && sameEncoding) {
      out.addBundle(layout, found.bundle.def, { data: arraysOf(found.bundle), meta: found.bundle.meta });
      return out;
    }
    const decode = _Splats.decoder(found.bundle);
    const encode = _Splats.encoder(_Splats.add(out, { layout, encoding: { ...source, ...encoding } }));
    const s = _Splats.makeExtSplat();
    for (let i = 0; i < data.count; i += 1) {
      encode(i, decode(i, s));
    }
    return out;
  }
  // --- One layout's words ---
  static encodeExt(bundle, i, s) {
    const { a, f, b } = extWords(bundle);
    encodeExtWords(a, f, b, i * 4, s);
  }
  static decodeExt(bundle, i, out) {
    const { a, f, b } = extWords(bundle);
    return decodeExtWords(a, f, b, i * 4, out);
  }
  static encodeCov(bundle, i, c) {
    const { a, f, b } = covWords(bundle);
    encodeCovWords(a, f, b, i * 4, c);
  }
  static decodeCov(bundle, i, out) {
    const { a, f, b } = covWords(bundle);
    return decodeCovWords(a, f, b, i * 4, out);
  }
  static encodePacked(bundle, i, s, encoding = _Splats.packedEncodingOf(bundle)) {
    packedCodec(encoding).encode(bundle.channels.packed.data, i * 4, s);
  }
  static decodePacked(bundle, i, out, encoding = _Splats.packedEncodingOf(bundle)) {
    return packedCodec(encoding).decode(bundle.channels.packed.data, i * 4, out);
  }
  // --- Any layout, by the bundle's type ---
  // The standard 3DGS fields of splat i (cov splats are diagonalized)
  static load(bundle, i, out) {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      return loadExtFields(a, f, b, i * 4, out);
    }
    if (isCovBundle(bundle)) {
      return _Splats.fromCov(_Splats.decodeCov(bundle, i, covScratch), out);
    }
    return _Splats.decodePacked(bundle, i, out);
  }
  // Writes the standard 3DGS fields; ext keeps its PBR bits, cov its normal
  static store(bundle, i, s) {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      storeExtFields(a, f, b, i * 4, s);
    } else if (isCovBundle(bundle)) {
      const { a, f, b } = covWords(bundle);
      storeCovFields(a, f, b, i * 4, s.center, SplatMath.covFromScaleQuat(s.scales, s.quaternion, covScratch.cov), s.rgb, s.opacity);
    } else {
      _Splats.encodePacked(bundle, i, s);
    }
  }
  static loadPbr(bundle, i, out) {
    return loadExtPbr(bundle.channels.extA.data, bundle.channels.extB.data, i * 4, out);
  }
  // Writes the PBR fields; keeps the 3DGS bits
  static storePbr(bundle, i, p) {
    storeExtPbr(bundle.channels.extA.data, bundle.channels.extB.data, i * 4, p);
  }
  static loadCenter(bundle, i, out) {
    if (isExtBundle(bundle)) {
      return loadCenterA(Encoding.floatView(bundle.channels.extA.data), i * 4, out);
    }
    if (isCovBundle(bundle)) {
      return loadCenterA(Encoding.floatView(bundle.channels.covA.data), i * 4, out);
    }
    const data = bundle.channels.packed.data;
    out.x = Encoding.decodeHalf(data[i * 4 + 1] & 65535);
    out.y = Encoding.decodeHalf(data[i * 4 + 1] >>> 16);
    out.z = Encoding.decodeHalf(data[i * 4 + 2] & 65535);
    return out;
  }
  // The encoder of the bundle's layout, made once for a loop over splats:
  // (i, s) writes every field the layout stores (ext all of them, cov the
  // covariance and normal, packed the 3DGS fields in its encoding)
  static encoder(bundle) {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      return (i, s) => encodeExtWords(a, f, b, i * 4, s);
    }
    if (isCovBundle(bundle)) {
      const { a, f, b } = covWords(bundle);
      const cov = _Splats.makeCovSplat();
      return (i, s) => {
        _Splats.toCov(s, cov);
        cov.normal.x = s.normal.x;
        cov.normal.y = s.normal.y;
        cov.normal.z = s.normal.z;
        encodeCovWords(a, f, b, i * 4, cov);
      };
    }
    const data = bundle.channels.packed.data;
    const codec = packedCodec(_Splats.packedEncodingOf(bundle));
    return (i, s) => codec.encode(data, i * 4, s);
  }
  // The decoder of the bundle's layout: (i, out) fills every field, with the
  // defaults for those the layout lacks (no normal, roughness 1, metallic 0)
  static decoder(bundle) {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      return (i, out) => decodeExtWords(a, f, b, i * 4, out);
    }
    const noPbr = (out, normal) => {
      out.normal.x = normal?.x ?? 0;
      out.normal.y = normal?.y ?? 0;
      out.normal.z = normal?.z ?? 0;
      out.roughness = 1;
      out.metallic = 0;
      return out;
    };
    if (isCovBundle(bundle)) {
      const { a, f, b } = covWords(bundle);
      const cov = _Splats.makeCovSplat();
      return (i, out) => {
        _Splats.fromCov(decodeCovWords(a, f, b, i * 4, cov), out);
        return noPbr(out, cov.normal);
      };
    }
    const data = bundle.channels.packed.data;
    const codec = packedCodec(_Splats.packedEncodingOf(bundle));
    return (i, out) => noPbr(codec.decode(data, i * 4, out));
  }
  // --- Conversions ---
  // The covariance of s; out.normal is left as is
  static toCov(s, out) {
    out.center.x = s.center.x;
    out.center.y = s.center.y;
    out.center.z = s.center.z;
    out.rgb.r = s.rgb.r;
    out.rgb.g = s.rgb.g;
    out.rgb.b = s.rgb.b;
    out.opacity = s.opacity;
    SplatMath.covFromScaleQuat(s.scales, s.quaternion, out.cov);
    return out;
  }
  // Diagonalizes the covariance; the normal is dropped
  static fromCov(c, out) {
    const { values, basis: basis3 } = SplatMath.symEigens(c.cov);
    out.center.x = c.center.x;
    out.center.y = c.center.y;
    out.center.z = c.center.z;
    out.rgb.r = c.rgb.r;
    out.rgb.g = c.rgb.g;
    out.rgb.b = c.rgb.b;
    out.opacity = c.opacity;
    out.scales.x = Math.sqrt(Math.max(values.x, 0));
    out.scales.y = Math.sqrt(Math.max(values.y, 0));
    out.scales.z = Math.sqrt(Math.max(values.z, 0));
    SplatMath.basisToQuat(basis3, out.quaternion);
    return out;
  }
};

// src/core/axes.ts
var SYSTEMS = [
  "LDB",
  "RDB",
  "LUB",
  "RUB",
  "LDF",
  "RDF",
  "LUF",
  "RUF",
  "LFD",
  "RFD",
  "LFU",
  "RFU",
  "LBD",
  "RBD",
  "LBU",
  "RBU"
];
var DIRECTIONS = {
  R: [1, 0, 0],
  L: [-1, 0, 0],
  U: [0, 1, 0],
  D: [0, -1, 0],
  B: [0, 0, 1],
  F: [0, 0, -1]
};
function axesOf(system) {
  if (!SYSTEMS.includes(system)) {
    throw new Error(`Unknown coordinate system ${String(system)}`);
  }
  return [...system].map((letter) => DIRECTIONS[letter]);
}
var FIT = Array.from({ length: 32 }, (_, k) => {
  const z = 1 - (2 * k + 1) / 32;
  const r = Math.sqrt(1 - z * z);
  const phi = k * 2.399963229728653 + 0.5;
  return { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
});
function bandMatrix(m, l) {
  const size = 2 * l + 1;
  const start = Sh.COEFFICIENTS[l - 1];
  const normal = new Float64Array(size * size);
  const right = new Float64Array(size * size);
  const a = new Float64Array(Sh.COEFFICIENTS[Sh.MAX_DEGREE]);
  const b = new Float64Array(Sh.COEFFICIENTS[Sh.MAX_DEGREE]);
  for (const d of FIT) {
    Sh.basis(d, a);
    Sh.basis({
      x: m[0] * d.x + m[3] * d.y + m[6] * d.z,
      y: m[1] * d.x + m[4] * d.y + m[7] * d.z,
      z: m[2] * d.x + m[5] * d.y + m[8] * d.z
    }, b);
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < size; j += 1) {
        normal[i * size + j] += a[start + i] * a[start + j];
        right[i * size + j] += a[start + i] * b[start + j];
      }
    }
  }
  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(normal[row * size + col]) > Math.abs(normal[pivot * size + col])) {
        pivot = row;
      }
    }
    for (let j = 0; j < size; j += 1) {
      [normal[col * size + j], normal[pivot * size + j]] = [normal[pivot * size + j], normal[col * size + j]];
      [right[col * size + j], right[pivot * size + j]] = [right[pivot * size + j], right[col * size + j]];
    }
    const inv = 1 / normal[col * size + col];
    for (let row = 0; row < size; row += 1) {
      if (row !== col) {
        const f = normal[row * size + col] * inv;
        for (let j = 0; j < size; j += 1) {
          normal[row * size + j] -= f * normal[col * size + j];
          right[row * size + j] -= f * right[col * size + j];
        }
      }
    }
  }
  for (let row = 0; row < size; row += 1) {
    const inv = 1 / normal[row * size + row];
    for (let j = 0; j < size; j += 1) {
      right[row * size + j] *= inv;
    }
  }
  return right.map((v) => Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v);
}
var Converter = class {
  matrix;
  identity;
  det;
  bands = [];
  scratch = new Float64Array(9);
  constructor(matrix) {
    this.matrix = matrix;
    this.identity = matrix.every((v, i2) => v === (i2 % 4 === 0 ? 1 : 0));
    const [a, b, c, d, e, f, g, h, i] = matrix;
    this.det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  }
  vec(v) {
    const m = this.matrix;
    const { x, y, z } = v;
    v.x = m[0] * x + m[1] * y + m[2] * z;
    v.y = m[3] * x + m[4] * y + m[5] * z;
    v.z = m[6] * x + m[7] * y + m[8] * z;
    return v;
  }
  quat(q) {
    const m = this.matrix;
    const d = this.det;
    const { x, y, z } = q;
    q.x = d * (m[0] * x + m[1] * y + m[2] * z);
    q.y = d * (m[3] * x + m[4] * y + m[5] * z);
    q.z = d * (m[6] * x + m[7] * y + m[8] * z);
    return q;
  }
  scales(s) {
    const m = this.matrix;
    const { x, y, z } = s;
    s.x = Math.abs(m[0]) * x + Math.abs(m[1]) * y + Math.abs(m[2]) * z;
    s.y = Math.abs(m[3]) * x + Math.abs(m[4]) * y + Math.abs(m[5]) * z;
    s.z = Math.abs(m[6]) * x + Math.abs(m[7]) * y + Math.abs(m[8]) * z;
    return s;
  }
  cov(c) {
    const m = this.matrix;
    const s = [c.xx, c.xy, c.xz, c.xy, c.yy, c.yz, c.xz, c.yz, c.zz];
    const ms = this.scratch;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        ms[i * 3 + j] = m[i * 3] * s[j] + m[i * 3 + 1] * s[3 + j] + m[i * 3 + 2] * s[6 + j];
      }
    }
    const at2 = (i, j) => ms[i * 3] * m[j * 3] + ms[i * 3 + 1] * m[j * 3 + 1] + ms[i * 3 + 2] * m[j * 3 + 2];
    c.xx = at2(0, 0);
    c.yy = at2(1, 1);
    c.zz = at2(2, 2);
    c.xy = at2(0, 1);
    c.xz = at2(0, 2);
    c.yz = at2(1, 2);
    return c;
  }
  splat(s) {
    this.vec(s.center);
    this.quat(s.quaternion);
    this.scales(s.scales);
    if ("normal" in s) {
      this.vec(s.normal);
    }
    return s;
  }
  sh(coeffs, degree) {
    if (this.identity) {
      return coeffs;
    }
    const tmp = this.scratch;
    for (let l = 1; l <= degree; l += 1) {
      const t = this.bands[l] ??= bandMatrix(this.matrix, l);
      const size = 2 * l + 1;
      const start = Sh.COEFFICIENTS[l - 1];
      for (let c = 0; c < 3; c += 1) {
        for (let i = 0; i < size; i += 1) {
          let sum = 0;
          for (let j = 0; j < size; j += 1) {
            sum += t[i * size + j] * coeffs[(start + j) * 3 + c];
          }
          tmp[i] = sum;
        }
        for (let i = 0; i < size; i += 1) {
          coeffs[(start + i) * 3 + c] = tmp[i];
        }
      }
    }
    return coeffs;
  }
};
var Axes = class _Axes {
  static SYSTEMS = SYSTEMS;
  // 3x3 row-major: coordinates in `from` to coordinates in `to`
  static matrix(from, to) {
    const a = axesOf(from);
    const b = axesOf(to);
    const m = [];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        m.push(b[i][0] * a[j][0] + b[i][1] * a[j][1] + b[i][2] * a[j][2]);
      }
    }
    return m;
  }
  static converter(from, to) {
    return new Converter(_Axes.matrix(from, to));
  }
  // A splat table in place: its splat bundle (any layout; cov through its
  // covariance), its per-splat SH, and `shPalette`'s entries when given;
  // sets meta.coordinateSystem to `to`. Other bundles are left as they are.
  static convert(data, to, {
    from = data.meta.coordinateSystem,
    shPalette,
    progress
  } = {}) {
    if (!from) {
      throw new Error("Axes.convert: the data's coordinate system is unknown (pass `from`)");
    }
    const c = _Axes.converter(from, to);
    if (!c.identity) {
      const { bundle } = Splats.get(data);
      const found = Sh.find(data.bundles);
      const decodeSh = found && Sh.decoder(data, found);
      const encodeSh = found && Sh.encoder(data, found);
      const coeffs = new Float32Array(Sh.VALUES);
      const tick = counter(progress, data.count, "encoding");
      if (Splats.isCov(bundle)) {
        const s = Splats.makeCovSplat();
        for (let i = 0; i < data.count; i += 1) {
          tick(i);
          Splats.decodeCov(bundle, i, s);
          c.vec(s.center);
          c.cov(s.cov);
          c.vec(s.normal);
          Splats.encodeCov(bundle, i, s);
        }
      } else {
        const decode = Splats.decoder(bundle);
        const encode = Splats.encoder(bundle);
        const s = Splats.makeExtSplat();
        for (let i = 0; i < data.count; i += 1) {
          tick(i);
          encode(i, c.splat(decode(i, s)));
        }
      }
      if (found) {
        for (let i = 0; i < data.count; i += 1) {
          encodeSh(i, c.sh(decodeSh(i, coeffs), found.degree));
        }
      }
      if (shPalette) {
        for (let n = 0; n < shPalette.size; n += 1) {
          shPalette.set(n, c.sh(shPalette.get(n, coeffs), shPalette.degree));
        }
      }
    }
    data.meta.coordinateSystem = to;
    return data;
  }
};

// src/core/compress.ts
function transposeBytes(data, stride) {
  if (data.byteLength % stride !== 0) {
    throw new Error("Data length must be divisible by the byte stride");
  }
  const output = new Uint8Array(data.byteLength);
  let out = 0;
  for (let offset = 0; offset < stride; offset += 1) {
    for (let i = offset; i < data.byteLength; i += stride) {
      output[out++] = data[i];
    }
  }
  return output;
}
async function pipe(data, transform) {
  const stream = new Blob([data]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
var ByteReader = class {
  // Bytes taken so far
  position = 0;
  // Unread chunks from `head` on, the first from `offset`
  chunks = [];
  head = 0;
  offset = 0;
  buffered = 0;
  reader;
  done = false;
  label;
  // `label` names the data in errors
  constructor(input, label = "Data") {
    this.label = label;
    if (input instanceof ReadableStream) {
      this.reader = input.getReader();
      return;
    }
    const bytes2 = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (bytes2.byteLength > 0) {
      this.chunks.push(bytes2);
    }
    this.buffered = bytes2.byteLength;
    this.done = true;
  }
  // Buffers at least n bytes, or all that remain; returns how many are
  async fill(n) {
    while (this.buffered < n && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
      } else if (value.byteLength > 0) {
        this.chunks.push(value);
        this.buffered += value.byteLength;
      }
    }
    return this.buffered;
  }
  take(n, consume) {
    const first = this.chunks[this.head];
    let out;
    if (n === 0) {
      out = new Uint8Array(0);
    } else if (first.byteLength - this.offset >= n) {
      out = first.subarray(this.offset, this.offset + n);
    } else {
      out = new Uint8Array(n);
      let at2 = 0;
      for (let k = this.head, from = this.offset; at2 < n; k += 1, from = 0) {
        const part = this.chunks[k].subarray(from, from + n - at2);
        out.set(part, at2);
        at2 += part.byteLength;
      }
    }
    if (consume) {
      this.drop(n);
    }
    return out;
  }
  drop(n) {
    this.position += n;
    this.buffered -= n;
    while (n > 0) {
      const left = this.chunks[this.head].byteLength - this.offset;
      if (n < left) {
        this.offset += n;
        break;
      }
      n -= left;
      this.head += 1;
      this.offset = 0;
    }
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
  async read(n) {
    if (await this.fill(n) < n) {
      throw new Error(`${this.label} ended unexpectedly`);
    }
    return this.take(n, true);
  }
  // Up to n bytes, fewer at the end
  async peek(n) {
    return this.take(Math.min(n, await this.fill(n)), false);
  }
  async skip(n) {
    while (n > 0) {
      const have = await this.fill(1);
      if (have === 0) {
        throw new Error(`${this.label} ended unexpectedly`);
      }
      const step = Math.min(n, have);
      this.drop(step);
      n -= step;
    }
  }
  async rest() {
    return this.take(await this.fill(Infinity), true);
  }
  async atEnd() {
    return await this.fill(1) === 0;
  }
  // The bytes not taken yet, buffered ones first
  stream() {
    return new ReadableStream({
      pull: async (controller) => {
        if (await this.fill(1) === 0) {
          controller.close();
          return;
        }
        controller.enqueue(this.take(this.chunks[this.head].byteLength - this.offset, true));
      },
      cancel: () => this.cancel()
    });
  }
  cancel() {
    void this.reader?.cancel().catch(() => {
    });
    this.done = true;
    this.chunks = [];
    this.head = 0;
    this.buffered = 0;
    this.offset = 0;
  }
};
var Compression = class {
  static gzip(bytes2) {
    return pipe(bytes2, new CompressionStream("gzip"));
  }
  static gunzip(bytes2) {
    return pipe(bytes2, new DecompressionStream("gzip"));
  }
  static async readBytes(input) {
    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (input instanceof Uint8Array) {
      return input;
    }
    return new Uint8Array(await new Response(input).arrayBuffer());
  }
  // `values` holds whole elements of `elementBytes` bytes
  static async compressTransposed(values, elementBytes) {
    const bytes2 = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    return pipe(transposeBytes(bytes2, elementBytes), new CompressionStream("gzip"));
  }
  static async decompressTransposed(bytes2, elementBytes) {
    const transposed = await pipe(bytes2, new DecompressionStream("gzip"));
    if (transposed.byteLength % elementBytes !== 0) {
      throw new Error("Decompressed length must be divisible by the element size");
    }
    return transposed.byteLength === 0 ? transposed : transposeBytes(transposed, transposed.byteLength / elementBytes);
  }
};

// src/core/ply.ts
var SH_C0 = 0.28209479177387814;
var HEADER_MAX_BYTES = 64 * 1024;
var POINT_SCALE = 1e-3;
var COMPRESSED_CHUNK_SIZE = 256;
var COMPRESSED_CHUNK_PROPERTIES = [
  "min_x",
  "min_y",
  "min_z",
  "max_x",
  "max_y",
  "max_z",
  "min_scale_x",
  "min_scale_y",
  "min_scale_z",
  "max_scale_x",
  "max_scale_y",
  "max_scale_z",
  "min_r",
  "min_g",
  "min_b",
  "max_r",
  "max_g",
  "max_b"
];
var COMPRESSED_VERTEX_PROPERTIES = ["packed_position", "packed_rotation", "packed_scale", "packed_color"];
var COMPRESSED_REQUIRED = 12;
var COLOR_DEFAULTS = [0, 0, 0, 1, 1, 1];
var TYPES = {
  char: { bytes: 1, scale: 127 },
  uchar: { bytes: 1, scale: 255 },
  short: { bytes: 2, scale: 32767 },
  ushort: { bytes: 2, scale: 65535 },
  int: { bytes: 4, scale: 2147483647 },
  uint: { bytes: 4, scale: 4294967295 },
  float: { bytes: 4, scale: 1 },
  double: { bytes: 8, scale: 1 }
};
async function readPly(input, { progress, sh, ...target } = {}) {
  const bytes2 = await Compression.readBytes(input);
  const header = parseHeader(bytes2);
  const { headerLength, littleEndian, elements, comments } = header;
  const vertex = elements.find((element) => element.name === "vertex");
  if (!vertex) {
    throw new Error("PLY has no vertex element");
  }
  const prop = (name) => vertex.properties.find((p) => p.name === name && !p.countType);
  const has = (name) => prop(name) !== void 0;
  const chunk = elements.find((element) => element.name === "chunk");
  if (chunk && COMPRESSED_VERTEX_PROPERTIES.every(has)) {
    return { splats: readCompressed({ bytes: bytes2, header, vertex, chunk, target, sh, progress }) };
  }
  const standard = ["x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "opacity", "f_dc_0", "f_dc_1", "f_dc_2"];
  const pointCloud = ["x", "y", "z", "red", "green", "blue"];
  const isStandard = standard.every(has);
  if (!isStandard && !pointCloud.every(has)) {
    throw new Error(`PLY vertex lacks ${(standard.some(has) ? standard : pointCloud).filter((name) => !has(name)).join(", ")}`);
  }
  if (vertex.properties.some((p) => p.countType)) {
    throw new Error("PLY vertex list properties are not supported");
  }
  let shRest = 0;
  while (has(`f_rest_${shRest}`)) {
    shRest += 1;
  }
  const normals = has("nx") && has("ny") && has("nz");
  const metallic = prop("metallic") ?? prop("metalness");
  const roughness = prop("roughness");
  const data = new ArrayData({ count: vertex.count, meta: { format: "ply", comments } });
  const encode = Splats.encoder(Splats.add(data, target));
  const degree = shDegree(shRest);
  const encodeSh = Sh.prepare(data, degree, sh);
  const offset = elementOffset(bytes2, headerLength, elements, vertex);
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const reader = (property, normalized = false) => property && propertyReader(view, property, littleEndian, normalized);
  const r = (name, normalized = false) => reader(prop(name), normalized);
  const [x, y, z] = [r("x"), r("y"), r("z")];
  const normal = normals ? [r("nx"), r("ny"), r("nz")] : void 0;
  const metal = reader(metallic, true);
  const rough = reader(roughness, true);
  const scale = isStandard ? ["scale_0", "scale_1", "scale_2"].map((name) => r(name)) : [];
  const rot = isStandard ? ["rot_1", "rot_2", "rot_3", "rot_0"].map((name) => r(name)) : [];
  const opacity = isStandard ? r("opacity") : reader(prop("alpha"), true);
  const color = isStandard ? ["f_dc_0", "f_dc_1", "f_dc_2"].map((name) => r(name)) : ["red", "green", "blue"].map((name) => r(name, true));
  const perChannel = shRest / 3;
  const shValues = Sh.COEFFICIENTS[degree] * 3;
  const rest = Array.from({ length: shValues }, (_, v) => r(`f_rest_${v % 3 * perChannel + Math.floor(v / 3)}`));
  const coeffs = new Float32Array(Sh.VALUES);
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const tick = counter(progress, vertex.count, "decoding");
  for (let i = 0; i < vertex.count; i += 1) {
    tick(i);
    const base = offset + i * vertex.recordSize;
    s.center.x = x(base);
    s.center.y = y(base);
    s.center.z = z(base);
    s.normal.x = normal ? normal[0](base) : 0;
    s.normal.y = normal ? normal[1](base) : 0;
    s.normal.z = normal ? normal[2](base) : 0;
    s.roughness = rough ? rough(base) : 1;
    s.metallic = metal ? metal(base) : 0;
    if (isStandard) {
      s.scales.x = Math.exp(scale[0](base));
      s.scales.y = Math.exp(scale[1](base));
      s.scales.z = Math.exp(scale[2](base));
      q.x = rot[0](base);
      q.y = rot[1](base);
      q.z = rot[2](base);
      q.w = rot[3](base);
      SplatMath.normalizeQuat(q, s.quaternion);
      s.opacity = 1 / (1 + Math.exp(-opacity(base)));
      s.rgb.r = 0.5 + SH_C0 * color[0](base);
      s.rgb.g = 0.5 + SH_C0 * color[1](base);
      s.rgb.b = 0.5 + SH_C0 * color[2](base);
    } else {
      s.scales.x = POINT_SCALE;
      s.scales.y = POINT_SCALE;
      s.scales.z = POINT_SCALE;
      s.opacity = opacity ? opacity(base) : 1;
      s.rgb.r = color[0](base);
      s.rgb.g = color[1](base);
      s.rgb.b = color[2](base);
    }
    encode(i, s);
    if (encodeSh) {
      for (let v = 0; v < shValues; v += 1) {
        coeffs[v] = rest[v](base);
      }
      encodeSh(i, coeffs);
    }
  }
  return { splats: data };
}
function readCompressed({ bytes: bytes2, header: { headerLength, littleEndian, elements, comments }, vertex, chunk, target, sh: shTarget, progress }) {
  for (const element of [chunk, vertex]) {
    if (element.properties.some((p) => p.countType)) {
      throw new Error(`PLY ${element.name} list properties are not supported`);
    }
  }
  const chunkProp = (name) => chunk.properties.find((p) => p.name === name);
  const missing = COMPRESSED_CHUNK_PROPERTIES.slice(0, COMPRESSED_REQUIRED).filter((name) => !chunkProp(name));
  if (missing.length > 0) {
    throw new Error(`PLY chunk lacks ${missing.join(", ")}`);
  }
  const chunks = Math.ceil(vertex.count / COMPRESSED_CHUNK_SIZE);
  if (chunk.count < chunks) {
    throw new Error(`PLY has ${chunk.count} chunks for ${vertex.count} splats`);
  }
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const stride = COMPRESSED_CHUNK_PROPERTIES.length;
  const ranges = new Float32Array(chunks * stride);
  const chunkOffset = elementOffset(bytes2, headerLength, elements, chunk);
  COMPRESSED_CHUNK_PROPERTIES.forEach((name, k) => {
    const property = chunkProp(name);
    const read = property && propertyReader(view, property, littleEndian);
    for (let c = 0; c < chunks; c += 1) {
      ranges[c * stride + k] = read ? read(chunkOffset + c * chunk.recordSize) : COLOR_DEFAULTS[k - COMPRESSED_REQUIRED];
    }
  });
  const sh = elements.find((element) => element.name === "sh");
  let shRest = 0;
  while (sh?.properties.some((p) => p.name === `f_rest_${shRest}`)) {
    shRest += 1;
  }
  const data = new ArrayData({ count: vertex.count, meta: { format: "ply", compressed: true, comments } });
  const encode = Splats.encoder(Splats.add(data, target));
  const degree = shDegree(shRest);
  const encodeSh = Sh.prepare(data, sh && sh.count >= vertex.count ? degree : 0, shTarget);
  const shValues = Sh.COEFFICIENTS[degree] * 3;
  const shOffset = sh && encodeSh ? elementOffset(bytes2, headerLength, elements, sh) : 0;
  const shBytes = Uint8Array.from({ length: shValues }, (_, v) => sh.properties.find((p) => p.name === `f_rest_${v % 3 * (shRest / 3) + Math.floor(v / 3)}`)?.offset ?? 0);
  const coeffs = new Float32Array(Sh.VALUES);
  const offset = elementOffset(bytes2, headerLength, elements, vertex);
  const [position, rotation, scale, color] = COMPRESSED_VERTEX_PROPERTIES.map((name) => propertyReader(view, vertex.properties.find((p) => p.name === name), littleEndian));
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const tick = counter(progress, vertex.count, "decoding");
  for (let i = 0; i < vertex.count; i += 1) {
    tick(i);
    const base = offset + i * vertex.recordSize;
    const at2 = Math.floor(i / COMPRESSED_CHUNK_SIZE) * stride;
    const p = position(base);
    s.center.x = ranges[at2] + (ranges[at2 + 3] - ranges[at2]) * ((p >>> 21 & 2047) / 2047);
    s.center.y = ranges[at2 + 1] + (ranges[at2 + 4] - ranges[at2 + 1]) * ((p >>> 11 & 1023) / 1023);
    s.center.z = ranges[at2 + 2] + (ranges[at2 + 5] - ranges[at2 + 2]) * ((p & 2047) / 2047);
    const l = scale(base);
    s.scales.x = Math.exp(ranges[at2 + 6] + (ranges[at2 + 9] - ranges[at2 + 6]) * ((l >>> 21 & 2047) / 2047));
    s.scales.y = Math.exp(ranges[at2 + 7] + (ranges[at2 + 10] - ranges[at2 + 7]) * ((l >>> 11 & 1023) / 1023));
    s.scales.z = Math.exp(ranges[at2 + 8] + (ranges[at2 + 11] - ranges[at2 + 8]) * ((l & 2047) / 2047));
    const r = rotation(base);
    const a = ((r >>> 20 & 1023) / 1023 - 0.5) * Math.SQRT2;
    const b = ((r >>> 10 & 1023) / 1023 - 0.5) * Math.SQRT2;
    const c = ((r & 1023) / 1023 - 0.5) * Math.SQRT2;
    const m = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
    const largest = r >>> 30;
    q.w = largest === 0 ? m : a;
    q.x = largest === 0 ? a : largest === 1 ? m : b;
    q.y = largest <= 1 ? b : largest === 2 ? m : c;
    q.z = largest <= 2 ? c : m;
    SplatMath.normalizeQuat(q, s.quaternion);
    const k = color(base);
    s.rgb.r = ranges[at2 + 12] + (ranges[at2 + 15] - ranges[at2 + 12]) * ((k >>> 24 & 255) / 255);
    s.rgb.g = ranges[at2 + 13] + (ranges[at2 + 16] - ranges[at2 + 13]) * ((k >>> 16 & 255) / 255);
    s.rgb.b = ranges[at2 + 14] + (ranges[at2 + 17] - ranges[at2 + 14]) * ((k >>> 8 & 255) / 255);
    s.opacity = (k & 255) / 255;
    encode(i, s);
    if (encodeSh) {
      const record2 = shOffset + i * sh.recordSize;
      for (let v = 0; v < shValues; v += 1) {
        coeffs[v] = SH_BYTE_VALUES[bytes2[record2 + shBytes[v]]];
      }
      encodeSh(i, coeffs);
    }
  }
  return data;
}
function decodeCompressedSh(byte) {
  return ((byte === 0 ? 0 : byte === 255 ? 1 : (byte + 0.5) / 256) - 0.5) * 8;
}
var SH_BYTE_VALUES = Float64Array.from({ length: 256 }, (_, byte) => decodeCompressedSh(byte));
function encodeCompressedSh(value) {
  return Math.max(0, Math.min(255, Math.trunc((value / 8 + 0.5) * 256)));
}
function writePly(data, { pbr = false, compatibility = false, sh = true, progress } = {}) {
  const decode = Splats.decoder(Splats.get(data).bundle);
  const found = sh ? Sh.find(data.bundles) : void 0;
  const decodeSh = found && Sh.decoder(data, found);
  const perChannel = found ? Sh.COEFFICIENTS[found.degree] : 0;
  const coeffs = new Float32Array(Sh.VALUES);
  const normals = pbr || compatibility;
  const names = [
    "x",
    "y",
    "z",
    ...normals ? ["nx", "ny", "nz"] : [],
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
    "opacity",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    ...Array.from({ length: perChannel * 3 }, (_, k) => `f_rest_${k}`),
    ...pbr ? ["roughness", "metallic"] : []
  ];
  const header = new TextEncoder().encode([
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${data.count}`,
    ...names.map((name) => `property float ${name}`),
    "end_header",
    ""
  ].join("\n"));
  const bytes2 = new Uint8Array(header.byteLength + data.count * names.length * 4);
  bytes2.set(header);
  const floats = new DataView(bytes2.buffer, header.byteLength);
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  let at2 = 0;
  const put = (value) => {
    floats.setFloat32(at2, value, true);
    at2 += 4;
  };
  const tick = counter(progress, data.count, "encoding");
  for (let i = 0; i < data.count; i += 1) {
    tick(i);
    decode(i, s);
    put(s.center.x);
    put(s.center.y);
    put(s.center.z);
    if (normals) {
      put(pbr ? s.normal.x : 0);
      put(pbr ? s.normal.y : 0);
      put(pbr ? s.normal.z : 0);
    }
    put(Math.log(Math.max(s.scales.x, 1e-12)));
    put(Math.log(Math.max(s.scales.y, 1e-12)));
    put(Math.log(Math.max(s.scales.z, 1e-12)));
    SplatMath.normalizeQuat(s.quaternion, q);
    put(q.w);
    put(q.x);
    put(q.y);
    put(q.z);
    const opacity = Math.max(1e-12, Math.min(1 - 1e-12, s.opacity));
    put(Math.max(-100, Math.min(100, Math.log(opacity / (1 - opacity)))));
    put((s.rgb.r - 0.5) / SH_C0);
    put((s.rgb.g - 0.5) / SH_C0);
    put((s.rgb.b - 0.5) / SH_C0);
    if (decodeSh) {
      decodeSh(i, coeffs);
      for (let c = 0; c < 3; c += 1) {
        for (let k = 0; k < perChannel; k += 1) {
          put(coeffs[k * 3 + c]);
        }
      }
    }
    if (pbr) {
      put(s.roughness);
      put(s.metallic);
    }
  }
  return bytes2;
}
var PlyFile = class {
  // { splats }: the bundle of the asked layout (default extSplats), its
  // SH included
  static read = readPly;
  // The splat bundle of `data` (any layout)
  static write = writePly;
};
function parseHeader(bytes2) {
  const text = new TextDecoder().decode(bytes2.subarray(0, Math.min(bytes2.byteLength, HEADER_MAX_BYTES)));
  const end = text.search(/end_header\r?\n/);
  if (!text.startsWith("ply") || end < 0) {
    throw new Error("Invalid PLY header");
  }
  const headerLength = new TextEncoder().encode(text.slice(0, end)).byteLength + text.slice(end).match(/end_header\r?\n/)[0].length;
  let littleEndian;
  const elements = [];
  const comments = [];
  for (const line of text.slice(0, end).split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "format") {
      if (fields[1] !== "binary_little_endian" && fields[1] !== "binary_big_endian") {
        throw new Error(`Unsupported PLY format ${fields[1]}`);
      }
      littleEndian = fields[1] === "binary_little_endian";
    } else if (fields[0] === "comment") {
      comments.push(line.trim().slice(8));
    } else if (fields[0] === "element") {
      elements.push({ name: fields[1], count: Number.parseInt(fields[2], 10), properties: [], recordSize: 0 });
    } else if (fields[0] === "property") {
      const element = elements.at(-1);
      if (!element) {
        throw new Error("PLY property outside an element");
      }
      if (fields[1] === "list") {
        element.properties.push({ name: fields[4], type: plyType(fields[3]), countType: plyType(fields[2]), offset: -1 });
      } else {
        const type = plyType(fields[1]);
        element.properties.push({ name: fields[2], type, offset: element.recordSize });
        element.recordSize += TYPES[type].bytes;
      }
    }
  }
  if (littleEndian === void 0) {
    throw new Error("PLY header has no format line");
  }
  return { headerLength, littleEndian, elements, comments };
}
function plyType(name) {
  const aliases = {
    int8: "char",
    uint8: "uchar",
    int16: "short",
    uint16: "ushort",
    int32: "int",
    uint32: "uint",
    float32: "float",
    float64: "double"
  };
  const type = aliases[name] ?? name;
  if (!TYPES[type]) {
    throw new Error(`Unsupported PLY property type ${name}`);
  }
  return type;
}
function shDegree(shRest) {
  return shRest >= 72 ? 4 : shRest >= 45 ? 3 : shRest >= 24 ? 2 : shRest > 0 ? 1 : 0;
}
function elementOffset(bytes2, headerLength, elements, element) {
  let offset = headerLength;
  for (const before of elements) {
    if (before === element) {
      break;
    }
    if (before.properties.some((p) => p.countType)) {
      throw new Error(`PLY element ${before.name} before ${element.name} has list properties`);
    }
    offset += before.count * before.recordSize;
  }
  if (offset + element.count * element.recordSize > bytes2.byteLength) {
    throw new Error("PLY file ended unexpectedly");
  }
  return offset;
}
function propertyReader(view, { offset: at2, type }, littleEndian, normalized = false) {
  if (type === "float") {
    return (base) => view.getFloat32(base + at2, littleEndian);
  }
  if (type === "uint" && !normalized) {
    return (base) => view.getUint32(base + at2, littleEndian);
  }
  const scale = normalized ? TYPES[type].scale : 1;
  return (base) => readScalar(view, base + at2, type, littleEndian) / scale;
}
function readScalar(view, offset, type, littleEndian) {
  switch (type) {
    case "char":
      return view.getInt8(offset);
    case "uchar":
      return view.getUint8(offset);
    case "short":
      return view.getInt16(offset, littleEndian);
    case "ushort":
      return view.getUint16(offset, littleEndian);
    case "int":
      return view.getInt32(offset, littleEndian);
    case "uint":
      return view.getUint32(offset, littleEndian);
    case "float":
      return view.getFloat32(offset, littleEndian);
    case "double":
      return view.getFloat64(offset, littleEndian);
  }
}

// src/core/sort.ts
var FLOAT_BITS_INFINITY = 2139095040;
var f322 = new Float32Array(1);
var u322 = new Uint32Array(f322.buffer);
var histogramLo = new Uint32Array(65536);
var histogramHi = new Uint32Array(65536);
var scratchIndex = new Uint32Array(0);
var scratchDigit = new Uint16Array(0);
var SortKeys = class _SortKeys {
  // The float bits 16-bit keys cover (distances 2^-32..2^32)
  static KEY16_LO = 95 << 23;
  static KEY16_HI = (159 << 23) - 1;
  // Sort keys as projections write them: the 4 bytes of a key per RGBA8
  // texel, read back as a Uint32Array (little-endian)
  static KEYS = defineBundle({ key: "unorm8x4" }, { serialize: false });
  // The invalid key of a width: all ones
  static invalid(bits) {
    return 2 ** bits - 1;
  }
  static validMax(bits) {
    return 255 * 2 ** (bits - 8) - 1;
  }
  // Key of a distance >= 0; non-finite distances give the invalid key
  static compute(distance, bits) {
    const mask = _SortKeys.invalid(bits);
    f322[0] = distance;
    const f = u322[0];
    if (!(f < FLOAT_BITS_INFINITY)) {
      return mask;
    }
    const q = bits === 32 ? f : bits === 24 ? f >>> 7 : Math.min(Math.max(f, _SortKeys.KEY16_LO), _SortKeys.KEY16_HI) - _SortKeys.KEY16_LO >>> 13;
    return Math.min((mask ^ q) >>> 0, _SortKeys.validMax(bits));
  }
  // Stable ascending sort of `count` keys into `ordering` (indices; by
  // default a whole capacity, as an ArrayData.INDICES channel holds). Invalid keys sort
  // last; `visible` counts the others. 16-bit keys take one counting pass,
  // 24-bit keys two LSD passes of 11 and 13 bits, 32-bit keys two of 16.
  static sort({ keys, count, bits, ordering = new Uint32Array(TextureLayout.alignCapacity(count)) }) {
    if (ordering.length < count) {
      throw new Error(`SortKeys.sort: ordering holds ${ordering.length} of ${count} indices`);
    }
    if (scratchIndex.length < count) {
      scratchIndex = new Uint32Array(count);
      scratchDigit = new Uint16Array(count);
    }
    const visible = bits === 16 ? sort1x16(keys, count, ordering) : bits === 24 ? sort11x13(keys, count, ordering) : sort2x16(keys, count, ordering);
    return { ordering, visible };
  }
};
function prefixSum(histogram, last) {
  let sum = 0;
  for (let d = 0; d <= last; d += 1) {
    const n = histogram[d];
    histogram[d] = sum;
    sum += n;
  }
}
function sort1x16(keys, count, ordering) {
  const histogram = histogramLo;
  histogram.fill(0);
  for (let i = 0; i < count; i += 1) {
    histogram[keys[i] & 65535] += 1;
  }
  const visible = count - histogram[65535];
  prefixSum(histogram, 65535);
  for (let i = 0; i < count; i += 1) {
    ordering[histogram[keys[i] & 65535]++] = i;
  }
  return visible;
}
function sort11x13(keys, count, ordering) {
  const lo = histogramLo;
  const hi = histogramHi;
  lo.fill(0, 0, 2048);
  hi.fill(0, 0, 8192);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    lo[k & 2047] += 1;
    hi[k >>> 11] += 1;
  }
  const visible = count - hi[8191];
  prefixSum(lo, 2047);
  prefixSum(hi, 8191);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    const pos = lo[k & 2047]++;
    scratchIndex[pos] = i;
    scratchDigit[pos] = k >>> 11;
  }
  for (let j = 0; j < count; j += 1) {
    ordering[hi[scratchDigit[j]]++] = scratchIndex[j];
  }
  return visible;
}
function sort2x16(keys, count, ordering) {
  const lo = histogramLo;
  const hi = histogramHi;
  lo.fill(0);
  hi.fill(0);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    lo[k & 65535] += 1;
    hi[k >>> 16] += 1;
  }
  const visible = count - hi[65535];
  prefixSum(lo, 65535);
  prefixSum(hi, 65535);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    const pos = lo[k & 65535]++;
    scratchIndex[pos] = i;
    scratchDigit[pos] = k >>> 16;
  }
  for (let j = 0; j < count; j += 1) {
    ordering[hi[scratchDigit[j]]++] = scratchIndex[j];
  }
  return visible;
}

// src/core/compressedPly.ts
var VALUES2 = 14;
var LN_SCALE_LIMIT = 20;
function writeCompressedPly(data, { sort = true, sh = true, progress } = {}) {
  const { count } = data;
  const decode = Splats.decoder(Splats.get(data).bundle);
  const found = sh ? Sh.find(data.bundles) : void 0;
  const decodeSh = found && Sh.decoder(data, found);
  const perChannel = found ? Sh.COEFFICIENTS[Math.min(found.degree, 3)] : 0;
  const shValues = perChannel * 3;
  const tick = counter(progress, 2 * count, "encoding");
  const values = new Float32Array(count * VALUES2);
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  for (let i = 0; i < count; i += 1) {
    tick(i);
    decode(i, s);
    SplatMath.normalizeQuat(s.quaternion, q);
    const v = i * VALUES2;
    values[v] = s.center.x;
    values[v + 1] = s.center.y;
    values[v + 2] = s.center.z;
    values[v + 3] = lnScale(s.scales.x);
    values[v + 4] = lnScale(s.scales.y);
    values[v + 5] = lnScale(s.scales.z);
    values[v + 6] = q.w;
    values[v + 7] = q.x;
    values[v + 8] = q.y;
    values[v + 9] = q.z;
    values[v + 10] = s.rgb.r;
    values[v + 11] = s.rgb.g;
    values[v + 12] = s.rgb.b;
    values[v + 13] = s.opacity;
  }
  const order = sort ? mortonOrder(values, count) : void 0;
  const chunks = Math.ceil(count / COMPRESSED_CHUNK_SIZE);
  const header = new TextEncoder().encode([
    "ply",
    "format binary_little_endian 1.0",
    "comment Generated by Radix",
    `element chunk ${chunks}`,
    ...COMPRESSED_CHUNK_PROPERTIES.map((name) => `property float ${name}`),
    `element vertex ${count}`,
    ...COMPRESSED_VERTEX_PROPERTIES.map((name) => `property uint ${name}`),
    ...shValues > 0 ? [`element sh ${count}`, ...Array.from({ length: shValues }, (_, k) => `property uchar f_rest_${k}`)] : [],
    "end_header",
    ""
  ].join("\n"));
  const stride = COMPRESSED_CHUNK_PROPERTIES.length;
  const vertexStart = header.byteLength + chunks * stride * 4;
  const shStart = vertexStart + count * COMPRESSED_VERTEX_PROPERTIES.length * 4;
  const bytes2 = new Uint8Array(shStart + count * shValues);
  bytes2.set(header);
  const view = new DataView(bytes2.buffer);
  const range2 = new Float32Array(stride);
  const extend = (at2, value) => {
    range2[at2] = Math.min(range2[at2], value);
    range2[at2 + 3] = Math.max(range2[at2 + 3], value);
  };
  for (let c = 0; c < chunks; c += 1) {
    const start = c * COMPRESSED_CHUNK_SIZE;
    const end = Math.min(count, start + COMPRESSED_CHUNK_SIZE);
    for (let g = 0; g < stride; g += 6) {
      range2.fill(Infinity, g, g + 3);
      range2.fill(-Infinity, g + 3, g + 6);
    }
    for (let j = start; j < end; j += 1) {
      const v = (order ? order[j] : j) * VALUES2;
      for (let k = 0; k < 3; k += 1) {
        extend(k, values[v + k]);
        extend(6 + k, values[v + 3 + k]);
        extend(12 + k, values[v + 10 + k]);
      }
    }
    for (let k = 0; k < stride; k += 1) {
      view.setFloat32(header.byteLength + (c * stride + k) * 4, range2[k], true);
    }
    for (let j = start; j < end; j += 1) {
      tick(count + j);
      const v = (order ? order[j] : j) * VALUES2;
      const at2 = vertexStart + j * 16;
      view.setUint32(at2, pack111011(values, v, range2, 0), true);
      view.setUint32(at2 + 4, packRotation(values, v + 6), true);
      view.setUint32(at2 + 8, pack111011(values, v + 3, range2, 6), true);
      view.setUint32(at2 + 12, packColor(values, v + 10, range2), true);
    }
  }
  if (decodeSh) {
    const coeffs = new Float32Array(Sh.VALUES);
    for (let j = 0; j < count; j += 1) {
      decodeSh(order ? order[j] : j, coeffs);
      const at2 = shStart + j * shValues;
      for (let c = 0; c < 3; c += 1) {
        for (let k = 0; k < perChannel; k += 1) {
          bytes2[at2 + c * perChannel + k] = encodeCompressedSh(coeffs[k * 3 + c]);
        }
      }
    }
  }
  return bytes2;
}
var CompressedPlyFile = class {
  // Either kind of PLY (the same as PlyFile.read)
  static read = PlyFile.read;
  // The splat bundle of `data` (any layout)
  static write = writeCompressedPly;
};
function lnScale(scale) {
  return Math.max(-LN_SCALE_LIMIT, Math.min(LN_SCALE_LIMIT, Math.log(scale)));
}
function unorm(value, min8, max11, bits) {
  const top = 2 ** bits - 1;
  const t = max11 > min8 ? (value - min8) / (max11 - min8) : 0;
  return Math.max(0, Math.min(top, Math.floor(t * top + 0.5)));
}
function pack111011(values, v, range2, at2) {
  return unorm(values[v], range2[at2], range2[at2 + 3], 11) * 2 ** 21 + unorm(values[v + 1], range2[at2 + 1], range2[at2 + 4], 10) * 2 ** 11 + unorm(values[v + 2], range2[at2 + 2], range2[at2 + 5], 11);
}
function packColor(values, v, range2) {
  return unorm(values[v], range2[12], range2[15], 8) * 2 ** 24 + unorm(values[v + 1], range2[13], range2[16], 8) * 2 ** 16 + unorm(values[v + 2], range2[14], range2[17], 8) * 2 ** 8 + unorm(values[v + 3], 0, 1, 8);
}
function packRotation(values, v) {
  let largest = 0;
  for (let k = 1; k < 4; k += 1) {
    if (Math.abs(values[v + k]) > Math.abs(values[v + largest])) {
      largest = k;
    }
  }
  const sign2 = values[v + largest] < 0 ? -1 : 1;
  let word = largest;
  for (let k = 0; k < 4; k += 1) {
    if (k !== largest) {
      word = word * 1024 + unorm(sign2 * values[v + k] * Math.SQRT1_2 + 0.5, 0, 1, 10);
    }
  }
  return word;
}
function mortonOrder(values, count) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k], values[i * VALUES2 + k]);
      hi[k] = Math.max(hi[k], values[i * VALUES2 + k]);
    }
  }
  const cell = (value, k) => hi[k] > lo[k] ? Math.min(1023, Math.floor(1024 * (value - lo[k]) / (hi[k] - lo[k]))) : 0;
  const keys = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    const v = i * VALUES2;
    keys[i] = (spread3(cell(values[v + 2], 2)) << 2 | spread3(cell(values[v + 1], 1)) << 1 | spread3(cell(values[v], 0))) >>> 0;
  }
  return SortKeys.sort({ keys, count, bits: 32 }).ordering;
}
function spread3(x) {
  let s = (x ^ x << 16) & 4278190335;
  s = (s ^ s << 8) & 50393103;
  s = (s ^ s << 4) & 51130563;
  return (s ^ s << 2) & 153391689;
}

// src/core/rad.ts
var SH_BANDS = [["sh1", 9], ["sh2", 15], ["sh3", 21]];
var RAD_MAGIC = 809779538;
var RAD_CHUNK_MAGIC = 1128546642;
var RAD_CHUNK_SIZE = 65536;
var fromHalf = Encoding.decodeHalf;
var pad8 = (n) => n + 7 & ~7;
async function readRad(input, { progress, sh, ...target } = {}) {
  const bytes2 = await Compression.readBytes(input);
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const json = (at2, length6) => JSON.parse(new TextDecoder().decode(bytes2.subarray(at2, at2 + length6)));
  const magic = view.getUint32(0, true);
  const meta = json(8, view.getUint32(4, true));
  let chunks;
  if (magic === RAD_MAGIC) {
    if (meta.version !== 1 || meta.type !== "gsplat") {
      throw new Error(`Unsupported RAD version ${String(meta.version)} or type ${String(meta.type)}`);
    }
    const start = 8 + pad8(view.getUint32(4, true));
    chunks = meta.chunks.map((range2) => {
      if (range2.filename) {
        throw new Error("RAD external chunk files are not supported");
      }
      return { at: start + range2.offset, standalone: false };
    });
  } else if (magic === RAD_CHUNK_MAGIC) {
    chunks = [{ at: 0, standalone: true }];
  } else {
    throw new Error(`Invalid RAD magic 0x${magic.toString(16)}`);
  }
  const count = meta.count;
  const lod = (meta.lodTree ?? meta.lod_tree) === true;
  const maxSh = Number(meta.maxSh ?? meta.max_sh ?? 0);
  const codeCount = Number(meta.shCodeCount ?? meta.sh_code_count ?? 0);
  const data = new ArrayData({ count, meta: { format: "rad" } });
  const encode = Splats.encoder(Splats.add(data, target));
  let clusters;
  let encodeSh;
  if (codeCount > 0 && sh !== false && maxSh >= 1 && maxSh <= 3) {
    data.meta.ignoredShDegree = 0;
    clusters = { palette: ShPalette.create({ codec: sh ?? "ext", degree: maxSh, size: codeCount }), labels: new Uint32Array(count), read: false };
  } else {
    encodeSh = Sh.prepare(data, maxSh, sh);
  }
  const nodes3 = lod ? data.addBundle("lodTree", Splats.LOD_TREE).bundles.lodTree.channels.node.data : void 0;
  for (const [index, { at: at2, standalone }] of chunks.entries()) {
    progress?.(index / chunks.length, "decoding");
    if (view.getUint32(at2, true) !== RAD_CHUNK_MAGIC) {
      throw new Error("Invalid RAD chunk");
    }
    const length6 = view.getUint32(at2 + 4, true);
    const raw = json(at2 + 8, length6);
    const chunk = {
      base: standalone ? 0 : raw.base,
      count: raw.count,
      payloadBytes: raw.payloadBytes ?? raw.payload_bytes,
      lodTree: (raw.lodTree ?? raw.lod_tree) === true,
      properties: raw.properties
    };
    const payloadAt = at2 + 8 + pad8(length6) + 8;
    await decodeChunk(chunk, bytes2.subarray(payloadAt, payloadAt + chunk.payloadBytes), encode, nodes3, encodeSh && { encode: encodeSh, degree: maxSh }, clusters);
  }
  progress?.(1, "decoding");
  if (!clusters) {
    return { splats: data };
  }
  const { palette, labels } = clusters;
  if (!clusters.read) {
    throw new Error("RAD file with shCodeCount misses sh1_code");
  }
  for (let i = 0; i < count; i += 1) {
    if (labels[i] >= palette.size) {
      throw new Error(`RAD sh_label ${labels[i]} past shCodeCount ${palette.size}`);
    }
  }
  if (palette.size > 65536) {
    palette.expand(data, labels);
    return { splats: data };
  }
  data.addBundle("shLabel", Sh.LABEL).bundles.shLabel.channels.label.data.set(labels);
  return { splats: data, shPalette: palette };
}
async function decodeChunk(chunk, payload, encode, nodes3, sh, clusters) {
  const n = chunk.count;
  const columns = {};
  const codes = {};
  for (const property of chunk.properties) {
    let bytes2 = payload.subarray(property.offset, property.offset + property.bytes);
    if (property.compression) {
      bytes2 = await decompress(bytes2);
    }
    switch (property.property) {
      case "center":
      case "alpha":
      case "rgb":
      case "scales":
        columns[property.property] = decodeNumbers(property, bytes2, property.property === "alpha" ? 1 : 3, n);
        break;
      case "orientation":
        columns.orientation = decodeOrientation(property, bytes2, n);
        break;
      case "child_count":
      case "child_start":
        columns[property.property] = decodeUints(property, bytes2, n);
        break;
      case "sh1":
      case "sh2":
      case "sh3":
        if (sh) {
          columns[property.property] = decodeNumbers(property, bytes2, SH_BANDS.find(([name]) => name === property.property)[1], n);
        }
        break;
      case "sh1_code":
      case "sh2_code":
      case "sh3_code":
        if (clusters) {
          const band = property.property.slice(0, 3);
          codes[band] = decodeNumbers(property, bytes2, SH_BANDS.find(([name]) => name === band)[1], clusters.palette.size);
        }
        break;
      case "sh_label":
        if (clusters) {
          clusters.labels.set(decodeUints(property, bytes2, n), chunk.base);
        }
        break;
    }
  }
  for (const required of ["center", "alpha", "rgb", "scales", "orientation"]) {
    if (n > 0 && !columns[required]) {
      throw new Error(`RAD chunk misses ${required}`);
    }
  }
  const { center, alpha, rgb: rgb2, scales, orientation, child_count: childCounts, child_start: childStarts } = columns;
  const s = Splats.makeExtSplat();
  for (let i = 0; i < n; i += 1) {
    s.center.x = center[i * 3];
    s.center.y = center[i * 3 + 1];
    s.center.z = center[i * 3 + 2];
    s.opacity = alpha[i];
    s.rgb.r = rgb2[i * 3];
    s.rgb.g = rgb2[i * 3 + 1];
    s.rgb.b = rgb2[i * 3 + 2];
    s.scales.x = scales[i * 3];
    s.scales.y = scales[i * 3 + 1];
    s.scales.z = scales[i * 3 + 2];
    s.quaternion.x = orientation[i * 4];
    s.quaternion.y = orientation[i * 4 + 1];
    s.quaternion.z = orientation[i * 4 + 2];
    s.quaternion.w = orientation[i * 4 + 3];
    encode(chunk.base + i, s);
  }
  if (sh) {
    gatherSh(n, sh.degree, columns, (i, coeffs) => sh.encode(chunk.base + i, coeffs));
  }
  if (clusters && codes.sh1) {
    const { palette } = clusters;
    gatherSh(palette.size, palette.degree, codes, (e, coeffs) => palette.set(e, coeffs));
    clusters.read = true;
  }
  if (nodes3 && chunk.lodTree) {
    if (!childCounts || !childStarts) {
      throw new Error("RAD chunk misses child_count or child_start");
    }
    for (let i = 0; i < n; i += 1) {
      nodes3[(chunk.base + i) * 2] = childCounts[i];
      nodes3[(chunk.base + i) * 2 + 1] = childStarts[i];
    }
  }
}
function gatherSh(n, degree, columns, put) {
  const coeffs = new Float32Array(Sh.VALUES);
  const bands = SH_BANDS.slice(0, degree).map(([name, values]) => ({ values, column: columns[name] }));
  for (let i = 0; i < n; i += 1) {
    let at2 = 0;
    for (let b = 0; b < bands.length; b += 1) {
      const { values, column } = bands[b];
      for (let v = 0; v < values; v += 1) {
        coeffs[at2 + v] = column ? column[i * values + v] : 0;
      }
      at2 += values;
    }
    put(i, coeffs);
  }
}
var f323 = new Float32Array(1);
var u323 = new Uint32Array(f323.buffer);
var floatOfBits = (bits) => {
  u323[0] = bits;
  return f323[0];
};
function decodeNumbers(property, bytes2, dims, n) {
  const out = new Float32Array(dims * n);
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const stride = dims * n;
  const min8 = property.min ?? 0;
  const max11 = property.max ?? 1;
  const signed = (byte) => (byte << 24 >> 24) / 127 * max11;
  for (let d = 0; d < dims; d += 1) {
    let last = 0;
    for (let i = 0; i < n; i += 1) {
      const k = d * n + i;
      let value;
      switch (property.encoding) {
        case "f32":
          value = view.getFloat32(k * 4, true);
          break;
        case "f16":
          value = fromHalf(view.getUint16(k * 2, true));
          break;
        case "f32_lebytes":
          value = floatOfBits((bytes2[k] | bytes2[k + stride] << 8 | bytes2[k + stride * 2] << 16 | bytes2[k + stride * 3] << 24) >>> 0);
          break;
        case "f16_lebytes":
          value = fromHalf(bytes2[k] | bytes2[k + stride] << 8);
          break;
        case "r8":
          value = bytes2[k] / 255 * (max11 - min8) + min8;
          break;
        case "r8_delta":
          last = last + bytes2[k] & 255;
          value = last / 255 * (max11 - min8) + min8;
          break;
        case "s8":
          value = signed(bytes2[k]);
          break;
        case "s8_delta":
          last = last + bytes2[k] & 255;
          value = signed(last);
          break;
        case "ln_0r8":
          value = bytes2[k] === 0 ? 0 : Math.exp(min8 + (bytes2[k] - 1) * ((max11 - min8) / 254));
          break;
        case "ln_f16":
          value = Math.exp(fromHalf(view.getUint16(k * 2, true)));
          break;
        default:
          throw new Error(`Unsupported RAD ${property.property} encoding ${property.encoding}`);
      }
      out[i * dims + d] = value;
    }
  }
  return out;
}
function decodeOrientation(property, bytes2, n) {
  const out = new Float32Array(n * 4);
  if (property.encoding === "oct88r8") {
    const axis = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i += 1) {
      const code = bytes2[i * 3] | bytes2[i * 3 + 1] << 8;
      if (code === 0) {
        Object.assign(axis, { x: 0, y: 0, z: -1 });
      } else {
        Encoding.decodeOct(code, 8, axis);
      }
      const angle = bytes2[i * 3 + 2] / 255 * Math.PI;
      const s = Math.sin(angle / 2);
      out[i * 4] = axis.x * s;
      out[i * 4 + 1] = axis.y * s;
      out[i * 4 + 2] = axis.z * s;
      out[i * 4 + 3] = Math.cos(angle / 2);
    }
    return out;
  }
  const xyz = decodeNumbers(property, bytes2, 3, n);
  for (let i = 0; i < n; i += 1) {
    const x = xyz[i * 3];
    const y = xyz[i * 3 + 1];
    const z = xyz[i * 3 + 2];
    out[i * 4] = x;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = z;
    out[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  }
  return out;
}
function decodeUints(property, bytes2, n) {
  if (property.encoding !== "u16" && property.encoding !== "u32") {
    throw new Error(`Unsupported RAD ${property.property} encoding ${property.encoding}`);
  }
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = property.encoding === "u16" ? view.getUint16(i * 2, true) : view.getUint32(i * 4, true);
  }
  return out;
}
async function decompress(bytes2) {
  for (const format of ["deflate", "deflate-raw", "gzip"]) {
    try {
      const stream = new Blob([bytes2.slice()]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
    }
  }
  return bytes2;
}
var RadFile = class {
  // { splats, shPalette? }: the bundle of the asked layout (default
  // extSplats), plus lodTree, and the palette of clustered SH
  static read = readRad;
  // One RAD0 file of the splat bundle of `data` (any layout) and its
  // lodTree when it has one, in chunks of `chunkSize` splats
  static write = writeRad;
};
var bytesOf = (values) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
async function writeRad(data, { chunkSize = RAD_CHUNK_SIZE, sh = true, radSh = "s8", shPalette, progress } = {}) {
  const decode = Splats.decoder(Splats.get(data).bundle);
  const tree = Splats.findLodTree(data);
  const labels = sh && shPalette ? data.bundles.shLabel?.channels.label?.data : void 0;
  const found = sh && !labels ? Sh.find(data.bundles) : void 0;
  const decodeSh = found && Sh.decoder(data, found);
  const maxSh = Math.min(labels ? shPalette.degree : found?.degree ?? 0, 3);
  const bandMax = [0, 0, 0];
  const encoder = new TextEncoder();
  const s = Splats.makeExtSplat();
  const shColumns = (n, suffix, get) => {
    const coeffs = new Float32Array(Sh.VALUES);
    const bands = SH_BANDS.slice(0, maxSh).map(([, values]) => new Float32Array(values * n));
    for (let i = 0; i < n; i += 1) {
      get(i, coeffs);
      let at3 = 0;
      for (let b = 0; b < bands.length; b += 1) {
        const band = bands[b];
        const values = SH_BANDS[b][1];
        for (let v = 0; v < values; v += 1) {
          band[v * n + i] = coeffs[at3 + v];
        }
        at3 += values;
      }
    }
    return bands.map((band, b) => {
      const name = SH_BANDS[b][0] + suffix;
      if (radSh === "f32") {
        return [name, "f32", bytesOf(band)];
      }
      if (radSh === "f16") {
        const halves = new Uint16Array(band.length);
        for (let k = 0; k < band.length; k += 1) {
          halves[k] = Encoding.encodeHalf(band[k]);
        }
        return [name, "f16", bytesOf(halves)];
      }
      let max11 = 0;
      for (let k = 0; k < band.length; k += 1) {
        max11 = Math.max(max11, Math.abs(band[k]));
      }
      max11 ||= 1;
      bandMax[b] = Math.max(bandMax[b], max11);
      const codes = new Uint8Array(band.length);
      for (let k = 0; k < band.length; k += 1) {
        codes[k] = Math.max(-127, Math.min(127, Math.round(band[k] / max11 * 127))) & 255;
      }
      return [name, "s8", codes, { min: -max11, max: max11 }];
    });
  };
  const chunks = [];
  const ranges = [];
  let offset = 0;
  const tick = counter(progress, data.count, "encoding");
  for (let base = 0; base < data.count; base += chunkSize) {
    const n = Math.min(chunkSize, data.count - base);
    const center = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const rgb2 = new Float32Array(n * 3);
    const scales = new Float32Array(n * 3);
    const orientation = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      tick(base + i);
      decode(base + i, s);
      const q = s.quaternion;
      const sign2 = q.w < 0 ? -1 : 1;
      center[i] = s.center.x;
      center[n + i] = s.center.y;
      center[2 * n + i] = s.center.z;
      rgb2[i] = s.rgb.r;
      rgb2[n + i] = s.rgb.g;
      rgb2[2 * n + i] = s.rgb.b;
      scales[i] = s.scales.x;
      scales[n + i] = s.scales.y;
      scales[2 * n + i] = s.scales.z;
      orientation[i] = q.x * sign2;
      orientation[n + i] = q.y * sign2;
      orientation[2 * n + i] = q.z * sign2;
      alpha[i] = s.opacity;
    }
    const columns = [
      ["center", "f32", bytesOf(center)],
      ["alpha", "f32", bytesOf(alpha)],
      ["rgb", "f32", bytesOf(rgb2)],
      ["scales", "f32", bytesOf(scales)],
      ["orientation", "f32", bytesOf(orientation)]
    ];
    if (decodeSh) {
      columns.push(...shColumns(n, "", (i, coeffs) => decodeSh(base + i, coeffs)));
    }
    if (labels) {
      if (base === 0) {
        columns.push(...shColumns(shPalette.size, "_code", (e, coeffs) => shPalette.get(e, coeffs)));
      }
      columns.push(["sh_label", "u16", bytesOf(Uint16Array.from(labels.subarray(base, base + n)))]);
    }
    if (tree) {
      const nodes3 = tree.channels.node.data;
      const counts = new Uint32Array(n);
      const starts = new Uint32Array(n);
      for (let i = 0; i < n; i += 1) {
        counts[i] = nodes3[(base + i) * 2];
        starts[i] = nodes3[(base + i) * 2 + 1];
      }
      columns.push(["child_count", "u32", bytesOf(counts)], ["child_start", "u32", bytesOf(starts)]);
    }
    const payloads = await Promise.all(columns.map(([, , bytes2]) => Compression.gzip(bytes2)));
    const properties = [];
    let payloadBytes = 0;
    columns.forEach(([property, encoding, , range2], c) => {
      properties.push({ offset: payloadBytes, bytes: payloads[c].byteLength, property, encoding, compression: "gz", ...range2 });
      payloadBytes += pad8(payloads[c].byteLength);
    });
    const meta = encoder.encode(JSON.stringify({ version: 1, base, count: n, payloadBytes, maxSh, lodTree: tree !== void 0, properties }));
    const chunk = new Uint8Array(8 + pad8(meta.byteLength) + 8 + payloadBytes);
    const view2 = new DataView(chunk.buffer);
    view2.setUint32(0, RAD_CHUNK_MAGIC, true);
    view2.setUint32(4, meta.byteLength, true);
    chunk.set(meta, 8);
    const payloadAt = 8 + pad8(meta.byteLength);
    view2.setUint32(payloadAt, payloadBytes, true);
    properties.forEach((property, c) => chunk.set(payloads[c], payloadAt + 8 + property.offset));
    chunks.push(chunk);
    ranges.push({ offset, bytes: chunk.byteLength });
    offset += chunk.byteLength;
  }
  const splatEncoding = maxSh > 0 && radSh === "s8" ? { sh1Max: bandMax[0] || 1, sh2Max: bandMax[1] || 1, sh3Max: bandMax[2] || 1 } : void 0;
  const header = encoder.encode(JSON.stringify({
    version: 1,
    type: "gsplat",
    count: data.count,
    maxSh,
    lodTree: tree !== void 0,
    chunkSize,
    chunks: ranges,
    splatEncoding,
    shCodeCount: labels ? shPalette.size : void 0
  }));
  const file = new Uint8Array(8 + pad8(header.byteLength) + offset);
  const view = new DataView(file.buffer);
  view.setUint32(0, RAD_MAGIC, true);
  view.setUint32(4, header.byteLength, true);
  file.set(header, 8);
  let at2 = 8 + pad8(header.byteLength);
  for (const chunk of chunks) {
    file.set(chunk, at2);
    at2 += chunk.byteLength;
  }
  progress?.(1, "encoding");
  return file;
}

// src/core/rdx.ts
var RDX_VERSION = 1;
var RDX_CHUNK_SIZE = 65536;
var RDX_MAGIC = 1213744210;
var CHUNK_MAGIC = 1129858130;
var HEAD_READ_BYTES = 64 * 1024;
var align16 = (n) => Math.ceil(n / 16) * 16;
function encodeContainer(magic, meta, payloads) {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const sizesAt = 16 + align16(metaBytes.byteLength);
  const payloadsAt = sizesAt + align16(payloads.length * 4);
  const total = payloadsAt + payloads.reduce((sum, payload) => sum + align16(payload.byteLength), 0);
  const bytes2 = new Uint8Array(total);
  const view = new DataView(bytes2.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, metaBytes.byteLength, true);
  view.setUint32(8, payloads.length, true);
  bytes2.set(metaBytes, 16);
  let offset = payloadsAt;
  payloads.forEach((payload, i) => {
    view.setUint32(sizesAt + i * 4, payload.byteLength, true);
    bytes2.set(payload, offset);
    offset += align16(payload.byteLength);
  });
  return bytes2;
}
function decodeContainer(bytes2, magic) {
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  if (bytes2.byteLength < 16 || view.getUint32(0, true) !== magic) {
    throw new Error("Not an RDX piece of the expected type");
  }
  const metaLength = view.getUint32(4, true);
  const payloadCount = view.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes2.subarray(16, 16 + metaLength)));
  const sizesAt = 16 + align16(metaLength);
  let offset = sizesAt + align16(payloadCount * 4);
  const payloads = Array.from({ length: payloadCount }, (_, i) => {
    const size = view.getUint32(sizesAt + i * 4, true);
    const payload = bytes2.subarray(offset, offset + size);
    offset += align16(size);
    return payload;
  });
  return { meta, payloads, byteLength: offset };
}
async function encodeRdxChunks(data, { chunkSize = RDX_CHUNK_SIZE, progress } = {}) {
  if (chunkSize <= 0 || chunkSize % TextureLayout.ROW_ELEMENTS !== 0) {
    throw new Error(`Chunk size ${chunkSize} is not a positive multiple of ${TextureLayout.ROW_ELEMENTS}`);
  }
  const bundles = Object.entries(data.bundles).filter(([, bundle]) => bundle.def.serialize);
  const chunkCount = Math.ceil(data.count / chunkSize);
  const chunks = [];
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    progress?.(chunk / chunkCount, "encoding");
    const start = chunk * chunkSize;
    const count = Math.min(chunkSize, data.count - start);
    const payloads = [];
    for (const [, bundle] of bundles) {
      for (const channel of Object.values(bundle.channels)) {
        const info = ArrayFormats.info(channel.format);
        payloads.push(await Compression.compressTransposed(channel.data.subarray(start * info.components, (start + count) * info.components), info.bytes));
      }
    }
    chunks.push(encodeContainer(CHUNK_MAGIC, { start, count }, payloads));
  }
  progress?.(1, "encoding");
  const header = {
    version: RDX_VERSION,
    count: data.count,
    chunkSize,
    meta: data.meta,
    bundles: Object.fromEntries(bundles.map(([name, bundle]) => [name, { def: bundle.def, meta: bundle.meta }])),
    chunks: chunks.map((chunk) => chunk.byteLength)
  };
  return { header: encodeContainer(RDX_MAGIC, header, []), chunks };
}
function rdxChunkName(headerName, chunk) {
  const at2 = headerName.search(/\.rdx($|[?#])/);
  if (at2 < 0) {
    throw new Error(`${headerName} does not end in .rdx`);
  }
  return `${headerName.slice(0, at2)}-${chunk}${headerName.slice(at2)}`;
}
async function encodeRdxFiles(data, headerName, options = {}) {
  const { header, chunks } = await encodeRdxChunks(data, options);
  const files = { [headerName]: header };
  chunks.forEach((chunk, i) => files[rdxChunkName(headerName, i)] = chunk);
  return files;
}
async function encodeRdx(data, options = {}) {
  const { header, chunks } = await encodeRdxChunks(data, options);
  const file = new Uint8Array(header.byteLength + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  file.set(header);
  let offset = header.byteLength;
  for (const chunk of chunks) {
    file.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return file;
}
function decodeRdxHeader(bytes2) {
  const { meta, byteLength } = decodeContainer(bytes2, RDX_MAGIC);
  const header = meta;
  if (header.version !== RDX_VERSION) {
    throw new Error(`RDX version ${header.version} is not ${RDX_VERSION}`);
  }
  return { header, byteLength };
}
function rdxData(header) {
  const data = new ArrayData({ count: header.count, meta: header.meta });
  for (const [name, { def, meta }] of Object.entries(header.bundles)) {
    data.addBundle(name, defineBundle(def.channels, { packing: def.packing, serialize: def.serialize }), { meta });
  }
  return data;
}
async function decodeRdxChunk(header, bytes2, into) {
  const { meta, payloads } = decodeContainer(bytes2, CHUNK_MAGIC);
  const { start, count } = meta;
  into.ensureCapacity(start + count);
  let index = 0;
  for (const [name, { def }] of Object.entries(header.bundles)) {
    for (const [label, format] of Object.entries(def.channels)) {
      const info = ArrayFormats.info(format);
      const decoded = await Compression.decompressTransposed(payloads[index++], info.bytes);
      if (decoded.byteLength !== count * info.bytes) {
        throw new Error(`Chunk at ${start}: ${name}.${label} holds ${decoded.byteLength} bytes, expected ${count * info.bytes}`);
      }
      const channel = into.bundles[name]?.channels[label];
      if (channel?.format !== format) {
        throw new Error(`Channel ${name}.${label} missing from the target or of another format`);
      }
      channel.data.set(new info.array(decoded.buffer, decoded.byteOffset, count * info.components), start * info.components);
    }
  }
  into.count = Math.max(into.count, start + count);
}
async function decodeRdx(bytes2, { progress } = {}) {
  const { header, byteLength } = decodeRdxHeader(bytes2);
  const data = rdxData(header);
  let offset = byteLength;
  for (const [chunk, size] of header.chunks.entries()) {
    progress?.(chunk / header.chunks.length, "decoding");
    await decodeRdxChunk(header, bytes2.subarray(offset, offset + size), data);
    offset += size;
  }
  progress?.(1, "decoding");
  return data;
}
async function openRdx(readRange) {
  let head = await readRange(0, HEAD_READ_BYTES);
  if (head.byteLength < 16) {
    throw new Error("Not an RDX file");
  }
  const metaLength = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true);
  const headerLength = 16 + align16(metaLength);
  if (head.byteLength < headerLength) {
    head = await readRange(0, headerLength);
  }
  const { header, byteLength } = decodeRdxHeader(head.subarray(0, headerLength));
  const offsets = [];
  let offset = byteLength;
  for (const size of header.chunks) {
    offsets.push(offset);
    offset += size;
  }
  return {
    header,
    async readChunk(chunk, into) {
      if (!(chunk >= 0 && chunk < offsets.length)) {
        throw new Error(`No chunk ${chunk} (the file has ${offsets.length})`);
      }
      await decodeRdxChunk(header, await readRange(offsets[chunk], offsets[chunk] + header.chunks[chunk]), into);
    }
  };
}
async function fetchBytes(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}
async function loadRdx(url, { chunked = false, init = {} } = {}) {
  if (chunked) {
    const { header } = decodeRdxHeader((await fetchBytes(url, init)).bytes);
    return {
      header,
      async readChunk(chunk, into) {
        await decodeRdxChunk(header, (await fetchBytes(rdxChunkName(url, chunk), init)).bytes, into);
      }
    };
  }
  let whole;
  return openRdx(async (start, end) => {
    if (!whole) {
      const headers = new Headers(init.headers);
      headers.set("Range", `bytes=${start}-${end - 1}`);
      const { status, bytes: bytes2 } = await fetchBytes(url, { ...init, headers });
      if (status === 206) {
        return bytes2;
      }
      whole = bytes2;
    }
    return whole.subarray(start, end);
  });
}
var RdxFile = class {
  // Elements per chunk by default (a multiple of 4096)
  static CHUNK_SIZE = RDX_CHUNK_SIZE;
  // Whole file: the header, then every chunk
  static encode = encodeRdx;
  static decode = decodeRdx;
  // The header and the chunks as separate pieces
  static encodeChunks = encodeRdxChunks;
  // Chunked files by name: { "scene.rdx": header, "scene-0.rdx": chunk 0, ... }
  static encodeFiles = encodeRdxFiles;
  // scene.rdx -> scene-0.rdx (a query or hash after .rdx is kept)
  static chunkName = rdxChunkName;
  // The header at the start of `bytes`; byteLength is where chunk 0 starts
  // in a whole file
  static decodeHeader = decodeRdxHeader;
  // An empty ArrayData of a header's bundles, count and meta, for chunks
  static makeData = rdxData;
  // Writes a chunk's elements into `into`
  static decodeChunk = decodeRdxChunk;
  // A whole file through a range reader: one read for the header, one per chunk
  static open = openRdx;
  // A whole file over HTTP Range requests, or a chunked set with `chunked`
  static load = loadRdx;
};

// node_modules/fzstd/esm/index.mjs
var ab = ArrayBuffer;
var u8 = Uint8Array;
var u162 = Uint16Array;
var i16 = Int16Array;
var i32 = Int32Array;
var slc = function(v, s, e) {
  if (u8.prototype.slice)
    return u8.prototype.slice.call(v, s, e);
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  var n = new u8(e - s);
  n.set(v.subarray(s, e));
  return n;
};
var fill = function(v, n, s, e) {
  if (u8.prototype.fill)
    return u8.prototype.fill.call(v, n, s, e);
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  for (; s < e; ++s)
    v[s] = n;
  return v;
};
var cpw = function(v, t, s, e) {
  if (u8.prototype.copyWithin)
    return u8.prototype.copyWithin.call(v, t, s, e);
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  while (s < e) {
    v[t++] = v[s++];
  }
};
var ec = [
  "invalid zstd data",
  "window size too large (>2046MB)",
  "invalid block type",
  "FSE accuracy too high",
  "match distance too far back",
  "unexpected EOF"
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var rb = function(d, b, n) {
  var i = 0, o = 0;
  for (; i < n; ++i)
    o |= d[b++] << (i << 3);
  return o;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var rzfh = function(dat, w) {
  var n3 = dat[0] | dat[1] << 8 | dat[2] << 16;
  if (n3 == 3126568 && dat[3] == 253) {
    var flg = dat[4];
    var ss = flg >> 5 & 1, cc = flg >> 2 & 1, df = flg & 3, fcf = flg >> 6;
    if (flg & 8)
      err(0);
    var bt = 6 - ss;
    var db = df == 3 ? 4 : df;
    var di = rb(dat, bt, db);
    bt += db;
    var fsb = fcf ? 1 << fcf : ss;
    var fss = rb(dat, bt, fsb) + (fcf == 1 && 256);
    var ws = fss;
    if (!ss) {
      var wb = 1 << 10 + (dat[5] >> 3);
      ws = wb + (wb >> 3) * (dat[5] & 7);
    }
    if (ws > 2145386496)
      err(1);
    var buf = new u8((w == 1 ? fss || ws : w ? 0 : ws) + 12);
    buf[0] = 1, buf[4] = 4, buf[8] = 8;
    return {
      b: bt + fsb,
      y: 0,
      l: 0,
      d: di,
      w: w && w != 1 ? w : buf.subarray(12),
      e: ws,
      o: new i32(buf.buffer, 0, 3),
      u: fss,
      c: cc,
      m: Math.min(131072, ws)
    };
  } else if ((n3 >> 4 | dat[3] << 20) == 25481893) {
    return b4(dat, 4) + 8;
  }
  err(0);
};
var msb = function(val) {
  var bits = 0;
  for (; 1 << bits <= val; ++bits)
    ;
  return bits - 1;
};
var rfse = function(dat, bt, mal) {
  var tpos = (bt << 3) + 4;
  var al = (dat[bt] & 15) + 5;
  if (al > mal)
    err(3);
  var sz = 1 << al;
  var probs = sz, sym = -1, re = -1, i = -1, ht = sz;
  var buf = new ab(512 + (sz << 2));
  var freq = new i16(buf, 0, 256);
  var dstate = new u162(buf, 0, 256);
  var nstate = new u162(buf, 512, sz);
  var bb1 = 512 + (sz << 1);
  var syms = new u8(buf, bb1, sz);
  var nbits = new u8(buf, bb1 + sz);
  while (sym < 255 && probs > 0) {
    var bits = msb(probs + 1);
    var cbt = tpos >> 3;
    var msk = (1 << bits + 1) - 1;
    var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (tpos & 7) & msk;
    var msk1fb = (1 << bits) - 1;
    var msv = msk - probs - 1;
    var sval = val & msk1fb;
    if (sval < msv)
      tpos += bits, val = sval;
    else {
      tpos += bits + 1;
      if (val > msk1fb)
        val -= msv;
    }
    freq[++sym] = --val;
    if (val == -1) {
      probs += val;
      syms[--ht] = sym;
    } else
      probs -= val;
    if (!val) {
      do {
        var rbt = tpos >> 3;
        re = (dat[rbt] | dat[rbt + 1] << 8) >> (tpos & 7) & 3;
        tpos += 2;
        sym += re;
      } while (re == 3);
    }
  }
  if (sym > 255 || probs)
    err(0);
  var sympos = 0;
  var sstep = (sz >> 1) + (sz >> 3) + 3;
  var smask = sz - 1;
  for (var s = 0; s <= sym; ++s) {
    var sf = freq[s];
    if (sf < 1) {
      dstate[s] = -sf;
      continue;
    }
    for (i = 0; i < sf; ++i) {
      syms[sympos] = s;
      do {
        sympos = sympos + sstep & smask;
      } while (sympos >= ht);
    }
  }
  if (sympos)
    err(0);
  for (i = 0; i < sz; ++i) {
    var ns = dstate[syms[i]]++;
    var nb = nbits[i] = al - msb(ns);
    nstate[i] = (ns << nb) - sz;
  }
  return [tpos + 7 >> 3, {
    b: al,
    s: syms,
    n: nbits,
    t: nstate
  }];
};
var rhu = function(dat, bt) {
  var i = 0, wc = -1;
  var buf = new u8(292), hb = dat[bt];
  var hw = buf.subarray(0, 256);
  var rc = buf.subarray(256, 268);
  var ri = new u162(buf.buffer, 268);
  if (hb < 128) {
    var _a = rfse(dat, bt + 1, 6), ebt = _a[0], fdt = _a[1];
    bt += hb;
    var epos = ebt << 3;
    var lb = dat[bt];
    if (!lb)
      err(0);
    var st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1;
    var fpos = (++bt << 3) - 8 + msb(lb);
    for (; ; ) {
      fpos -= btr1;
      if (fpos < epos)
        break;
      var cbt = fpos >> 3;
      st1 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr1) - 1;
      hw[++wc] = fdt.s[st1];
      fpos -= btr2;
      if (fpos < epos)
        break;
      cbt = fpos >> 3;
      st2 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr2) - 1;
      hw[++wc] = fdt.s[st2];
      btr1 = fdt.n[st1];
      st1 = fdt.t[st1];
      btr2 = fdt.n[st2];
      st2 = fdt.t[st2];
    }
    if (++wc > 255)
      err(0);
  } else {
    wc = hb - 127;
    for (; i < wc; i += 2) {
      var byte = dat[++bt];
      hw[i] = byte >> 4;
      hw[i + 1] = byte & 15;
    }
    ++bt;
  }
  var wes = 0;
  for (i = 0; i < wc; ++i) {
    var wt = hw[i];
    if (wt > 11)
      err(0);
    wes += wt && 1 << wt - 1;
  }
  var mb = msb(wes) + 1;
  var ts = 1 << mb;
  var rem = ts - wes;
  if (rem & rem - 1)
    err(0);
  hw[wc++] = msb(rem) + 1;
  for (i = 0; i < wc; ++i) {
    var wt = hw[i];
    ++rc[hw[i] = wt && mb + 1 - wt];
  }
  var hbuf = new u8(ts << 1);
  var syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
  ri[mb] = 0;
  for (i = mb; i > 0; --i) {
    var pv = ri[i];
    fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << mb - i));
  }
  if (ri[0] != ts)
    err(0);
  for (i = 0; i < wc; ++i) {
    var bits = hw[i];
    if (bits) {
      var code = ri[bits];
      fill(syms, i, code, ri[bits] = code + (1 << mb - bits));
    }
  }
  return [bt, {
    n: nb,
    b: mb,
    s: syms
  }];
};
var dllt = rfse(/* @__PURE__ */ new u8([
  81,
  16,
  99,
  140,
  49,
  198,
  24,
  99,
  12,
  33,
  196,
  24,
  99,
  102,
  102,
  134,
  70,
  146,
  4
]), 0, 6)[1];
var dmlt = rfse(/* @__PURE__ */ new u8([
  33,
  20,
  196,
  24,
  99,
  140,
  33,
  132,
  16,
  66,
  8,
  33,
  132,
  16,
  66,
  8,
  33,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  36,
  9
]), 0, 6)[1];
var doct = rfse(/* @__PURE__ */ new u8([
  32,
  132,
  16,
  66,
  102,
  70,
  68,
  68,
  68,
  68,
  36,
  73,
  2
]), 0, 5)[1];
var b2bl = function(b, s) {
  var len = b.length, bl = new i32(len);
  for (var i = 0; i < len; ++i) {
    bl[i] = s;
    s += 1 << b[i];
  }
  return bl;
};
var llb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  134678020,
  202050057,
  269422093
])).buffer, 0, 36);
var llbl = /* @__PURE__ */ b2bl(llb, 0);
var mlb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  117769220,
  185207048,
  252579084,
  16
])).buffer, 0, 53);
var mlbl = /* @__PURE__ */ b2bl(mlb, 3);
var dhu = function(dat, out, hu) {
  var len = dat.length, ss = out.length, lb = dat[len - 1], msk = (1 << hu.b) - 1, eb = -hu.b;
  if (!lb)
    err(0);
  var st = 0, btr = hu.b, pos = (len << 3) - 8 + msb(lb) - btr, i = -1;
  for (; pos > eb && i < ss; ) {
    var cbt = pos >> 3;
    var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (pos & 7);
    st = (st << btr | val) & msk;
    out[++i] = hu.s[st];
    pos -= btr = hu.n[st];
  }
  if (pos != eb || i + 1 != ss)
    err(0);
};
var dhu4 = function(dat, out, hu) {
  var bt = 6;
  var ss = out.length, sz1 = ss + 3 >> 2, sz2 = sz1 << 1, sz3 = sz1 + sz2;
  dhu(dat.subarray(bt, bt += dat[0] | dat[1] << 8), out.subarray(0, sz1), hu);
  dhu(dat.subarray(bt, bt += dat[2] | dat[3] << 8), out.subarray(sz1, sz2), hu);
  dhu(dat.subarray(bt, bt += dat[4] | dat[5] << 8), out.subarray(sz2, sz3), hu);
  dhu(dat.subarray(bt), out.subarray(sz3), hu);
};
var rzb = function(dat, st, out) {
  var _a;
  var bt = st.b;
  var b0 = dat[bt], btype = b0 >> 1 & 3;
  st.l = b0 & 1;
  var sz = b0 >> 3 | dat[bt + 1] << 5 | dat[bt + 2] << 13;
  var ebt = (bt += 3) + sz;
  if (btype == 1) {
    if (bt >= dat.length)
      return;
    st.b = bt + 1;
    if (out) {
      fill(out, dat[bt], st.y, st.y += sz);
      return out;
    }
    return fill(new u8(sz), dat[bt]);
  }
  if (ebt > dat.length)
    return;
  if (btype == 0) {
    st.b = ebt;
    if (out) {
      out.set(dat.subarray(bt, ebt), st.y);
      st.y += sz;
      return out;
    }
    return slc(dat, bt, ebt);
  }
  if (btype == 2) {
    var b3 = dat[bt], lbt = b3 & 3, sf = b3 >> 2 & 3;
    var lss = b3 >> 4, lcs = 0, s4 = 0;
    if (lbt < 2) {
      if (sf & 1)
        lss |= dat[++bt] << 4 | (sf & 2 && dat[++bt] << 12);
      else
        lss = b3 >> 3;
    } else {
      s4 = sf;
      if (sf < 2)
        lss |= (dat[++bt] & 63) << 4, lcs = dat[bt] >> 6 | dat[++bt] << 2;
      else if (sf == 2)
        lss |= dat[++bt] << 4 | (dat[++bt] & 3) << 12, lcs = dat[bt] >> 2 | dat[++bt] << 6;
      else
        lss |= dat[++bt] << 4 | (dat[++bt] & 63) << 12, lcs = dat[bt] >> 6 | dat[++bt] << 2 | dat[++bt] << 10;
    }
    ++bt;
    var buf = out ? out.subarray(st.y, st.y + st.m) : new u8(st.m);
    var spl = buf.length - lss;
    if (lbt == 0)
      buf.set(dat.subarray(bt, bt += lss), spl);
    else if (lbt == 1)
      fill(buf, dat[bt++], spl);
    else {
      var hu = st.h;
      if (lbt == 2) {
        var hud = rhu(dat, bt);
        lcs += bt - (bt = hud[0]);
        st.h = hu = hud[1];
      } else if (!hu)
        err(0);
      (s4 ? dhu4 : dhu)(dat.subarray(bt, bt += lcs), buf.subarray(spl), hu);
    }
    var ns = dat[bt++];
    if (ns) {
      if (ns == 255)
        ns = (dat[bt++] | dat[bt++] << 8) + 32512;
      else if (ns > 127)
        ns = ns - 128 << 8 | dat[bt++];
      var scm = dat[bt++];
      if (scm & 3)
        err(0);
      var dts = [dmlt, doct, dllt];
      for (var i = 2; i > -1; --i) {
        var md = scm >> (i << 1) + 2 & 3;
        if (md == 1) {
          var rbuf = new u8([0, 0, dat[bt++]]);
          dts[i] = {
            s: rbuf.subarray(2, 3),
            n: rbuf.subarray(0, 1),
            t: new u162(rbuf.buffer, 0, 1),
            b: 0
          };
        } else if (md == 2) {
          _a = rfse(dat, bt, 9 - (i & 1)), bt = _a[0], dts[i] = _a[1];
        } else if (md == 3) {
          if (!st.t)
            err(0);
          dts[i] = st.t[i];
        }
      }
      var _b = st.t = dts, mlt = _b[0], oct = _b[1], llt = _b[2];
      var lb = dat[ebt - 1];
      if (!lb)
        err(0);
      var spos = (ebt << 3) - 8 + msb(lb) - llt.b, cbt = spos >> 3, oubt = 0;
      var lst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << llt.b) - 1;
      cbt = (spos -= oct.b) >> 3;
      var ost = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << oct.b) - 1;
      cbt = (spos -= mlt.b) >> 3;
      var mst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mlt.b) - 1;
      for (++ns; --ns; ) {
        var llc = llt.s[lst];
        var lbtr = llt.n[lst];
        var mlc = mlt.s[mst];
        var mbtr = mlt.n[mst];
        var ofc = oct.s[ost];
        var obtr = oct.n[ost];
        cbt = (spos -= ofc) >> 3;
        var ofp = 1 << ofc;
        var off = ofp + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16 | dat[cbt + 3] << 24) >>> (spos & 7) & ofp - 1);
        cbt = (spos -= mlb[mlc]) >> 3;
        var ml = mlbl[mlc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << mlb[mlc]) - 1);
        cbt = (spos -= llb[llc]) >> 3;
        var ll = llbl[llc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << llb[llc]) - 1);
        cbt = (spos -= lbtr) >> 3;
        lst = llt.t[lst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << lbtr) - 1);
        cbt = (spos -= mbtr) >> 3;
        mst = mlt.t[mst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mbtr) - 1);
        cbt = (spos -= obtr) >> 3;
        ost = oct.t[ost] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << obtr) - 1);
        if (off > 3) {
          st.o[2] = st.o[1];
          st.o[1] = st.o[0];
          st.o[0] = off -= 3;
        } else {
          var idx = off - (ll != 0);
          if (idx) {
            off = idx == 3 ? st.o[0] - 1 : st.o[idx];
            if (idx > 1)
              st.o[2] = st.o[1];
            st.o[1] = st.o[0];
            st.o[0] = off;
          } else
            off = st.o[0];
        }
        for (var i = 0; i < ll; ++i) {
          buf[oubt + i] = buf[spl + i];
        }
        oubt += ll, spl += ll;
        var stin = oubt - off;
        if (stin < 0) {
          var len = -stin;
          var bs = st.e + stin;
          if (len > ml)
            len = ml;
          for (var i = 0; i < len; ++i) {
            buf[oubt + i] = st.w[bs + i];
          }
          oubt += len, ml -= len, stin = 0;
        }
        for (var i = 0; i < ml; ++i) {
          buf[oubt + i] = buf[stin + i];
        }
        oubt += ml;
      }
      if (oubt != spl) {
        while (spl < buf.length) {
          buf[oubt++] = buf[spl++];
        }
      } else
        oubt = buf.length;
      if (out)
        st.y += oubt;
      else
        buf = slc(buf, 0, oubt);
    } else if (out) {
      st.y += lss;
      if (spl) {
        for (var i = 0; i < lss; ++i) {
          buf[i] = buf[spl + i];
        }
      }
    } else if (spl)
      buf = slc(buf, spl);
    st.b = ebt;
    return buf;
  }
  err(2);
};
var cct = function(bufs, ol) {
  if (bufs.length == 1)
    return bufs[0];
  var buf = new u8(ol);
  for (var i = 0, b = 0; i < bufs.length; ++i) {
    var chk = bufs[i];
    buf.set(chk, b);
    b += chk.length;
  }
  return buf;
};
function decompress2(dat, buf) {
  var bufs = [], nb = +!buf;
  var bt = 0, ol = 0;
  for (; dat.length; ) {
    var st = rzfh(dat, nb || buf);
    if (typeof st == "object") {
      if (nb) {
        buf = null;
        if (st.w.length == st.u) {
          bufs.push(buf = st.w);
          ol += st.u;
        }
      } else {
        bufs.push(buf);
        st.e = 0;
      }
      for (; !st.l; ) {
        var blk = rzb(dat, st, buf);
        if (!blk)
          err(5);
        if (buf)
          st.e = st.y;
        else {
          bufs.push(blk);
          ol += blk.length;
          cpw(st.w, 0, blk.length);
          st.w.set(blk, st.w.length - blk.length);
        }
      }
      bt = st.b + st.c * 4;
    } else
      bt = st;
    dat = dat.subarray(bt);
  }
  return cct(bufs, ol);
}

// src/core/zstd.ts
var LEVEL = 12;
var zlib;
function nodeZstd() {
  if (zlib === void 0) {
    const process = globalThis.process;
    const found = process?.getBuiltinModule?.("node:zlib");
    zlib = found?.zstdCompressSync && found.zstdDecompressSync ? found : null;
  }
  return zlib;
}
var streamSupport = {};
function streams(kind) {
  if (streamSupport[kind] === void 0) {
    try {
      void (kind === "compress" ? new CompressionStream("zstd") : new DecompressionStream("zstd"));
      streamSupport[kind] = true;
    } catch {
      streamSupport[kind] = false;
    }
  }
  return streamSupport[kind];
}
function own(bytes2) {
  return bytes2.byteOffset === 0 && bytes2.byteLength === bytes2.buffer.byteLength && bytes2.buffer instanceof ArrayBuffer ? new Uint8Array(bytes2.buffer) : new Uint8Array(bytes2);
}
var Zstd = class {
  // One or more frames of exactly `size` bytes in all; `native: false`
  // decodes with fzstd
  static async decompress(bytes2, size, { native = true } = {}) {
    const zstd = native ? nodeZstd() : null;
    let out;
    try {
      out = zstd ? zstd.zstdDecompressSync(bytes2) : native && streams("decompress") ? await pipe(new Uint8Array(bytes2), new DecompressionStream("zstd")) : decompress2(bytes2);
    } catch (error) {
      throw new Error(`Invalid zstd stream: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (out.byteLength !== size) {
      throw new Error(`zstd stream decoded to ${out.byteLength} bytes, not ${size}`);
    }
    return own(out);
  }
  // One frame; `level` (1 to 22) is Node's zstd level; `native: false` uses
  // the encoder below
  static async compress(bytes2, { native = true, level = LEVEL } = {}) {
    const zstd = native ? nodeZstd() : null;
    if (zstd) {
      return own(zstd.zstdCompressSync(bytes2, { params: { [zstd.constants.ZSTD_c_compressionLevel]: level } }));
    }
    if (native && streams("compress")) {
      return pipe(new Uint8Array(bytes2), new CompressionStream("zstd"));
    }
    return encodeFrame(bytes2);
  }
};
var BLOCK = 1 << 17;
var MAX_BITS = 11;
var WEIGHT_LOG = 6;
var MIN_HUFFMAN = 64;
var BitWriter = class {
  bytes;
  pos;
  acc = 0;
  n = 0;
  constructor(bytes2, pos = 0) {
    this.bytes = bytes2;
    this.pos = pos;
  }
  // nbits <= 24
  add(value, nbits) {
    this.acc |= value << this.n;
    this.n += nbits;
    while (this.n >= 8) {
      this.bytes[this.pos++] = this.acc & 255;
      this.acc >>>= 8;
      this.n -= 8;
    }
  }
  // The last partial byte; returns the end
  flush() {
    if (this.n > 0) {
      this.bytes[this.pos++] = this.acc & 255;
    }
    this.acc = 0;
    this.n = 0;
    return this.pos;
  }
  close() {
    this.add(1, 1);
    return this.flush();
  }
};
function huffmanLengths(counts, lengths) {
  lengths.fill(0);
  const syms = [];
  for (let s = 0; s < 256; s += 1) {
    if (counts[s] > 0) {
      syms.push(s);
    }
  }
  syms.sort((a, b) => counts[a] - counts[b] || a - b);
  const n = syms.length;
  const weight = new Float64Array(2 * n - 1);
  const parent = new Int32Array(2 * n - 1);
  const depth = new Uint8Array(2 * n - 1);
  for (let i = 0; i < n; i += 1) {
    weight[i] = counts[syms[i]];
  }
  let leaf = 0;
  let inner = n;
  const pick = (next) => leaf < n && (inner >= next || weight[leaf] <= weight[inner]) ? leaf++ : inner++;
  for (let next = n; next < 2 * n - 1; next += 1) {
    const a = pick(next);
    const b = pick(next);
    weight[next] = weight[a] + weight[b];
    parent[a] = next;
    parent[b] = next;
  }
  const lengthCount = new Uint32Array(257);
  let longest = 0;
  for (let i = 2 * n - 3; i >= 0; i -= 1) {
    depth[i] = depth[parent[i]] + 1;
    if (i < n) {
      lengthCount[depth[i]] += 1;
      longest = Math.max(longest, depth[i]);
    }
  }
  for (let i = longest; i > MAX_BITS; i -= 1) {
    while (lengthCount[i] > 0) {
      let j = i - 2;
      while (lengthCount[j] === 0) {
        j -= 1;
      }
      lengthCount[i] -= 2;
      lengthCount[i - 1] += 1;
      lengthCount[j + 1] += 2;
      lengthCount[j] -= 1;
    }
  }
  let at2 = n - 1;
  let max11 = 0;
  for (let len = 1; len <= Math.min(longest, MAX_BITS); len += 1) {
    for (let k = 0; k < lengthCount[len]; k += 1) {
      lengths[syms[at2--]] = len;
      max11 = len;
    }
  }
  return max11;
}
function huffmanCodes(lengths, maxBits, codes) {
  let slot = 0;
  for (let len = maxBits; len >= 1; len -= 1) {
    const span2 = 1 << maxBits - len;
    for (let s = 0; s < 256; s += 1) {
      if (lengths[s] === len) {
        codes[s] = slot >> maxBits - len;
        slot += span2;
      }
    }
  }
}
var highBit = (v) => 31 - Math.clz32(v);
function fseWeights(weights, count, out, at2) {
  const size = 1 << WEIGHT_LOG;
  const freq = new Uint32Array(MAX_BITS + 1);
  for (let i = 0; i < count; i += 1) {
    freq[weights[i]] += 1;
  }
  let maxSym = 0;
  let distinct = 0;
  for (let s = 0; s <= MAX_BITS; s += 1) {
    if (freq[s] > 0) {
      maxSym = s;
      distinct += 1;
    }
  }
  if (distinct < 2 || count <= 2) {
    return void 0;
  }
  const norm = new Int32Array(maxSym + 1);
  let sum = 0;
  for (let s = 0; s <= maxSym; s += 1) {
    if (freq[s] > 0) {
      norm[s] = Math.max(1, Math.floor(freq[s] * size / count));
      sum += norm[s];
    }
  }
  while (sum !== size) {
    let pickS = -1;
    for (let s = 0; s <= maxSym; s += 1) {
      if (sum > size ? norm[s] > 1 && (pickS < 0 || norm[s] > norm[pickS]) : freq[s] > 0 && (pickS < 0 || freq[s] > freq[pickS])) {
        pickS = s;
      }
    }
    norm[pickS] += sum > size ? -1 : 1;
    sum += sum > size ? -1 : 1;
  }
  const scratch5 = new Uint8Array(256);
  const header = new BitWriter(scratch5);
  header.add(WEIGHT_LOG - 5, 4);
  let remaining = size + 1;
  let threshold = size;
  let nbBits = WEIGHT_LOG + 1;
  let previousIs0 = false;
  for (let s = 0; s <= maxSym && remaining > 1; ) {
    if (previousIs0) {
      let start = s;
      while (norm[s] === 0) {
        s += 1;
      }
      while (s >= start + 3) {
        start += 3;
        header.add(3, 2);
      }
      header.add(s - start, 2);
    }
    let value = norm[s++];
    const max11 = 2 * threshold - 1 - remaining;
    remaining -= value;
    value += 1;
    if (value >= threshold) {
      value += max11;
    }
    header.add(value, value < max11 ? nbBits - 1 : nbBits);
    previousIs0 = value === 1;
    while (remaining < threshold) {
      nbBits -= 1;
      threshold >>= 1;
    }
  }
  let end = header.flush();
  const spread = new Uint8Array(size);
  let pos = 0;
  for (let s = 0; s <= maxSym; s += 1) {
    for (let i = 0; i < norm[s]; i += 1) {
      spread[pos] = s;
      pos = pos + (size >> 1) + (size >> 3) + 3 & size - 1;
    }
  }
  const cumul = new Int32Array(maxSym + 2);
  for (let s = 0; s <= maxSym; s += 1) {
    cumul[s + 1] = cumul[s] + norm[s];
  }
  const stateTable = new Uint16Array(size);
  for (let u = 0; u < size; u += 1) {
    stateTable[cumul[spread[u]]++] = size + u;
  }
  const deltaNbBits = new Int32Array(maxSym + 1);
  const deltaFind = new Int32Array(maxSym + 1);
  let total = 0;
  for (let s = 0; s <= maxSym; s += 1) {
    if (norm[s] === 1) {
      deltaNbBits[s] = (WEIGHT_LOG << 16) - size;
      deltaFind[s] = total - 1;
      total += 1;
    } else if (norm[s] > 1) {
      const maxBitsOut = WEIGHT_LOG - highBit(norm[s] - 1);
      deltaNbBits[s] = (maxBitsOut << 16) - (norm[s] << maxBitsOut);
      deltaFind[s] = total - norm[s];
      total += norm[s];
    }
  }
  const stream = new BitWriter(scratch5, end);
  const states = [0, 0];
  const started = [false, false];
  for (let k = count - 1; k >= 0; k -= 1) {
    const s = weights[k];
    const which = k & 1;
    if (!started[which]) {
      const nbOut = deltaNbBits[s] + (1 << 15) >> 16;
      const value = (nbOut << 16) - deltaNbBits[s];
      states[which] = stateTable[(value >> nbOut) + deltaFind[s]];
      started[which] = true;
    } else {
      const value = states[which];
      const nbOut = value + deltaNbBits[s] >> 16;
      stream.add(value & (1 << nbOut) - 1, nbOut);
      states[which] = stateTable[(value >> nbOut) + deltaFind[s]];
    }
  }
  stream.add(states[1] & size - 1, WEIGHT_LOG);
  stream.add(states[0] & size - 1, WEIGHT_LOG);
  end = stream.close();
  if (end > 127) {
    return void 0;
  }
  out.set(scratch5.subarray(0, end), at2);
  return end;
}
function treeDescription(lengths, maxBits, out, at2) {
  let last = 255;
  while (lengths[last] === 0) {
    last -= 1;
  }
  const weights = new Uint8Array(256);
  for (let s = 0; s < last; s += 1) {
    weights[s] = lengths[s] ? maxBits + 1 - lengths[s] : 0;
  }
  const fse = new Uint8Array(128);
  const fseSize = fseWeights(weights, last, fse, 0);
  const directSize = last <= 128 ? 1 + (last + 1 >> 1) : Infinity;
  if (fseSize !== void 0 && fseSize + 1 < directSize) {
    out[at2] = fseSize;
    out.set(fse.subarray(0, fseSize), at2 + 1);
    return fseSize + 1;
  }
  if (directSize === Infinity) {
    return void 0;
  }
  out[at2] = 127 + last;
  for (let s = 0; s < last; s += 2) {
    out[at2 + 1 + (s >> 1)] = weights[s] << 4 | (s + 1 < last ? weights[s + 1] : 0);
  }
  return directSize;
}
function writeLE(out, at2, value, bytes2) {
  for (let i = 0; i < bytes2; i += 1) {
    out[at2 + i] = value % 256;
    value = Math.floor(value / 256);
  }
}
function encodeFrame(src) {
  const blocks = Math.max(1, Math.ceil(src.byteLength / BLOCK));
  const out = new Uint8Array(14 + src.byteLength + blocks * 3);
  writeLE(out, 0, 4247762216, 4);
  const wide = src.byteLength >= 2 ** 32;
  out[4] = (wide ? 3 : 2) << 6;
  out[5] = 17 - 10 << 3;
  writeLE(out, 6, src.byteLength, wide ? 8 : 4);
  let at2 = wide ? 14 : 10;
  const counts = new Uint32Array(256);
  const lengths = new Uint8Array(256);
  const codes = new Uint16Array(256);
  const prevLengths = new Uint8Array(256);
  const prevCodes = new Uint16Array(256);
  let hasPrev = false;
  const block = new Uint8Array(2 * BLOCK);
  for (let b = 0; b < blocks; b += 1) {
    const start = b * BLOCK;
    const n = Math.min(BLOCK, src.byteLength - start);
    const last = b === blocks - 1 ? 1 : 0;
    const lit = src.subarray(start, start + n);
    counts.fill(0);
    for (let i = 0; i < n; i += 1) {
      counts[lit[i]] += 1;
    }
    if (n > 0 && counts[lit[0]] === n) {
      writeLE(out, at2, last | 1 << 1 | n << 3, 3);
      out[at2 + 3] = lit[0];
      at2 += 4;
      continue;
    }
    const [size, fresh] = n >= MIN_HUFFMAN ? compressBlock(lit, counts, lengths, codes, prevLengths, prevCodes, hasPrev, block) : [0, false];
    if (size > 0 && size < n) {
      writeLE(out, at2, last | 2 << 1 | size << 3, 3);
      out.set(block.subarray(0, size), at2 + 3);
      at2 += 3 + size;
      if (fresh) {
        prevLengths.set(lengths);
        prevCodes.set(codes);
      }
      hasPrev = true;
    } else {
      writeLE(out, at2, last | n << 3, 3);
      out.set(lit, at2 + 3);
      at2 += 3 + n;
    }
  }
  return out.slice(0, at2);
}
function compressBlock(lit, counts, lengths, codes, prevLengths, prevCodes, hasPrev, block) {
  const n = lit.byteLength;
  const maxBits = huffmanLengths(counts, lengths);
  const tree = new Uint8Array(256);
  const treeSize = treeDescription(lengths, maxBits, tree, 0);
  let newBits = 0;
  let prevBits = hasPrev ? 0 : Infinity;
  for (let s = 0; s < 256; s += 1) {
    if (counts[s] > 0) {
      newBits += counts[s] * lengths[s];
      prevBits += prevLengths[s] > 0 ? counts[s] * prevLengths[s] : Infinity;
    }
  }
  const newCost = treeSize === void 0 ? Infinity : newBits + treeSize * 8;
  if (newCost === Infinity && prevBits === Infinity) {
    return [0, false];
  }
  const treeless = prevBits <= newCost;
  if (!treeless) {
    huffmanCodes(lengths, maxBits, codes);
  }
  const useLengths = treeless ? prevLengths : lengths;
  const useCodes = treeless ? prevCodes : codes;
  const headerMax = 5;
  let at2 = headerMax;
  if (!treeless) {
    block.set(tree.subarray(0, treeSize), at2);
    at2 += treeSize;
  }
  const jump = at2;
  at2 += 6;
  const segment = Math.ceil(n / 4);
  const sizes = [0, 0, 0];
  for (let k = 0; k < 4; k += 1) {
    const from = Math.min(n, k * segment);
    const to = Math.min(n, from + segment);
    const writer = new BitWriter(block, at2);
    for (let i = to - 1; i >= from; i -= 1) {
      const s = lit[i];
      writer.add(useCodes[s], useLengths[s]);
    }
    const end = writer.close();
    if (k < 3) {
      sizes[k] = end - at2;
    }
    at2 = end;
    if (at2 > BLOCK) {
      return [0, false];
    }
  }
  writeLE(block, jump, sizes[0], 2);
  writeLE(block, jump + 2, sizes[1], 2);
  writeLE(block, jump + 4, sizes[2], 2);
  const compressed = at2 - headerMax;
  const format = Math.max(n, compressed) <= 1023 ? 1 : Math.max(n, compressed) <= 16383 ? 2 : 3;
  const headerSize = format + 2;
  const type = treeless ? 3 : 2;
  const header = type + (format << 2) + n * 16 + compressed * 2 ** (format === 1 ? 14 : format === 2 ? 18 : 22);
  const begin = headerMax - headerSize;
  writeLE(block, begin, header, headerSize);
  block[at2] = 0;
  at2 += 1;
  block.copyWithin(0, begin, at2);
  return [at2 - begin, !treeless];
}

// src/core/spz.ts
var SPZ_MAGIC = 1347635022;
var GZIP_LATEST = 4;
var NGSP_VERSION = 4;
var FLAG_ANTIALIASED = 1;
var FLAG_EXTENSIONS = 2;
var FLAG_PBR = 64;
var FLAG_LOD = 128;
var RECORD_SAFE_ORBIT = 2914910210;
var RECORD_COORDINATE_SYSTEM = 2914910211;
var RECORD_LOD = 1381498881;
var RECORD_PBR = 1381498882;
var LOD_BYTES = 6;
var PBR_BYTES = 5;
var COLOR_SCALE = SH_C0 / 0.15;
var SH_VECTORS = { 0: 0, 1: 3, 2: 8, 3: 15, 4: 24 };
var le32 = (bytes2, at2) => (bytes2[at2] | bytes2[at2 + 1] << 8 | bytes2[at2 + 2] << 16 | bytes2[at2 + 3] << 24) >>> 0;
function parseRecords(bytes2) {
  const records = [];
  let at2 = 0;
  while (at2 + 8 <= bytes2.byteLength) {
    const type = le32(bytes2, at2);
    const length6 = le32(bytes2, at2 + 4);
    if (at2 + 8 + length6 > bytes2.byteLength) {
      throw new Error(`SPZ extension record 0x${type.toString(16)} runs past its end`);
    }
    records.push({ type, data: bytes2.subarray(at2 + 8, at2 + 8 + length6) });
    at2 += 8 + length6;
  }
  return records;
}
async function splitRecords(records, count, out) {
  for (const record2 of records) {
    if (record2.type === RECORD_LOD) {
      out.lodTree = await Zstd.decompress(record2.data, count * LOD_BYTES);
    } else if (record2.type === RECORD_PBR) {
      out.pbr = await Zstd.decompress(record2.data, count * PBR_BYTES);
    } else {
      out.extensions.push(record2);
    }
  }
}
function checkHeader(version, shDegree2, latest) {
  if (version < 1 || version > latest || !(shDegree2 in SH_VECTORS)) {
    throw new Error(`Unsupported SPZ version ${version} or SH degree ${shDegree2}`);
  }
}
async function unpackGzip(r, sh) {
  const head = await r.read(16);
  if (le32(head, 0) !== SPZ_MAGIC) {
    throw new Error("Invalid SPZ file");
  }
  const version = le32(head, 4);
  const count = le32(head, 8);
  const [shDegree2, fractionalBits, flags] = [head[12], head[13], head[14]];
  checkHeader(version, shDegree2, GZIP_LATEST);
  const shBytes = count * SH_VECTORS[shDegree2] * 3;
  const out = {
    container: "gzip",
    version,
    count,
    shDegree: shDegree2,
    fractionalBits,
    flags,
    centers: await r.read(count * (version === 1 ? 6 : 9)),
    alphas: await r.read(count),
    colors: await r.read(count * 3),
    scales: await r.read(count * 3),
    rotations: await r.read(count * (version >= 3 ? 4 : 3)),
    extensions: []
  };
  if (sh && shBytes > 0) {
    out.sh = await r.read(shBytes);
  } else {
    await r.skip(shBytes);
  }
  if (flags & FLAG_LOD) {
    out.lodTree = await r.read(count * LOD_BYTES);
  }
  if (flags & FLAG_PBR) {
    out.pbr = await r.read(count * PBR_BYTES);
  }
  if (flags & FLAG_EXTENSIONS) {
    await splitRecords(parseRecords(await r.rest()), count, out);
  } else {
    r.cancel();
  }
  return out;
}
async function unpackNgsp(r, sh) {
  const head = await r.read(32);
  const version = le32(head, 4);
  const count = le32(head, 8);
  const [shDegree2, fractionalBits, flags, numStreams] = [head[12], head[13], head[14], head[15]];
  const tocByteOffset = le32(head, 16);
  if (version !== NGSP_VERSION) {
    throw new Error(`Unsupported SPZ version ${version} in the NGSP container`);
  }
  checkHeader(version, shDegree2, NGSP_VERSION);
  if (count > 2147483647) {
    throw new Error(`Invalid SPZ point count ${count}`);
  }
  if (tocByteOffset < 32) {
    throw new Error("SPZ 4 table of contents inside the header");
  }
  const records = await r.read(tocByteOffset - 32);
  const sizes = [9, 1, 3, 3, 4, SH_VECTORS[shDegree2] * 3].map((bytes2) => count * bytes2);
  const present = sizes.flatMap((size, i) => size > 0 ? [i] : []);
  if (numStreams !== present.length) {
    throw new Error(`SPZ 4 file with ${numStreams} streams, ${present.length} expected`);
  }
  const toc = await r.read(numStreams * 16);
  const compressed = [];
  let total = tocByteOffset + toc.byteLength;
  for (let k = 0; k < numStreams; k += 1) {
    const [low, high, sizeLow, sizeHigh] = [0, 4, 8, 12].map((at2) => le32(toc, k * 16 + at2));
    if (high >= 1 << 21 || sizeHigh !== 0 || sizeLow !== sizes[present[k]]) {
      throw new Error(`SPZ 4 stream ${k} sizes don't match its header`);
    }
    compressed.push(high * 2 ** 32 + low);
    total += compressed[k];
  }
  if (count * 9 > total * 1024) {
    throw new Error(`Invalid SPZ point count ${count} for ${total} bytes`);
  }
  const columns = sizes.map(() => new Uint8Array(0));
  let complete = true;
  for (let k = 0; k < numStreams; k += 1) {
    if (present[k] === 5 && !sh) {
      r.cancel();
      complete = false;
      break;
    }
    columns[present[k]] = await Zstd.decompress(await r.read(compressed[k]), sizes[present[k]]);
  }
  if (complete && !await r.atEnd()) {
    throw new Error("SPZ 4 file has bytes after its last stream");
  }
  const out = {
    container: "ngsp",
    version,
    count,
    shDegree: shDegree2,
    fractionalBits,
    flags,
    centers: columns[0],
    alphas: columns[1],
    colors: columns[2],
    scales: columns[3],
    rotations: columns[4],
    sh: sh && columns[5].byteLength > 0 ? columns[5] : void 0,
    extensions: []
  };
  if (flags & FLAG_EXTENSIONS) {
    await splitRecords(parseRecords(records), count, out);
  }
  return out;
}
async function unpackSpz(input, { sh = true } = {}) {
  const raw = new ByteReader(input, "SPZ file");
  const head = await raw.peek(4);
  if (head.byteLength === 4 && le32(head, 0) === SPZ_MAGIC) {
    return unpackNgsp(raw, sh);
  }
  if (head[0] !== 31 || head[1] !== 139) {
    raw.cancel();
    throw new Error("Invalid SPZ file");
  }
  return unpackGzip(new ByteReader(raw.stream().pipeThrough(new DecompressionStream("gzip")), "SPZ file"), sh);
}
async function readSpz(input, {
  progress,
  sh: shTarget,
  coordinateSystem,
  ...target
} = {}) {
  const u = await unpackSpz(input, { sh: shTarget !== false });
  const { version, count, shDegree: shDegree2 } = u;
  const meta = { format: "spz", version, container: u.container, antialiased: (u.flags & FLAG_ANTIALIASED) !== 0 };
  let stored = "RUB";
  const skipped = [];
  for (const { type, data: bytes2 } of u.extensions) {
    const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
    if (type === RECORD_SAFE_ORBIT && bytes2.byteLength >= 12) {
      meta.safeOrbitCamera = { elevationMin: view.getFloat32(0, true), elevationMax: view.getFloat32(4, true), radiusMin: view.getFloat32(8, true) };
    } else if (type === RECORD_COORDINATE_SYSTEM && bytes2.byteLength >= 4) {
      const code = view.getUint32(0, true);
      if (code > Axes.SYSTEMS.length) {
        throw new Error(`Unknown SPZ coordinate system ${code}`);
      }
      stored = code === 0 ? "RUB" : Axes.SYSTEMS[code - 1];
    } else {
      skipped.push(type);
    }
  }
  if (skipped.length > 0) {
    meta.skippedExtensions = skipped;
  }
  meta.coordinateSystem = coordinateSystem ?? stored;
  const convert = coordinateSystem && coordinateSystem !== stored ? Axes.converter(stored, coordinateSystem) : void 0;
  const data = new ArrayData({ count, meta });
  const encode = Splats.encoder(Splats.add(data, target));
  const encodeSh = Sh.prepare(data, shDegree2, shTarget);
  const shValues = SH_VECTORS[shDegree2] * 3;
  const coeffs = new Float32Array(Sh.VALUES);
  const { centers, alphas, colors, scales, rotations, sh, pbr } = u;
  const centerView = new DataView(centers.buffer, centers.byteOffset, centers.byteLength);
  const rotationView = new DataView(rotations.buffer, rotations.byteOffset, rotations.byteLength);
  const fixed = 1 / (1 << u.fractionalBits);
  const int24 = (at2) => (centers[at2] | centers[at2 + 1] << 8 | centers[at2 + 2] << 16) << 8 >> 8;
  const s = Splats.makeExtSplat();
  const color = (byte) => (byte / 255 - 0.5) * COLOR_SCALE + 0.5;
  const scale = (byte) => Math.exp(byte / 16 - 10);
  const tick = counter(progress, count, "decoding");
  for (let i = 0; i < count; i += 1) {
    tick(i);
    if (version === 1) {
      s.center.x = Encoding.decodeHalf(centerView.getUint16(i * 6, true));
      s.center.y = Encoding.decodeHalf(centerView.getUint16(i * 6 + 2, true));
      s.center.z = Encoding.decodeHalf(centerView.getUint16(i * 6 + 4, true));
    } else {
      s.center.x = int24(i * 9) * fixed;
      s.center.y = int24(i * 9 + 3) * fixed;
      s.center.z = int24(i * 9 + 6) * fixed;
    }
    s.opacity = alphas[i] / 255;
    s.rgb.r = color(colors[i * 3]);
    s.rgb.g = color(colors[i * 3 + 1]);
    s.rgb.b = color(colors[i * 3 + 2]);
    s.scales.x = scale(scales[i * 3]);
    s.scales.y = scale(scales[i * 3 + 1]);
    s.scales.z = scale(scales[i * 3 + 2]);
    if (version >= 3) {
      decodeSmallestThree(rotationView.getUint32(i * 4, true), s.quaternion);
    } else {
      const x = rotations[i * 3] / 127.5 - 1;
      const y = rotations[i * 3 + 1] / 127.5 - 1;
      const z = rotations[i * 3 + 2] / 127.5 - 1;
      s.quaternion.x = x;
      s.quaternion.y = y;
      s.quaternion.z = z;
      s.quaternion.w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    }
    if (pbr) {
      Encoding.decodeOct24(pbr[i * 3] | pbr[i * 3 + 1] << 8 | pbr[i * 3 + 2] << 16, s.normal);
      s.roughness = pbr[count * 3 + i] / 255;
      s.metallic = pbr[count * 4 + i] / 255;
    }
    encode(i, convert ? convert.splat(s) : s);
    if (encodeSh && sh) {
      for (let v = 0; v < shValues; v += 1) {
        coeffs[v] = (sh[i * shValues + v] - 128) / 128;
      }
      encodeSh(i, convert ? convert.sh(coeffs, shDegree2) : coeffs);
    }
  }
  if (u.lodTree) {
    const tree = new DataView(u.lodTree.buffer, u.lodTree.byteOffset, u.lodTree.byteLength);
    const nodes3 = data.addBundle("lodTree", Splats.LOD_TREE).bundles.lodTree.channels.node.data;
    for (let i = 0; i < count; i += 1) {
      nodes3[i * 2] = tree.getUint16(i * 2, true);
      nodes3[i * 2 + 1] = tree.getUint32(count * 2 + i * 4, true);
    }
  }
  return { splats: data };
}
function record(type, payload) {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, type, true);
  view.setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}
var concat = (parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at2 = 0;
  for (const part of parts) {
    out.set(part, at2);
    at2 += part.byteLength;
  }
  return out;
};
async function writeSpz(data, {
  version = 3,
  fractionalBits = 12,
  antialiased = true,
  pbr = false,
  lod,
  sh = true,
  coordinateSystem,
  zstdLevel,
  progress
} = {}) {
  if (version !== 2 && version !== 3 && version !== 4) {
    throw new Error(`SPZ version ${String(version)} cannot be written (2, 3 or 4)`);
  }
  const decode = Splats.decoder(Splats.get(data).bundle);
  const tree = Splats.findLodTree(data);
  const withLod = lod ?? tree !== void 0;
  if (withLod && !tree) {
    throw new Error("SpzFile.write with lod needs a lodTree bundle");
  }
  const found = sh ? Sh.find(data.bundles) : void 0;
  const decodeSh = found && Sh.decoder(data, found);
  const shValues = found ? SH_VECTORS[found.degree] * 3 : 0;
  const coeffs = new Float32Array(Sh.VALUES);
  const count = data.count;
  const rotationBytes = version === 2 ? 3 : 4;
  const alphas = 16 + count * 9;
  const colors = alphas + count;
  const scales = colors + count * 3;
  const rotations = scales + count * 3;
  const shStart = rotations + count * rotationBytes;
  const lodStart = shStart + count * shValues;
  const pbrStart = lodStart + (withLod ? count * LOD_BYTES : 0);
  const size = pbrStart + (pbr ? count * PBR_BYTES : 0);
  const bytes2 = new Uint8Array(size);
  const view = new DataView(bytes2.buffer);
  const flags = antialiased ? FLAG_ANTIALIASED : 0;
  view.setUint32(0, SPZ_MAGIC, true);
  view.setUint32(4, version, true);
  view.setUint32(8, count, true);
  view.setUint8(12, found?.degree ?? 0);
  view.setUint8(13, fractionalBits);
  view.setUint8(14, flags | (version < 4 ? (pbr ? FLAG_PBR : 0) | (withLod ? FLAG_LOD : 0) : 0));
  const fixed = 1 << fractionalBits;
  const byte = (value) => Math.round(Math.max(0, Math.min(255, value)));
  const colorByte = (value) => byte(((value - 0.5) / COLOR_SCALE + 0.5) * 255);
  const scaleByte = (value) => byte((Math.log(Math.max(value, Number.MIN_VALUE)) + 10) * 16);
  const putCenter = (at2, value) => {
    const code = Math.max(-8388607, Math.min(8388607, Math.round(value * fixed)));
    bytes2[at2] = code & 255;
    bytes2[at2 + 1] = code >> 8 & 255;
    bytes2[at2 + 2] = code >> 16 & 255;
  };
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const tick = counter(span(progress, 0, 0.8), count, "encoding");
  for (let i = 0; i < count; i += 1) {
    tick(i);
    decode(i, s);
    putCenter(16 + i * 9, s.center.x);
    putCenter(16 + i * 9 + 3, s.center.y);
    putCenter(16 + i * 9 + 6, s.center.z);
    bytes2[colors + i * 3] = colorByte(s.rgb.r);
    bytes2[colors + i * 3 + 1] = colorByte(s.rgb.g);
    bytes2[colors + i * 3 + 2] = colorByte(s.rgb.b);
    bytes2[scales + i * 3] = scaleByte(s.scales.x);
    bytes2[scales + i * 3 + 1] = scaleByte(s.scales.y);
    bytes2[scales + i * 3 + 2] = scaleByte(s.scales.z);
    bytes2[alphas + i] = byte(s.opacity * 255);
    if (version === 2) {
      SplatMath.normalizeQuat(s.quaternion, q);
      const sign2 = q.w < 0 ? -1 : 1;
      bytes2[rotations + i * 3] = byte((q.x * sign2 + 1) * 127.5);
      bytes2[rotations + i * 3 + 1] = byte((q.y * sign2 + 1) * 127.5);
      bytes2[rotations + i * 3 + 2] = byte((q.z * sign2 + 1) * 127.5);
    } else {
      view.setUint32(rotations + i * 4, encodeSmallestThree(s.quaternion), true);
    }
    if (decodeSh) {
      decodeSh(i, coeffs);
      for (let v = 0; v < shValues; v += 1) {
        bytes2[shStart + i * shValues + v] = byte(coeffs[v] * 128 + 128);
      }
    }
    if (withLod) {
      const nodes3 = tree.channels.node.data;
      view.setUint16(lodStart + i * 2, nodes3[i * 2] & 65535, true);
      view.setUint32(lodStart + count * 2 + i * 4, nodes3[i * 2 + 1], true);
    }
    if (pbr) {
      const normal = Encoding.encodeOct24(s.normal);
      bytes2[pbrStart + i * 3] = normal & 255;
      bytes2[pbrStart + i * 3 + 1] = normal >> 8 & 255;
      bytes2[pbrStart + i * 3 + 2] = normal >> 16 & 255;
      bytes2[pbrStart + count * 3 + i] = Encoding.encodeUnorm8(s.roughness);
      bytes2[pbrStart + count * 4 + i] = Encoding.encodeUnorm8(s.metallic);
    }
  }
  progress?.(0.8, "compressing");
  if (version < 4) {
    const compressed = await Compression.gzip(bytes2);
    progress?.(1, "compressing");
    return compressed;
  }
  const records = [];
  const orbit = data.meta.safeOrbitCamera;
  if (orbit) {
    records.push(record(RECORD_SAFE_ORBIT, new Uint8Array(Float32Array.of(orbit.elevationMin, orbit.elevationMax, orbit.radiusMin).buffer)));
  }
  const system = coordinateSystem ?? data.meta.coordinateSystem;
  if (system && system !== "RUB") {
    const code = Axes.SYSTEMS.indexOf(system) + 1;
    if (code === 0) {
      throw new Error(`Unknown coordinate system ${system}`);
    }
    records.push(record(RECORD_COORDINATE_SYSTEM, new Uint8Array(Uint32Array.of(code).buffer)));
  }
  if (withLod) {
    records.push(record(RECORD_LOD, await Zstd.compress(bytes2.subarray(lodStart, pbrStart), { level: zstdLevel })));
  }
  if (pbr) {
    records.push(record(RECORD_PBR, await Zstd.compress(bytes2.subarray(pbrStart, size), { level: zstdLevel })));
  }
  const streams2 = [];
  const sizes = [];
  const bounds = [16, alphas, colors, scales, rotations, shStart, lodStart];
  for (let k = 0; k < 6; k += 1) {
    if (bounds[k + 1] > bounds[k]) {
      streams2.push(await Zstd.compress(bytes2.subarray(bounds[k], bounds[k + 1]), { level: zstdLevel }));
      sizes.push(bounds[k + 1] - bounds[k]);
    }
  }
  const extensions = concat(records);
  const head = new Uint8Array(32 + extensions.byteLength + streams2.length * 16);
  const headView = new DataView(head.buffer);
  headView.setUint32(0, SPZ_MAGIC, true);
  headView.setUint32(4, NGSP_VERSION, true);
  headView.setUint32(8, count, true);
  head[12] = found?.degree ?? 0;
  head[13] = fractionalBits;
  head[14] = flags | (records.length > 0 ? FLAG_EXTENSIONS : 0);
  head[15] = streams2.length;
  headView.setUint32(16, 32 + extensions.byteLength, true);
  head.set(extensions, 32);
  for (let k = 0; k < streams2.length; k += 1) {
    const at2 = 32 + extensions.byteLength + k * 16;
    headView.setUint32(at2, streams2[k].byteLength % 2 ** 32, true);
    headView.setUint32(at2 + 4, Math.floor(streams2[k].byteLength / 2 ** 32), true);
    headView.setUint32(at2 + 8, sizes[k], true);
  }
  progress?.(1, "compressing");
  return concat([head, ...streams2]);
}
var SpzFile = class {
  // Versions 1 to 4 in gzip and SPZ 4 (NGSP), from bytes or a stream, as
  // { splats }: the bundle of the asked layout (default extSplats), plus
  // lodTree, its SH included
  static read = readSpz;
  // The splat bundle of `data` (any layout): version 2, 3 or 4
  static write = writeSpz;
  // A file's header and byte columns (sh: false leaves the SH out)
  static unpack = unpackSpz;
};
function encodeSmallestThree(quaternion) {
  const n = SplatMath.normalizeQuat(quaternion, { x: 0, y: 0, z: 0, w: 1 });
  const q = [n.x, n.y, n.z, n.w];
  let largest = 0;
  for (let i = 1; i < 4; i += 1) {
    if (Math.abs(q[i]) > Math.abs(q[largest])) {
      largest = i;
    }
  }
  const negate = q[largest] < 0 ? 1 : 0;
  let packed3 = largest;
  for (let i = 0; i < 4; i += 1) {
    if (i !== largest) {
      const sign2 = (q[i] < 0 ? 1 : 0) ^ negate;
      const magnitude = Math.max(0, Math.min(511, Math.round(511 * Math.abs(q[i]) / Math.SQRT1_2)));
      packed3 = packed3 << 10 | sign2 << 9 | magnitude;
    }
  }
  return packed3 >>> 0;
}
function decodeSmallestThree(packed3, out) {
  const largest = packed3 >>> 30;
  const q = [0, 0, 0, 0];
  let rest = packed3;
  let sum = 0;
  for (let i = 3; i >= 0; i -= 1) {
    if (i !== largest) {
      const value = Math.SQRT1_2 * ((rest & 511) / 511) * (rest >>> 9 & 1 ? -1 : 1);
      rest >>>= 10;
      q[i] = value;
      sum += value * value;
    }
  }
  q[largest] = Math.sqrt(Math.max(1 - sum, 0));
  [out.x, out.y, out.z, out.w] = q;
}

// src/core/files.ts
var SplatFiles = class _SplatFiles {
  // The format of a file from its first bytes, else its name's extension;
  // compressed PLY files are "ply" (PlyFile.read reads both)
  static detectFormat(bytes2, name = "") {
    const magic = bytes2.byteLength >= 4 ? new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength).getUint32(0, true) : 0;
    if (magic === RDX_MAGIC) {
      return "rdx";
    }
    if (magic === RAD_MAGIC || magic === RAD_CHUNK_MAGIC) {
      return "rad";
    }
    if (bytes2[0] === 112 && bytes2[1] === 108 && bytes2[2] === 121) {
      return "ply";
    }
    const extension = name.toLowerCase().replace(/[?#].*$/, "").split(".").pop();
    if (bytes2[0] === 31 && bytes2[1] === 139 || magic === SPZ_MAGIC || extension === "spz") {
      return "spz";
    }
    throw new Error(`Unknown splat file format${name ? `: ${name}` : ""}`);
  }
  static async decode(bytes2, {
    name = "",
    progress,
    layout = "extSplats",
    encoding,
    sh,
    coordinateSystem
  } = {}) {
    const options = { progress, layout, encoding, sh, coordinateSystem };
    switch (_SplatFiles.detectFormat(bytes2, name)) {
      case "rdx":
        return { splats: _SplatFiles.withSh(Splats.convert(await RdxFile.decode(bytes2, { progress }), { layout, encoding }), sh) };
      case "rad":
        return RadFile.read(bytes2, options);
      case "ply":
      case "compressed-ply":
        return PlyFile.read(bytes2, options);
      case "spz":
        return SpzFile.read(bytes2, options);
    }
  }
  // A table's SH as asked: kept when `sh` is undefined, dropped with false
  // (meta.ignoredShDegree records the degree), else converted to the codec
  static withSh(data, sh) {
    const table = data;
    const found = Sh.find(table.bundles);
    if (sh === void 0 || !found) {
      return data;
    }
    if (sh === false) {
      table.removeBundle(found.name);
      table.meta.ignoredShDegree = found.degree;
      return data;
    }
    return Sh.convert(table, sh);
  }
  // A file of `data` in `format`: PLY, SPZ and RAD take its splat bundle
  // (and lodTree, and SH), RDX every serialized bundle
  static async encode(data, format, options = {}) {
    if (options.shPalette && format !== "rad" && options.sh !== false) {
      data = options.shPalette.expanded(data);
    }
    switch (format) {
      case "ply":
        return PlyFile.write(data, options);
      case "compressed-ply":
        return CompressedPlyFile.write(data, options);
      case "spz":
        return SpzFile.write(data, options);
      case "rad":
        return RadFile.write(data, options);
      case "rdx":
        return RdxFile.encode(data, options);
    }
  }
  // Download (0-40% of the progress) and decode
  static async fetch(url, { init, progress, ...target } = {}) {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.status}`);
    }
    const bytes2 = await readResponse(response, span(progress, 0, 0.4));
    return _SplatFiles.decode(bytes2, { ...target, name: url, progress: span(progress, 0.4, 1) });
  }
};

// src/gpu/createRenderer.ts
import * as THREE3 from "three";
import { WebGPURenderer } from "three/webgpu";

// src/gpu/backend.ts
function backendOf(renderer) {
  return renderer.backend;
}
function isWebGPUBackend(renderer) {
  return backendOf(renderer).isWebGPUBackend === true;
}
function gpuTextureOf(renderer, texture) {
  return backendOf(renderer).get(texture).texture;
}
function glTextureOf(renderer, texture) {
  return backendOf(renderer).get(texture).textureGPU;
}

// src/gpu/baseline.ts
var WEBGPU_BASELINE_LIMITS = {
  maxTextureDimension1D: 16384,
  // 99%
  maxTextureDimension2D: 16384,
  // 100%
  maxTextureArrayLayers: 2048,
  // 99%
  maxBufferSize: 1 << 30,
  // 97%
  maxStorageBufferBindingSize: 256 << 20,
  // 98% (1 GiB: 92%)
  maxComputeWorkgroupStorageSize: 32768,
  // 98%; 99% report at least 32767
  maxColorAttachmentBytesPerSample: 64,
  // 98% (128: 83%, not Apple GPUs)
  maxStorageBuffersPerShaderStage: 10,
  // 99%
  maxStorageBuffersInVertexStage: 10,
  // 99%
  maxStorageBuffersInFragmentStage: 10
  // 99%
};
var WEBGPU_DEFAULT_LIMITS = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureArrayLayers: 256,
  maxBufferSize: 256 << 20,
  maxStorageBufferBindingSize: 128 << 20,
  maxComputeWorkgroupStorageSize: 16384,
  maxColorAttachmentBytesPerSample: 32,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageBuffersInVertexStage: 8,
  maxStorageBuffersInFragmentStage: 8
};
var WEBGL2_BASELINE = {
  MAX_TEXTURE_SIZE: 8192,
  // 98%
  MAX_ARRAY_TEXTURE_LAYERS: 512,
  MAX_DRAW_BUFFERS: 4,
  // 6 and up: 98%
  MAX_COLOR_ATTACHMENTS: 4,
  MAX_TEXTURE_IMAGE_UNITS: 16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
  MAX_UNIFORM_BLOCK_SIZE: 16384,
  // 32 KiB: 73%
  MAX_VARYING_VECTORS: 15,
  // 16: 99%
  MAX_VERTEX_ATTRIBS: 16,
  MAX_SAMPLES: 4
};
var WEBGL2_REQUIRED_EXTENSIONS = ["EXT_color_buffer_float"];
var WEBGL2_OPTIONAL_EXTENSIONS = ["EXT_float_blend"];

// src/gpu/GpuProfiler.ts
import { InspectorBase, TimestampQuery } from "three/webgpu";
var GpuProfiler = class extends InspectorBase {
  // Phase of the passes recorded from now on
  label = "other";
  frame = 0;
  passes = /* @__PURE__ */ new Map();
  cpu = {};
  cpuFrames = /* @__PURE__ */ new Set();
  beginFrame() {
    this.frame += 1;
  }
  // Run fn with its passes labeled `name`; its CPU time is recorded too
  phase(name, fn) {
    const previous = this.label;
    this.label = name;
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.mark(name, performance.now() - start);
      this.label = previous;
    }
  }
  // Record CPU milliseconds for a phase (e.g. an async worker round trip)
  mark(name, ms) {
    this.cpu[name] = (this.cpu[name] ?? 0) + ms;
    this.cpuFrames.add(this.frame);
  }
  beginCompute(uid, computeNode) {
    if (!this.active) {
      return;
    }
    const nodes3 = Array.isArray(computeNode) ? computeNode : [computeNode];
    const name = nodes3.map((node) => node.name).filter(Boolean).join(",");
    this.passes.set(uid, { phase: this.label !== "other" ? this.label : name || "compute", frame: this.frame });
  }
  beginRender(uid) {
    if (this.active) {
      this.passes.set(uid, { phase: this.label, frame: this.frame });
    }
  }
  // Whether the renderer tracks timestamps. Settable between frames (not
  // inside a render: WebGL2 timer queries must end as they began); stays
  // off without the feature. CPU phases are timed either way.
  get active() {
    return this.backend()?.trackTimestamp === true;
  }
  set active(on) {
    const backend = this.backend();
    if (backend) {
      backend.trackTimestamp = on && this.supported;
    }
  }
  // WebGPU `timestamp-query` (three requests every adapter feature) or
  // EXT_disjoint_timer_query_webgl2
  get supported() {
    const renderer = this.getRenderer();
    const gl = this.backend()?.gl;
    return renderer !== null && (gl ? gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null : renderer.hasFeature("timestamp-query"));
  }
  backend() {
    return this.getRenderer()?.backend;
  }
  // Resolve pending queries; undefined when nothing new resolved
  async collect() {
    const gpu = {};
    const frames = /* @__PURE__ */ new Set();
    const renderer = this.getRenderer();
    if (renderer && this.active) {
      await renderer.resolveTimestampsAsync(TimestampQuery.RENDER);
      await renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE);
      const pools = renderer.backend.timestampQueryPool;
      for (const type of [TimestampQuery.RENDER, TimestampQuery.COMPUTE]) {
        for (const [uid, ms] of pools[type]?.timestamps ?? []) {
          const pass = this.passes.get(uid);
          if (pass) {
            this.passes.delete(uid);
            gpu[pass.phase] = (gpu[pass.phase] ?? 0) + ms;
            frames.add(pass.frame);
          }
        }
      }
      for (const [uid, pass] of this.passes) {
        if (pass.frame < this.frame - 8) {
          this.passes.delete(uid);
        }
      }
    }
    const cpuFrames = Math.max(1, this.cpuFrames.size);
    const cpu = Object.fromEntries(Object.entries(this.cpu).map(([name, ms]) => [name, ms / cpuFrames]));
    const resolved = Math.max(1, frames.size);
    this.cpu = {};
    this.cpuFrames.clear();
    if (frames.size === 0 && Object.keys(cpu).length === 0) {
      return void 0;
    }
    return { gpu: Object.fromEntries(Object.entries(gpu).map(([name, ms]) => [name, ms / resolved])), cpu, frames: frames.size };
  }
  static format(profile) {
    const list = (times) => Object.entries(times).sort((a, b) => b[1] - a[1]).map(([name, ms]) => `${name} ${ms.toFixed(2)}`).join(", ");
    return `GPU ${list(profile.gpu) || "-"} | CPU ${list(profile.cpu) || "-"} ms`;
  }
};

// src/gpu/hdr.ts
import * as THREE2 from "three";

// src/gpu/tsl.ts
import * as TSLStrict from "three/tsl";
var TEXTURE_WIDTH = TextureLayout.WIDTH;
var TSL = TSLStrict;
function texelCoord(texel, yBits, yMask) {
  const row = texel.shiftRight(TSL.uint(Math.log2(TEXTURE_WIDTH))).toVar();
  return { x: texel.bitAnd(TSL.uint(TEXTURE_WIDTH - 1)), y: row.bitAnd(yMask), layer: row.shiftRight(yBits) };
}

// src/gpu/hdr.ts
var { Fn, clamp, exp, float, max, mix, select, sRGBTransferEOTF, uniform, vec3 } = TSL;
function displaySupportsHdr() {
  return typeof window !== "undefined" && window.matchMedia?.("(dynamic-range: high)").matches === true;
}
function canvasSupportsHdr(renderer) {
  const backend = backendOf(renderer);
  if (!backend.isWebGPUBackend || backend.parameters.outputType !== THREE2.HalfFloatType) {
    return false;
  }
  const configuration = backend.context?.getConfiguration?.();
  return !configuration || configuration.toneMapping !== void 0;
}
function setHdrOutput(renderer, extended) {
  if (!canvasSupportsHdr(renderer)) {
    return false;
  }
  const backend = backendOf(renderer);
  backend.context.configure({
    device: backend.device,
    format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    alphaMode: backend.parameters.alpha ? "premultiplied" : "opaque",
    toneMapping: { mode: extended ? "extended" : "standard" }
  });
  return true;
}
var toneMappings = /* @__PURE__ */ new WeakMap();
function useHdrToneMapping(renderer, {
  headroom,
  knee,
  whiten,
  enabled = true
} = {}) {
  let toneMapping = toneMappings.get(renderer);
  if (!toneMapping) {
    const u = { headroom: uniform(1), knee: uniform(0.75), whiten: uniform(0.5) };
    renderer.library.addToneMapping(Fn(([color, exposure]) => {
      const c = sRGBTransferEOTF(max(color, vec3(0))).mul(exposure).toVar();
      const peak = max(c.r, max(c.g, c.b)).toVar();
      const limit = max(u.headroom, 1e-3).toVar();
      const start = limit.mul(clamp(u.knee, 0, 0.99)).toVar();
      const range2 = limit.sub(start).toVar();
      const mapped = select(peak.lessThanEqual(start), peak, start.add(range2.mul(float(1).sub(exp(peak.sub(start).div(range2).negate()))))).toVar();
      const scaled = c.mul(mapped.div(max(peak, 1e-6)));
      const past = max(peak.sub(limit), 0).div(limit);
      return mix(scaled, vec3(mapped), float(1).sub(exp(past.mul(u.whiten).negate())));
    }), THREE2.CustomToneMapping);
    const saved = { toneMapping: renderer.toneMapping, outputColorSpace: renderer.outputColorSpace };
    let on = false;
    toneMapping = {
      ...u,
      get exposure() {
        return renderer.toneMappingExposure;
      },
      set exposure(value) {
        renderer.toneMappingExposure = value;
      },
      get enabled() {
        return on;
      },
      set enabled(value) {
        if (value === on) {
          return;
        }
        on = value;
        if (on) {
          saved.toneMapping = renderer.toneMapping;
          saved.outputColorSpace = renderer.outputColorSpace;
          renderer.toneMapping = THREE2.CustomToneMapping;
          renderer.outputColorSpace = THREE2.SRGBColorSpace;
        } else {
          renderer.toneMapping = saved.toneMapping;
          renderer.outputColorSpace = saved.outputColorSpace;
        }
      }
    };
    toneMapping.headroom.value = canvasSupportsHdr(renderer) ? 4 : 1;
    toneMappings.set(renderer, toneMapping);
  }
  if (headroom !== void 0) {
    toneMapping.headroom.value = headroom;
  }
  if (knee !== void 0) {
    toneMapping.knee.value = knee;
  }
  if (whiten !== void 0) {
    toneMapping.whiten.value = whiten;
  }
  toneMapping.enabled = enabled;
  return toneMapping;
}
function hdrToneMappingActive(renderer) {
  return toneMappings.get(renderer)?.enabled === true && renderer.toneMapping === THREE2.CustomToneMapping;
}
var Hdr = class {
  // Whether the display reports high dynamic range (the browser also needs to)
  static displaySupports = displaySupportsHdr;
  // The canvas can show the extended range: WebGPU with an rgba16float
  // canvas (createRenderer({ hdr })) and a browser that kept the extended mode
  static canvasSupports = canvasSupportsHdr;
  // Extended (true) or standard (false) range on an HDR-capable canvas;
  // false if the canvas cannot
  static setOutput = setHdrOutput;
  // Headroom tone mapping for a renderer (one per renderer; later calls
  // return it with the options applied)
  static useToneMapping = useHdrToneMapping;
};

// src/gpu/createRenderer.ts
async function createRenderer(options = {}) {
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const gpuParam = params.get("gpu");
  const hdrParam = params.get("hdr");
  const requested = options.backend ?? (gpuParam === "webgpu" || gpuParam === "webgpu-gl" ? gpuParam : "auto");
  const profile = options.profile ?? params.get("profile") === "1";
  const timing = profile || (options.timing ?? params.get("timing") === "1");
  const multiview = options.multiview ?? params.get("multiview") === "1";
  const directCanvas = options.directCanvas ?? params.get("direct") !== "0";
  const hdrOption = options.hdr ?? (hdrParam === "1" ? true : hdrParam === "auto" ? "auto" : false);
  const xr = options.xr ?? false;
  const forceWebGL = requested === "webgpu-gl" || !navigator.gpu;
  const hdr = !forceWebGL && (hdrOption === true || hdrOption === "auto" && Hdr.displaySupports());
  const requiredLimits = forceWebGL ? void 0 : await adapterLimits(xr, options.limits);
  const renderer = new WebGPURenderer({
    canvas: options.canvas,
    antialias: options.antialias,
    forceWebGL,
    trackTimestamp: timing,
    multiview,
    logarithmicDepthBuffer: options.logarithmicDepthBuffer ?? false,
    // three configures an rgba16float canvas with extended tone mapping for this
    ...hdr ? { outputType: THREE3.HalfFloatType } : {},
    ...requiredLimits ? { requiredLimits } : {}
  });
  renderer.xr.enabled = xr;
  await renderer.init();
  const internals = backendOf(renderer);
  if (internals.gl) {
    if (requested === "webgpu") {
      console.warn("WebGPU unavailable, using the WebGL2 backend");
    }
    internals.trackTimestamp = profile && internals.gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null;
    checkWebGL2(internals.gl);
  }
  if (hdrOption === true && !Hdr.canvasSupports(renderer)) {
    console.info("HDR canvas unavailable (needs the WebGPU backend and canvas tone mapping)");
  }
  if (directCanvas) {
    renderer.outputColorSpace = THREE3.LinearSRGBColorSpace;
    renderer.toneMapping = THREE3.NoToneMapping;
  }
  if (profile) {
    renderer.inspector = new GpuProfiler();
  }
  return renderer;
}
async function adapterLimits(xrCompatible, overrides = {}) {
  const adapter = await navigator.gpu.requestAdapter({ featureLevel: "compatibility", xrCompatible });
  if (!adapter) {
    return void 0;
  }
  const supported = adapter.limits;
  const limits = {};
  const short = [];
  for (const [name, request] of Object.entries({ ...WEBGPU_BASELINE_LIMITS, ...overrides })) {
    if (!(name in adapter.limits)) {
      continue;
    }
    const lowerIsBetter = name.startsWith("min");
    const available = supported[name];
    let value = available;
    if (request !== "adapter") {
      value = lowerIsBetter ? Math.max(request, available) : Math.min(request, available);
      if (value !== request) {
        short.push(`${name} ${available} (baseline ${request})`);
      }
    }
    const fallback = WEBGPU_DEFAULT_LIMITS[name];
    if (fallback === void 0 || (lowerIsBetter ? value < fallback : value > fallback)) {
      limits[name] = value;
    }
  }
  if (short.length > 0) {
    console.info(`WebGPU adapter below the limit baseline: ${short.join(", ")}`);
  }
  return Object.keys(limits).length > 0 ? limits : void 0;
}
function checkWebGL2(gl) {
  for (const name of WEBGL2_REQUIRED_EXTENSIONS) {
    if (!gl.getExtension(name)) {
      console.warn(`WebGL2 extension ${name} missing: float16 / float32 targets and readback will fail`);
    }
  }
  for (const name of WEBGL2_OPTIONAL_EXTENSIONS) {
    gl.getExtension(name);
  }
  const short = Object.entries(WEBGL2_BASELINE).map(([name, baseline]) => [name, baseline, gl.getParameter(gl[name])]).filter(([, baseline, value]) => value < baseline).map(([name, baseline, value]) => `${name} ${value} (baseline ${baseline})`);
  if (short.length > 0) {
    console.info(`WebGL2 device below the baseline: ${short.join(", ")}`);
  }
}
function getGpuCaps(renderer) {
  const backend = backendOf(renderer);
  if (backend.isWebGPUBackend) {
    const limits = backend.device.limits;
    return {
      backend: "webgpu",
      compute: true,
      maxTextureSize: limits.maxTextureDimension2D,
      maxTextureLayers: limits.maxTextureArrayLayers,
      maxColorAttachments: limits.maxColorAttachments,
      maxTexturesPerStage: limits.maxSampledTexturesPerShaderStage,
      maxStorageTexturesPerStage: limits.maxStorageTexturesPerShaderStage,
      maxStorageBuffersPerStage: limits.maxStorageBuffersPerShaderStage,
      maxWorkgroupStorage: limits.maxComputeWorkgroupStorageSize,
      float32Blendable: renderer.hasFeature("float32-blendable"),
      float32Filterable: renderer.hasFeature("float32-filterable"),
      subgroups: renderer.hasFeature("subgroups"),
      multiview: backend.device.features.has("multiview") ? "webgpu" : false,
      hdr: Hdr.canvasSupports(renderer)
    };
  }
  const gl = backend.gl;
  return {
    backend: "webgpu-gl",
    compute: false,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxColorAttachments: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    maxTexturesPerStage: Math.min(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS)),
    maxStorageTexturesPerStage: 0,
    maxStorageBuffersPerStage: 0,
    maxWorkgroupStorage: 0,
    float32Blendable: gl.getExtension("EXT_float_blend") !== null,
    float32Filterable: gl.getExtension("OES_texture_float_linear") !== null,
    subgroups: false,
    multiview: gl.getExtension("OVR_multiview2") !== null ? "ovr" : false,
    hdr: false
  };
}

// src/gpu/encoding.tsl.ts
var {
  Fn: Fn2,
  If,
  abs,
  acos,
  ceil,
  clamp: clamp2,
  cos,
  float: float2,
  floor,
  int,
  length,
  log2,
  max: max2,
  min,
  normalize,
  packHalf2x16,
  select: select2,
  sin,
  uint,
  uintBitsToFloat,
  unpackHalf2x16,
  vec2,
  vec3: vec32,
  vec4
} = TSL;
var PI = Math.PI;
var roundHalfUp = (x) => floor(x.add(0.5));
var encodeExtRgb = Fn2(([rgb2]) => {
  const absRgb = abs(rgb2).toVar();
  const maxAbs = max2(absRgb.x, max2(absRgb.y, absRgb.z)).toVar();
  const base = clamp2(int(select2(maxAbs.greaterThan(0), ceil(log2(maxAbs)), float2(0))).add(int(15)), int(0), int(31)).toVar();
  const scale = uintBitsToFloat(uint(int(142).sub(base)).shiftLeft(uint(23))).mul(255).toVar();
  const magnitude = (v) => uint(min(roundHalfUp(v.mul(scale)), 255));
  const signs = select2(rgb2.x.lessThan(0), uint(1), uint(0)).bitOr(select2(rgb2.y.lessThan(0), uint(2), uint(0))).bitOr(select2(rgb2.z.lessThan(0), uint(4), uint(0)));
  return magnitude(absRgb.x).bitOr(magnitude(absRgb.y).shiftLeft(uint(8))).bitOr(magnitude(absRgb.z).shiftLeft(uint(16))).bitOr(uint(base).shiftLeft(uint(3)).bitOr(signs).shiftLeft(uint(24)));
});
var decodeExtRgb = Fn2(([encoded]) => {
  const unit = uintBitsToFloat(encoded.shiftRight(uint(27)).add(uint(112)).shiftLeft(uint(23))).div(255).toVar();
  const channel = (shift, signBit) => {
    const value = float2(encoded.shiftRight(uint(shift)).bitAnd(uint(255))).mul(unit);
    return select2(encoded.bitAnd(uint(signBit)).notEqual(uint(0)), value.negate(), value);
  };
  return vec32(channel(0, 16777216), channel(8, 33554432), channel(16, 67108864));
});
var octDecoders = /* @__PURE__ */ new Map();
var octEncoders = /* @__PURE__ */ new Map();
function octDecoder(bits) {
  let decode = octDecoders.get(bits);
  if (!decode) {
    const maxCode = 2 ** bits - 1;
    decode = Fn2(([c]) => {
      const x = float2(c.bitAnd(uint(maxCode))).div(maxCode).mul(2).sub(1).toVar();
      const y = float2(c.shiftRight(uint(bits)).bitAnd(uint(maxCode))).div(maxCode).mul(2).sub(1).toVar();
      const z = float2(1).sub(abs(x)).sub(abs(y)).toVar();
      const t = max2(z.negate(), 0).toVar();
      x.addAssign(select2(x.greaterThanEqual(0), t.negate(), t));
      y.addAssign(select2(y.greaterThanEqual(0), t.negate(), t));
      return select2(c.equal(uint(0)), vec32(0), normalize(vec32(x, y, z)));
    });
    octDecoders.set(bits, decode);
  }
  return decode;
}
function octEncoder(bits) {
  let encode = octEncoders.get(bits);
  if (!encode) {
    const maxCode = 2 ** bits - 1;
    const allOnes = (maxCode | maxCode << bits) >>> 0;
    encode = Fn2(([dir]) => {
      const result = uint(0).toVar();
      const l1 = abs(dir.x).add(abs(dir.y)).add(abs(dir.z)).toVar();
      If(l1.greaterThan(0), () => {
        const p = dir.xy.div(l1).toVar();
        If(dir.z.lessThan(0), () => {
          const px = p.x.toVar();
          p.x.assign(float2(1).sub(abs(p.y)).mul(select2(px.greaterThanEqual(0), float2(1), float2(-1))));
          p.y.assign(float2(1).sub(abs(px)).mul(select2(p.y.greaterThanEqual(0), float2(1), float2(-1))));
        });
        const uw = p.mul(0.5).add(0.5).mul(maxCode).toVar();
        const code = uint(roundHalfUp(uw.x)).bitOr(uint(roundHalfUp(uw.y)).shiftLeft(uint(bits))).toVar();
        result.assign(select2(code.equal(uint(0)), uint(allOnes), code));
      });
      return result;
    });
    octEncoders.set(bits, encode);
  }
  return encode;
}
function encodeQuatOct(q, axisBits, angleBits) {
  const angleMax = 2 ** angleBits - 1;
  const result = uint(0).toVar();
  const len = length(q).toVar();
  If(len.greaterThan(0), () => {
    const s = select2(q.w.lessThan(0), float2(-1), float2(1)).div(len).toVar();
    const angle = acos(min(q.w.mul(s), 1)).mul(2);
    const angleCode = uint(roundHalfUp(angle.div(PI).mul(angleMax)));
    result.assign(octEncoder(axisBits)(q.xyz.mul(s)).bitOr(angleCode.shiftLeft(uint(2 * axisBits))));
  });
  return result;
}
function decodeQuatOct(code, axisBits, angleBits) {
  const angleMax = 2 ** angleBits - 1;
  const axis = octDecoder(axisBits)(code.bitAnd(uint(2 ** (2 * axisBits) - 1)));
  const half = float2(code.shiftRight(uint(2 * axisBits)).bitAnd(uint(angleMax))).div(angleMax).mul(PI / 2).toVar();
  return vec4(axis.mul(sin(half)), cos(half));
}
var GpuEncoding = class {
  // Half-float bits of a float, in the low 16 bits of a uint
  static encodeHalf(f) {
    return packHalf2x16(vec2(f, 0)).bitAnd(uint(65535));
  }
  // Two half floats in one uint: x low, y high
  static encodeHalf2(v) {
    return packHalf2x16(v);
  }
  static decodeHalf2(word) {
    return unpackHalf2x16(word);
  }
  // Float of the half bits in the low 16 bits of h
  static decodeHalf(h) {
    return unpackHalf2x16(h.bitAnd(uint(65535))).x;
  }
  static encodeUnorm8(v) {
    return uint(roundHalfUp(clamp2(v, 0, 1).mul(255)));
  }
  // 128 = 1.0, up to 255 / 128
  static encodeLodOpacity(opacity) {
    return uint(clamp2(roundHalfUp(max2(opacity, 0).mul(128)), 0, 255));
  }
  static decodeLodOpacity(byte) {
    return float2(byte).div(128);
  }
  static encodeExtRgb = encodeExtRgb;
  static decodeExtRgb = decodeExtRgb;
  // Octahedral direction with `bits` per axis (a JavaScript number: the
  // shader is specialized to it)
  static encodeOct(v, bits) {
    return octEncoder(bits)(v);
  }
  static decodeOct(code, bits) {
    return octDecoder(bits)(code);
  }
  static encodeQuatOct = encodeQuatOct;
  static decodeQuatOct = decodeQuatOct;
  static encodeOct24(v) {
    return octEncoder(12)(v);
  }
  static decodeOct24(code) {
    return octDecoder(12)(code);
  }
  static encodeQuatOct32(q) {
    return encodeQuatOct(q, 10, 12);
  }
  static decodeQuatOct32(code) {
    return decodeQuatOct(code, 10, 12);
  }
  static encodeQuatOct24(q) {
    return encodeQuatOct(q, 8, 8);
  }
  static decodeQuatOct24(code) {
    return decodeQuatOct(code, 8, 8);
  }
};

// src/gpu/GpuArrayReader.ts
import { TextureNode } from "three/webgpu";

// src/gpu/GpuArrays.ts
import * as THREE5 from "three";

// src/gpu/gpuFormats.ts
import * as THREE4 from "three";
var SCALAR_GPU = {
  uint8: { kind: "uint", webgpu: "8uint", gl: "8UI", glType: "UNSIGNED_BYTE", threeType: THREE4.UnsignedIntType },
  sint8: { kind: "sint", webgpu: "8sint", gl: "8I", glType: "BYTE", threeType: THREE4.IntType },
  unorm8: { kind: "float", webgpu: "8unorm", gl: "8", glType: "UNSIGNED_BYTE", threeType: THREE4.UnsignedByteType },
  snorm8: { kind: "float", webgpu: "8snorm", gl: "8_SNORM", glType: "BYTE", threeType: THREE4.ByteType },
  uint16: { kind: "uint", webgpu: "16uint", gl: "16UI", glType: "UNSIGNED_SHORT", threeType: THREE4.UnsignedIntType },
  sint16: { kind: "sint", webgpu: "16sint", gl: "16I", glType: "SHORT", threeType: THREE4.IntType },
  float16: { kind: "float", webgpu: "16float", gl: "16F", glType: "HALF_FLOAT", threeType: THREE4.HalfFloatType },
  uint32: { kind: "uint", webgpu: "32uint", gl: "32UI", glType: "UNSIGNED_INT", threeType: THREE4.UnsignedIntType },
  sint32: { kind: "sint", webgpu: "32sint", gl: "32I", glType: "INT", threeType: THREE4.IntType },
  float32: { kind: "float", webgpu: "32float", gl: "32F", glType: "FLOAT", threeType: THREE4.FloatType }
};
var CHANNELS = {
  1: { webgpu: "r", gl: "R", glFormat: "RED", three: THREE4.RedFormat, threeInteger: THREE4.RedIntegerFormat },
  2: { webgpu: "rg", gl: "RG", glFormat: "RG", three: THREE4.RGFormat, threeInteger: THREE4.RGIntegerFormat },
  4: { webgpu: "rgba", gl: "RGBA", glFormat: "RGBA", three: THREE4.RGBAFormat, threeInteger: THREE4.RGBAIntegerFormat }
};
var cache2 = /* @__PURE__ */ new Map();
function gpuFormatInfo(format) {
  const cached = cache2.get(format);
  if (cached) {
    return cached;
  }
  const { scalar, components, gpu } = ArrayFormats.info(format);
  if (!gpu) {
    throw new Error(`Format ${format} is CPU-only (GPU formats have 1, 2 or 4 components)`);
  }
  const s = SCALAR_GPU[scalar];
  const channels = CHANNELS[components];
  const integer = s.kind !== "float";
  const vectorPrefix = { uint: "u", sint: "i", float: "" }[s.kind];
  const scalarNode = { uint: "uint", sint: "int", float: "float" }[s.kind];
  const info = {
    format,
    components,
    scalar,
    kind: s.kind,
    webgpu: `${channels.webgpu}${s.webgpu}`,
    gl: `${channels.gl}${s.gl}`,
    glFormat: `${channels.glFormat}${integer ? "_INTEGER" : ""}`,
    glType: s.glType,
    threeFormat: integer ? channels.threeInteger : channels.three,
    threeType: s.threeType,
    node: components === 1 ? scalarNode : `${vectorPrefix}vec${components}`,
    renderable: scalar !== "snorm8",
    storable: ArrayFormats.info(format).scalarBytes === 4 || components === 4 && (scalar === "unorm8" || scalar === "snorm8" || scalar === "float16")
  };
  cache2.set(format, info);
  return info;
}

// src/gpu/textureIo.ts
function uploadTexels(renderer, texture, format, spans, values) {
  const { bytes: bytes2, components } = ArrayFormats.info(format);
  const backend = backendOf(renderer);
  if (backend.isWebGPUBackend) {
    const gpuTexture = gpuTextureOf(renderer, texture);
    for (const { x, y, layer, width, rows, offset } of spans) {
      backend.device.queue.writeTexture(
        { texture: gpuTexture, origin: { x, y, z: layer } },
        values,
        { offset: offset * bytes2, bytesPerRow: width * bytes2, rowsPerImage: rows },
        { width, height: rows, depthOrArrayLayers: 1 }
      );
    }
    return;
  }
  const gl = backend.gl;
  const info = gpuFormatInfo(format);
  withGlState(gl, () => {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, glTextureOf(renderer, texture));
    for (const { x, y, layer, width, rows, offset } of spans) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, layer, width, rows, 1, glEnum(gl, info.glFormat), glEnum(gl, info.glType), values, offset * components);
    }
  });
}
async function readTexels(renderer, texture, format, spans, dest) {
  const backend = backendOf(renderer);
  if (backend.isWebGPUBackend) {
    await readWebGPU(backend.device, gpuTextureOf(renderer, texture), format, spans, dest);
  } else {
    await readWebGL(backend.gl, glTextureOf(renderer, texture), format, spans, dest);
  }
}
function copyTexels(renderer, src, dst, spans) {
  const backend = backendOf(renderer);
  if (backend.isWebGPUBackend) {
    const device = backend.device;
    const encoder = device.createCommandEncoder({ label: "radix_copyTexels" });
    for (const span2 of spans) {
      encoder.copyTextureToTexture(
        { texture: gpuTextureOf(renderer, src), origin: { x: span2.src.x, y: span2.src.y, z: span2.src.layer } },
        { texture: gpuTextureOf(renderer, dst), origin: { x: span2.dst.x, y: span2.dst.y, z: span2.dst.layer } },
        { width: span2.width, height: span2.rows, depthOrArrayLayers: 1 }
      );
    }
    device.queue.submit([encoder.finish()]);
    return;
  }
  const gl = backend.gl;
  withGlState(gl, () => {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, glTextureOf(renderer, dst));
    for (const span2 of spans) {
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, glTextureOf(renderer, src), 0, span2.src.layer);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, span2.dst.x, span2.dst.y, span2.dst.layer, span2.src.x, span2.src.y, span2.width, span2.rows);
    }
    gl.deleteFramebuffer(framebuffer);
  });
}
async function readWebGPU(device, texture, format, spans, dest) {
  const { bytes: bytes2 } = ArrayFormats.info(format);
  const align = (n) => Math.ceil(n / 256) * 256;
  const offsets = [];
  let size = 0;
  for (const span2 of spans) {
    offsets.push(size);
    size += align(span2.width * bytes2) * span2.rows;
  }
  const buffer = device.createBuffer({ label: "radix_readTexels", size: Math.max(size, 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: "radix_readTexels" });
  spans.forEach((span2, i) => {
    encoder.copyTextureToBuffer(
      { texture, origin: { x: span2.x, y: span2.y, z: span2.layer } },
      { buffer, offset: offsets[i], bytesPerRow: align(span2.width * bytes2), rowsPerImage: span2.rows },
      { width: span2.width, height: span2.rows, depthOrArrayLayers: 1 }
    );
  });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(dest.buffer, dest.byteOffset, dest.byteLength);
  spans.forEach((span2, i) => {
    for (let row = 0; row < span2.rows; row += 1) {
      const at2 = (span2.offset + row * span2.width) * bytes2;
      const length6 = Math.min(span2.width * bytes2, out.length - at2);
      if (length6 > 0) {
        const from = offsets[i] + row * align(span2.width * bytes2);
        out.set(mapped.subarray(from, from + length6), at2);
      }
    }
  });
  buffer.unmap();
  buffer.destroy();
}
async function readWebGL(gl, texture, format, spans, dest) {
  const info = gpuFormatInfo(format);
  if (info.scalar === "snorm8") {
    throw new Error("snorm8 cannot be read back on WebGL2 (not renderable)");
  }
  const read = info.kind === "uint" ? { format: gl.RGBA_INTEGER, type: gl.UNSIGNED_INT, array: Uint32Array } : info.kind === "sint" ? { format: gl.RGBA_INTEGER, type: gl.INT, array: Int32Array } : info.scalar === "unorm8" ? { format: gl.RGBA, type: gl.UNSIGNED_BYTE, array: Uint8Array } : { format: gl.RGBA, type: gl.FLOAT, array: Float32Array };
  const texelBytes = 4 * read.array.BYTES_PER_ELEMENT;
  const total = spans.reduce((sum, span2) => sum + span2.width * span2.rows, 0);
  const pack = gl.createBuffer();
  withGlState(gl, () => {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, Math.max(total * texelBytes, 4), gl.STREAM_READ);
    let at3 = 0;
    for (const span2 of spans) {
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, span2.layer);
      gl.readPixels(span2.x, span2.y, span2.width, span2.rows, read.format, read.type, at3 * texelBytes);
      at3 += span2.width * span2.rows;
    }
    gl.deleteFramebuffer(framebuffer);
  });
  await glFence(gl);
  const components = info.components;
  const half = info.scalar === "float16";
  if (components === 4 && !half && dest instanceof read.array) {
    withGlState(gl, () => {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
      let at3 = 0;
      for (const span2 of spans) {
        const length6 = Math.min(span2.width * span2.rows * 4, dest.length - span2.offset * 4);
        if (length6 > 0) {
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, at3 * texelBytes, dest, span2.offset * 4, length6);
        }
        at3 += span2.width * span2.rows;
      }
    });
    gl.deleteBuffer(pack);
    return;
  }
  const texels = new read.array(total * 4);
  withGlState(gl, () => {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, texels);
  });
  gl.deleteBuffer(pack);
  let at2 = 0;
  for (const span2 of spans) {
    for (let i = 0; i < span2.width * span2.rows; i += 1, at2 += 1) {
      const base = (span2.offset + i) * components;
      for (let c = 0; c < components && base + c < dest.length; c += 1) {
        const value = texels[at2 * 4 + c];
        dest[base + c] = half ? toHalfBits(value) : value;
      }
    }
  }
}
async function glFence(gl) {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  try {
    while (true) {
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.WAIT_FAILED) {
        throw new Error("clientWaitSync failed");
      }
      if (status !== gl.TIMEOUT_EXPIRED) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } finally {
    gl.deleteSync(sync);
  }
}
function withGlState(gl, fn) {
  const bindings = {
    readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    packBuffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
    unpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
    texture: gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY)
  };
  const unpack = [
    gl.UNPACK_ALIGNMENT,
    gl.UNPACK_FLIP_Y_WEBGL,
    gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
    gl.UNPACK_ROW_LENGTH,
    gl.UNPACK_IMAGE_HEIGHT,
    gl.UNPACK_SKIP_PIXELS,
    gl.UNPACK_SKIP_ROWS,
    gl.UNPACK_SKIP_IMAGES
  ];
  const saved = unpack.map((name) => gl.getParameter(name));
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  for (const name of unpack.slice(1)) {
    gl.pixelStorei(name, 0);
  }
  try {
    fn();
  } finally {
    unpack.forEach((name, i) => gl.pixelStorei(name, saved[i]));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, bindings.readFramebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, bindings.packBuffer);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, bindings.unpackBuffer);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, bindings.texture);
  }
}
function glEnum(gl, name) {
  return gl[name];
}
var floatView = new Float32Array(1);
var bitsView = new Uint32Array(floatView.buffer);
function toHalfBits(value) {
  floatView[0] = value;
  const bits = bitsView[0];
  const sign2 = bits >>> 16 & 32768;
  const exponent = (bits >>> 23 & 255) - 127 + 15;
  const mantissa = bits & 8388607;
  if (exponent >= 31) {
    return sign2 | 31744 | ((bits >>> 23 & 255) === 255 && mantissa ? 512 : 0);
  }
  if (exponent <= 0) {
    return exponent < -10 ? sign2 : sign2 | (mantissa | 8388608) >> 14 - exponent;
  }
  return sign2 | exponent << 10 | mantissa >> 13;
}

// src/gpu/GpuArrays.ts
var nextTextureVersion = 1;
function makeArrayTexture(name, format, layout, internalFormat) {
  const info = gpuFormatInfo(format);
  const texture = new THREE5.DataArrayTexture(null, layout.width, layout.height, layout.layers);
  texture.name = name;
  texture.format = info.threeFormat;
  texture.type = info.threeType;
  texture.internalFormat = internalFormat ?? null;
  texture.minFilter = THREE5.NearestFilter;
  texture.magFilter = THREE5.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE5.NoColorSpace;
  texture.needsUpdate = true;
  texture.version = nextTextureVersion++;
  texture.source.dataReady = false;
  return texture;
}
var GpuArrays = class _GpuArrays {
  renderer;
  schema;
  // Storable channels can also be written from compute (wgpu/,
  // WebGPU only)
  storage;
  count = 0;
  // Elements the textures hold, including the layout's padding
  capacity = 0;
  // Grows whenever these arrays' methods change their contents (upload,
  // copyFrom, write, writeBatch, swap, a reallocation)
  version = 0;
  bundles;
  // Render targets over channel textures, per output set
  targets = /* @__PURE__ */ new Map();
  constructor({ renderer, bundles, capacity = 1, storage: storage2 = false }) {
    if (storage2 && !isWebGPUBackend(renderer)) {
      throw new Error("GpuArrays with storage: true need the WebGPU backend");
    }
    this.renderer = renderer;
    this.schema = bundles;
    this.storage = storage2;
    this.bundles = {};
    this.allocate(capacity);
  }
  // Whether every channel of a bundle can live on the GPU
  static supports(def) {
    return Object.values(def.channels).every((format) => {
      const { scalar, components } = ArrayFormats.info(format);
      return ArrayFormats.info(ArrayFormats.make(scalar, components * def.packing)).gpu;
    });
  }
  // GPU copy of `data` (its GPU-capable bundles, or `bundles`), uploaded
  static fromData(renderer, data, { bundles, storage: storage2 } = {}) {
    const names = bundles ?? Object.keys(data.bundles).filter((name) => _GpuArrays.supports(data.bundles[name].def));
    const schema = Object.fromEntries(names.map((name) => [name, data.bundles[name].def]));
    const arrays = new _GpuArrays({ renderer, bundles: schema, capacity: data.capacity, storage: storage2 });
    arrays.upload(data);
    return arrays;
  }
  // Elements [srcStart, srcStart + count) of `data` to dstStart. With no
  // range, all of data (growing; count = data.count). A range starting on a
  // texture row is rounded up to whole rows, from data's spare capacity.
  // Packed bundles need starts that are multiples of the packing.
  upload(data, { bundles, srcStart = 0, dstStart = 0, count } = {}) {
    const full = count === void 0 && srcStart === 0 && dstStart === 0;
    const n = count ?? data.count - srcStart;
    if (full) {
      this.ensureCapacity(n);
    } else if (dstStart + n > this.capacity) {
      throw new Error(`Upload of ${n} elements at ${dstStart} exceeds capacity ${this.capacity}`);
    }
    for (const name of bundles ?? Object.keys(this.bundles).filter((name2) => name2 in data.bundles)) {
      const bundle = this.bundle(name);
      const source = data.bundles[name];
      if (!source) {
        throw new Error(`Bundle ${name} missing from the uploaded data`);
      }
      bundle.meta = { ...source.meta };
      const packing = bundle.def.packing;
      if (srcStart % packing !== 0 || dstStart % packing !== 0) {
        throw new Error(`Bundle ${name}: starts must be multiples of the packing ${packing}`);
      }
      const src = srcStart / packing;
      const dst = dstStart / packing;
      let texels = Math.ceil(n / packing);
      const { width } = bundle.layout;
      if (src % width === 0 && dst % width === 0) {
        const available = Math.ceil(data.capacity / packing) - src;
        texels = Math.max(texels, Math.min(Math.ceil(texels / width) * width, bundle.layout.texels - dst, available));
      }
      const spans = bundle.layout.spans(dst, texels);
      for (const [label, channel] of Object.entries(bundle.channels)) {
        const values = source.channels[label];
        if (values?.format !== channel.format) {
          throw new Error(`Channel ${name}.${label} missing or of another format`);
        }
        const texelComponents = ArrayFormats.info(channel.texelFormat).components;
        uploadTexels(this.renderer, channel.texture, channel.texelFormat, spans, padded(values.data, src * texelComponents, texels * texelComponents));
      }
    }
    this.count = full ? n : Math.max(this.count, dstStart + n);
    this.version += 1;
  }
  // Elements [start, start + count) as an ArrayData of count elements (into
  // `into` when given), every channel in its own typed array
  async read({ bundles, start = 0, count = this.count - start, into } = {}) {
    const out = into ?? new ArrayData({ count });
    out.ensureCapacity(count);
    out.count = count;
    const reads = [];
    for (const name of bundles ?? Object.keys(this.bundles)) {
      const bundle = this.bundle(name);
      if (!(name in out.bundles)) {
        out.addBundle(name, bundle.def);
      }
      out.bundles[name].meta = { ...bundle.meta };
      const packing = bundle.def.packing;
      if (start % packing !== 0) {
        throw new Error(`Bundle ${name}: start must be a multiple of the packing ${packing}`);
      }
      const spans = bundle.layout.spans(start / packing, Math.ceil(count / packing));
      for (const [label, channel] of Object.entries(bundle.channels)) {
        const components = ArrayFormats.info(channel.format).components;
        const dest = out.bundles[name].channels[label].data.subarray(0, count * components);
        reads.push(readTexels(this.renderer, channel.texture, channel.texelFormat, spans, dest));
      }
    }
    await Promise.all(reads);
    return out;
  }
  // GPU copy of elements from `src`, whose bundles must match
  copyFrom(src, { bundles, srcStart = 0, dstStart = 0, count } = {}) {
    const n = count ?? src.count - srcStart;
    if (dstStart + n > this.capacity || srcStart + n > src.capacity) {
      throw new Error(`Copy of ${n} elements from ${srcStart} to ${dstStart} is out of range`);
    }
    for (const name of bundles ?? Object.keys(this.bundles).filter((name2) => name2 in src.bundles)) {
      const to = this.bundle(name);
      const from = src.bundle(name);
      const packing = to.def.packing;
      if (from.def.packing !== packing || srcStart % packing !== 0 || dstStart % packing !== 0) {
        throw new Error(`Bundle ${name}: packings differ or starts are not multiples of ${packing}`);
      }
      const spans = TextureLayout.copySpans(from.layout, srcStart / packing, to.layout, dstStart / packing, Math.ceil(n / packing));
      for (const [label, channel] of Object.entries(to.channels)) {
        const source = from.channels[label];
        if (source?.format !== channel.format) {
          throw new Error(`Channel ${name}.${label} missing or of another format`);
        }
        copyTexels(this.renderer, source.texture, channel.texture, spans);
      }
      to.meta = { ...from.meta };
    }
    this.count = Math.max(this.count, dstStart + n);
    this.version += 1;
  }
  // Reallocate every texture: contents are discarded and count reset.
  // Nothing happens when the layouts would stay the same.
  setCapacity(capacity) {
    const unchanged = Object.values(this.anyBundles).every((bundle) => TextureLayout.for(Math.ceil(capacity / bundle.def.packing)).texels === bundle.layout.texels);
    if (unchanged && this.capacity > 0) {
      return false;
    }
    this.allocate(capacity);
    this.count = 0;
    this.version += 1;
    return true;
  }
  ensureCapacity(capacity) {
    if (capacity <= this.capacity) {
      return false;
    }
    return this.setCapacity(Math.max(capacity, this.capacity * 2));
  }
  // Whether compute can write these arrays (made with storage: true);
  // narrows the type so compute writers are accepted
  hasStorage() {
    return this.storage === true;
  }
  // Run a writer (fragment GpuArrayWriter, or compute WgpuArrayWriter on
  // storage arrays) over elements [at, at + count): count = max(count, end)
  write(writer, range2) {
    writer.run(this, [{ writer, ...range2 }]);
    this.version += 1;
  }
  // Several writers or ranges, each kind run together: fragment items
  // overlapping a layer are drawn in that layer's single pass. Ranges
  // should not overlap.
  writeBatch(items) {
    const kinds = /* @__PURE__ */ new Map();
    for (const item of items) {
      kinds.set(item.writer.run, [...kinds.get(item.writer.run) ?? [], item]);
    }
    for (const [run, group] of kinds) {
      run(this, group);
    }
    this.version += 1;
  }
  // Swap contents with `other` (same renderer). Readers bound to either
  // must be bound again.
  swap(other) {
    if (other.renderer !== this.renderer || other.storage !== this.storage) {
      throw new Error("Cannot swap arrays of different renderers or storage settings");
    }
    [this.bundles, other.bundles] = [other.bundles, this.bundles];
    [this.count, other.count] = [other.count, this.count];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
    [this.targets, other.targets] = [other.targets, this.targets];
    this.version += 1;
    other.version += 1;
  }
  // A render target whose attachments are these channel textures (cached)
  renderTarget(outputs) {
    const key = outputs.map(({ bundle, channel }) => `${bundle}.${channel}`).join(",");
    let target = this.targets.get(key);
    if (!target) {
      const layout = this.bundle(outputs[0].bundle).layout;
      const textures = outputs.map(({ bundle, channel }) => {
        if (this.bundle(bundle).layout.texels !== layout.texels) {
          throw new Error("Writer outputs must share one texel layout (same packing)");
        }
        return this.bundle(bundle).channels[channel].texture;
      });
      target = new THREE5.RenderTarget(layout.width, layout.height, { depth: layout.layers, depthBuffer: false, count: outputs.length });
      target.textures = textures;
      if (this.storage) {
        const textureData = this.renderer._textures.get(target);
        Object.assign(textureData, { width: layout.width, height: layout.height, sampleCount: 1 });
      }
      this.targets.set(key, target);
    }
    return target;
  }
  bundle(name) {
    const bundle = this.anyBundles[name];
    if (!bundle) {
      throw new Error(`Bundle ${name} not in these GpuArrays`);
    }
    return bundle;
  }
  dispose() {
    this.releaseTextures();
    this.bundles = {};
    this.count = 0;
    this.capacity = 0;
  }
  allocate(capacity) {
    this.releaseTextures();
    const webgpu = isWebGPUBackend(this.renderer);
    const bundles = {};
    let allocated = Number.POSITIVE_INFINITY;
    for (const [name, def] of Object.entries(this.schema)) {
      if (!_GpuArrays.supports(def)) {
        throw new Error(`Bundle ${name} has CPU-only formats`);
      }
      const layout = TextureLayout.for(Math.ceil(capacity / def.packing));
      allocated = Math.min(allocated, layout.texels * def.packing);
      const channels = {};
      for (const [label, format] of Object.entries(def.channels)) {
        const { scalar, components } = ArrayFormats.info(format);
        const texelFormat = ArrayFormats.make(scalar, components * def.packing);
        const info = gpuFormatInfo(texelFormat);
        const texture = makeArrayTexture(`radix_${name}_${label}`, texelFormat, layout, webgpu ? info.webgpu : info.gl);
        const storage2 = this.storage && info.storable;
        if (storage2) {
          Object.assign(texture, { isStorageTexture: true, isArrayTexture: true });
        }
        this.renderer.initTexture(texture);
        channels[label] = { format, texelFormat, texture, storage: storage2 };
      }
      bundles[name] = { def, layout, channels, meta: { ...this.anyBundles[name]?.meta } };
    }
    this.bundles = bundles;
    this.capacity = Number.isFinite(allocated) ? allocated : capacity;
  }
  releaseTextures() {
    for (const target of this.targets.values()) {
      target.dispose();
    }
    this.targets.clear();
    for (const bundle of Object.values(this.anyBundles)) {
      for (const channel of Object.values(bundle.channels)) {
        channel.texture.dispose();
      }
    }
  }
  get anyBundles() {
    return this.bundles;
  }
};
function padded(values, start, length6) {
  if (start + length6 <= values.length) {
    return values.subarray(start, start + length6);
  }
  const out = new values.constructor(length6);
  out.set(values.subarray(start));
  return out;
}

// src/gpu/GpuArrayReader.ts
var { int: int2, ivec2, nodeObject, select: select3, uint: uint2, uniform: uniform2 } = TSL;
var ArrayTextureNode = class extends TextureNode {
  constructor(value, uvNode, levelNode, biasNode) {
    super(value, uvNode, levelNode, biasNode);
    this.updateMatrix = false;
  }
  setupUV(_builder, uvNode) {
    return uvNode;
  }
};
var GpuArrayReader = class {
  def;
  // Elements readable through load() (uint uniform)
  count;
  // log2 and mask of the bound layout's height
  yBits;
  yMask;
  channels = {};
  constructor(def) {
    this.def = def;
    this.count = uniform2(0, "uint");
    this.yBits = uniform2(0, "uint");
    this.yMask = uniform2(0, "uint");
    for (const [label, format] of Object.entries(def.channels)) {
      const { scalar, components } = ArrayFormats.info(format);
      const texelFormat = ArrayFormats.make(scalar, components * def.packing);
      this.channels[label] = { format, texelFormat, node: nodeObject(new ArrayTextureNode(placeholder(texelFormat))) };
    }
  }
  // Read bundle `name` of `arrays` from now on (count 0 without arrays).
  // Rebind after the arrays' count changes or they are resized.
  bind(arrays, name) {
    if (!arrays || !name) {
      this.count.value = 0;
      for (const label in this.channels) {
        const channel = this.channels[label];
        channel.node.value = placeholder(channel.texelFormat);
      }
      return this;
    }
    const source = arrays.bundle(name);
    if (source.def.packing !== this.def.packing) {
      throw new Error(`Bundle ${name} has packing ${source.def.packing}, the reader ${this.def.packing}`);
    }
    for (const label in this.channels) {
      const channel = this.channels[label];
      const texture = source.channels[label];
      if (texture?.format !== channel.format) {
        throw new Error(`Channel ${name}.${label} missing or not ${channel.format}`);
      }
      channel.node.value = texture.texture;
    }
    this.count.value = arrays.count;
    this.yBits.value = source.layout.yBits;
    this.yMask.value = source.layout.height - 1;
    return this;
  }
  // Element `index` of `channel` (typed by its format), zero past count
  load(channel, index) {
    const { node } = gpuFormatInfo(this.channel(channel).format);
    return select3(index.lessThan(this.count), this.fetch(channel, index), TSL[node](0));
  }
  // Element `index` without a bounds check
  fetch(channel, index) {
    const { format, node } = this.channel(channel);
    const components = ArrayFormats.info(format).components;
    const packing = this.def.packing;
    const { x, y, layer } = texelCoord(packing === 1 ? index : index.shiftRight(uint2(Math.log2(packing))), this.yBits, this.yMask);
    const texel = node.load(ivec2(int2(x), int2(y))).depth(int2(layer)).toVar();
    if (packing === 1) {
      return components === 1 ? texel.x : components === 2 ? texel.xy : texel;
    }
    const slot = index.bitAnd(uint2(packing - 1));
    return components === 1 ? texel.element(slot) : select3(slot.equal(uint2(0)), texel.xy, texel.zw);
  }
  channel(label) {
    const channel = this.channels[label];
    if (!channel) {
      throw new Error(`Channel ${label} not in the reader's bundle`);
    }
    return channel;
  }
};
var placeholders = /* @__PURE__ */ new Map();
function placeholder(texelFormat) {
  let texture = placeholders.get(texelFormat);
  if (!texture) {
    texture = makeArrayTexture(`radix_readerPlaceholder_${texelFormat}`, texelFormat, TextureLayout.for(1));
    placeholders.set(texelFormat, texture);
  }
  return texture;
}

// src/gpu/GpuArrayWriter.ts
import * as THREE6 from "three";
import { Node, NodeMaterial, OutputStructNode } from "three/webgpu";
var { Discard, If: If2, float: float3, int: int3, ivec4, mix: mix2, positionGeometry, uint: uint3, uniform: uniform3, uvec2, uvec4, vec4: vec42 } = TSL;
var MAX_WRITER_CHANNELS = 4;
var MAX_WRITER_BYTES = 64;
function writerChannels(outputs) {
  const channels = [];
  const packings = /* @__PURE__ */ new Set();
  for (const [bundle, def] of Object.entries(outputs)) {
    packings.add(def.packing);
    for (const [channel, format] of Object.entries(def.channels)) {
      const { scalar, components } = ArrayFormats.info(format);
      channels.push({ bundle, channel, texelFormat: ArrayFormats.make(scalar, components * def.packing) });
    }
  }
  if (channels.length === 0) {
    throw new Error("Writer has no output channels");
  }
  if (packings.size > 1) {
    throw new Error("Writer outputs must share one packing");
  }
  return { channels, packing: [...packings][0] };
}
function writerVars(channels) {
  const out = {};
  const vars = channels.map(({ bundle, channel, texelFormat }) => {
    const value = TSL[gpuFormatInfo(texelFormat).node](0).toVar(`out_${bundle}_${channel}`);
    (out[bundle] ??= {})[channel] = value;
    return value;
  });
  return { out, vars };
}
function writeItemTexels(arrays, item) {
  const { writer } = item;
  const at2 = item.at ?? 0;
  if (at2 % writer.packing !== 0) {
    throw new Error(`Write at ${at2} is not a multiple of the packing ${writer.packing}`);
  }
  for (const { bundle, channel, texelFormat } of writer.channels) {
    if (arrays.bundle(bundle).channels[channel]?.texelFormat !== texelFormat) {
      throw new Error(`Writer output ${bundle}.${channel} does not match the arrays`);
    }
  }
  if (at2 + item.count > arrays.capacity) {
    throw new Error(`Write of ${item.count} elements at ${at2} exceeds capacity ${arrays.capacity}`);
  }
  return { start: at2 / writer.packing, end: Math.ceil((at2 + item.count) / writer.packing) };
}
function countWrites(arrays, items) {
  for (const item of items) {
    if (item.count > 0) {
      arrays.count = Math.max(arrays.count, Math.min(arrays.capacity, (item.at ?? 0) + item.count));
    }
  }
}
var GpuArrayWriter = class {
  // Output channels and bytes per texel one writer may have
  static MAX_CHANNELS = MAX_WRITER_CHANNELS;
  static MAX_BYTES = MAX_WRITER_BYTES;
  outputs;
  packing;
  // Channels in attachment order
  channels;
  material;
  storage = false;
  run = runWriters;
  constructor({ outputs, write, label }) {
    this.outputs = outputs;
    const { channels, packing } = writerChannels(outputs);
    this.channels = channels;
    this.packing = packing;
    let bytes2 = 0;
    for (const { bundle, channel, texelFormat } of channels) {
      const info = gpuFormatInfo(texelFormat);
      if (!info.renderable) {
        throw new Error(`Writer output ${bundle}.${channel}: ${texelFormat} is not renderable`);
      }
      const normalized8x4 = info.components === 4 && info.kind === "float" && ArrayFormats.info(texelFormat).scalarBytes === 1;
      bytes2 += normalized8x4 ? 8 : ArrayFormats.info(texelFormat).bytes;
    }
    if (channels.length > MAX_WRITER_CHANNELS || bytes2 > MAX_WRITER_BYTES) {
      throw new Error(`Writer writes ${channels.length} channels, ${bytes2} bytes per texel (1 to ${MAX_WRITER_CHANNELS}, at most ${MAX_WRITER_BYTES})`);
    }
    const range2 = (key) => uniform3(0, "uint").onObjectUpdate(({ object }) => object.userData[key]);
    const r = { start: range2("start"), end: range2("end"), first: range2("first"), layer: range2("layer"), yBits: range2("yBits") };
    const rowStart = range2("rowStart");
    const rowEnd = range2("rowEnd");
    const height = range2("height");
    const flip = uniform3(1).onObjectUpdate(({ object }) => object.userData.flip);
    const row = mix2(float3(rowStart), float3(rowEnd), positionGeometry.y);
    this.material = new NodeMaterial();
    this.material.name = label ?? `radix_write_${channels.map(({ bundle, channel }) => `${bundle}_${channel}`).join("_")}`;
    this.material.vertexNode = vec42(positionGeometry.x.mul(2).sub(1), flip.mul(float3(1).sub(row.mul(2).div(float3(height)))), 0, 1);
    this.material.fragmentNode = new WriterOutputNode(() => {
      const coord = uvec2(new FragCoordNode());
      const texel = r.layer.shiftLeft(r.yBits).bitOr(coord.y).shiftLeft(uint3(Math.log2(TextureLayout.WIDTH))).bitOr(coord.x).toVar();
      If2(texel.lessThan(r.start).or(texel.greaterThanEqual(r.end)), () => {
        Discard();
      });
      const { out, vars } = writerVars(channels);
      write(texel.sub(r.start).mul(uint3(packing)).add(r.first), out);
      return vars.map((value, i) => widen(channels[i].texelFormat, value));
    });
    this.material.blending = THREE6.NoBlending;
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.side = THREE6.DoubleSide;
  }
  dispose() {
    this.material.dispose();
  }
};
var quadPosition = new THREE6.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3);
quadPosition.name = "radix_writerQuadPosition";
var quadIndex = new THREE6.Uint16BufferAttribute([0, 1, 2, 2, 1, 3], 1);
quadIndex.name = "radix_writerQuadIndex";
var quad = new THREE6.BufferGeometry();
quad.setAttribute("position", quadPosition);
quad.setIndex(quadIndex);
var scene = new THREE6.Scene();
var camera = new THREE6.OrthographicCamera(-1, 1, 1, -1, 0, 1);
var meshes = [];
function runWriters(arrays, items) {
  const renderer = arrays.renderer;
  const flip = isWebGPUBackend(renderer) ? 1 : -1;
  const groups = /* @__PURE__ */ new Map();
  for (const item of items) {
    if (item.count <= 0) {
      continue;
    }
    const writer = item.writer;
    const { start, end } = writeItemTexels(arrays, item);
    const target = arrays.renderTarget(writer.channels);
    groups.set(target, [...groups.get(target) ?? [], { writer, start, end, first: item.first ?? 0 }]);
  }
  const saved = {
    target: renderer.getRenderTarget(),
    layer: renderer.getActiveCubeFace(),
    level: renderer.getActiveMipmapLevel(),
    autoClear: renderer.autoClear,
    xr: renderer.xr.enabled
  };
  renderer.autoClear = false;
  renderer.xr.enabled = false;
  try {
    for (const [target, group] of groups) {
      const { width, height, yBits } = arrays.bundle(group[0].writer.channels[0].bundle).layout;
      const layerSize = width * height;
      const firstLayer = Math.min(...group.map((item) => Math.floor(item.start / layerSize)));
      const lastLayer = Math.max(...group.map((item) => Math.floor((item.end - 1) / layerSize)));
      for (let layer = firstLayer; layer <= lastLayer; layer += 1) {
        scene.clear();
        for (const item of group) {
          const start = Math.max(item.start, layer * layerSize);
          const end = Math.min(item.end, (layer + 1) * layerSize);
          if (start >= end) {
            continue;
          }
          const mesh = meshes[scene.children.length] ??= Object.assign(new THREE6.Mesh(quad), { frustumCulled: false });
          mesh.material = item.writer.material;
          const range2 = {
            start: item.start,
            end: item.end,
            first: item.first,
            layer,
            height,
            yBits,
            flip,
            rowStart: Math.floor((start - layer * layerSize) / width),
            rowEnd: Math.ceil((end - layer * layerSize) / width)
          };
          mesh.userData = range2;
          scene.add(mesh);
        }
        renderer.setRenderTarget(target, layer);
        renderer.render(scene, camera);
      }
    }
  } finally {
    scene.clear();
    renderer.setRenderTarget(saved.target, saved.layer, saved.level);
    renderer.autoClear = saved.autoClear;
    renderer.xr.enabled = saved.xr;
  }
  countWrites(arrays, items);
}
function widen(texelFormat, value) {
  const { components, kind } = gpuFormatInfo(texelFormat);
  if (components === 4) {
    return value;
  }
  const make = kind === "uint" ? uvec4 : kind === "sint" ? ivec4 : vec42;
  const zero = kind === "uint" ? uint3(0) : kind === "sint" ? int3(0) : float3(0);
  return components === 1 ? make(value, zero, zero, zero) : make(value, zero, zero);
}
var FragCoordNode = class extends Node {
  constructor() {
    super("vec2");
  }
  generate(builder) {
    return builder.getFragCoord();
  }
};
var WriterOutputNode = class extends OutputStructNode {
  body;
  constructor(body) {
    super();
    this.body = body;
  }
  setup(builder) {
    const stacks = builder;
    const stack = stacks.addStack();
    const members = this.body();
    stacks.removeStack();
    stack.outputNode = members[0];
    this.members = [stack, ...members.slice(1)];
    return super.setup(builder);
  }
};

// src/gpu/math.tsl.ts
var { Break, Fn: Fn3, If: If3, Loop, abs: abs2, atan, cos: cos2, cross, dot, float: float4, int: int4, inverseSqrt, mat3, max: max3, normalize: normalize2, select: select4, sin: sin2, struct, transpose, vec3: vec33, vec4: vec43 } = TSL;
var Eigens = struct({ values: "vec3", basis: "mat3" }, "SplatEigens");
var at = (m, col, row) => m.element(col).element(row);
var quatRotate = Fn3(([q, v]) => {
  const t = cross(q.xyz, v).mul(2).toVar();
  return v.add(q.w.mul(t)).add(cross(q.xyz, t));
});
var quatMul = Fn3(([q1, q2]) => vec43(
  q1.w.mul(q2.x).add(q1.x.mul(q2.w)).add(q1.y.mul(q2.z)).sub(q1.z.mul(q2.y)),
  q1.w.mul(q2.y).sub(q1.x.mul(q2.z)).add(q1.y.mul(q2.w)).add(q1.z.mul(q2.x)),
  q1.w.mul(q2.z).add(q1.x.mul(q2.y)).sub(q1.y.mul(q2.x)).add(q1.z.mul(q2.w)),
  q1.w.mul(q2.w).sub(q1.x.mul(q2.x)).sub(q1.y.mul(q2.y)).sub(q1.z.mul(q2.z))
));
var scaleQuatMatrix = Fn3(([s, q]) => {
  return mat3(
    vec33(
      s.x.mul(float4(1).sub(float4(2).mul(q.y.mul(q.y).add(q.z.mul(q.z))))),
      s.x.mul(float4(2).mul(q.x.mul(q.y).add(q.w.mul(q.z)))),
      s.x.mul(float4(2).mul(q.x.mul(q.z).sub(q.w.mul(q.y))))
    ),
    vec33(
      s.y.mul(float4(2).mul(q.x.mul(q.y).sub(q.w.mul(q.z)))),
      s.y.mul(float4(1).sub(float4(2).mul(q.x.mul(q.x).add(q.z.mul(q.z))))),
      s.y.mul(float4(2).mul(q.y.mul(q.z).add(q.w.mul(q.x))))
    ),
    vec33(
      s.z.mul(float4(2).mul(q.x.mul(q.z).add(q.w.mul(q.y)))),
      s.z.mul(float4(2).mul(q.y.mul(q.z).sub(q.w.mul(q.x)))),
      s.z.mul(float4(1).sub(float4(2).mul(q.x.mul(q.x).add(q.y.mul(q.y)))))
    )
  );
});
var symEigens = Fn3(([xxyyzz, xyxzyz]) => {
  const eps = float4(1e-6).mul(abs2(xxyyzz.x).add(abs2(xxyyzz.y)).add(abs2(xxyyzz.z))).toVar();
  const a = mat3(vec33(xxyyzz.x, xyxzyz.x, xyxzyz.y), vec33(xyxzyz.x, xxyyzz.y, xyxzyz.z), vec33(xyxzyz.y, xyxzyz.z, xxyyzz.z)).toVar();
  const v = mat3(vec33(1, 0, 0), vec33(0, 1, 0), vec33(0, 0, 1)).toVar();
  Loop(16, () => {
    const p = int4(0).toVar();
    const q = int4(1).toVar();
    const maxValue = abs2(at(a, 0, 1)).toVar();
    If3(abs2(at(a, 0, 2)).greaterThan(maxValue), () => {
      maxValue.assign(abs2(at(a, 0, 2)));
      q.assign(2);
    });
    If3(abs2(at(a, 1, 2)).greaterThan(maxValue), () => {
      maxValue.assign(abs2(at(a, 1, 2)));
      p.assign(1);
      q.assign(2);
    });
    If3(maxValue.lessThanEqual(eps), () => {
      Break();
    });
    const phi = atan(at(a, p, q).mul(2), at(a, q, q).sub(at(a, p, p))).mul(0.5);
    const c = cos2(phi).toVar();
    const s = sin2(phi).toVar();
    const rotate = (m, first, second) => {
      Loop({ start: int4(0), end: int4(3), name: "r" }, ({ r }) => {
        const x = first(r).toVar();
        const y = second(r).toVar();
        first(r).assign(c.mul(x).sub(s.mul(y)));
        second(r).assign(s.mul(x).add(c.mul(y)));
      });
    };
    rotate(a, (r) => at(a, r, p), (r) => at(a, r, q));
    rotate(a, (r) => at(a, p, r), (r) => at(a, q, r));
    at(a, p, q).assign(0);
    at(a, q, p).assign(0);
    rotate(v, (r) => at(v, r, p), (r) => at(v, r, q));
  });
  const l0 = at(a, 0, 0).toVar();
  const l1 = at(a, 1, 1).toVar();
  const l2 = at(a, 2, 2).toVar();
  const v0 = normalize2(vec33(at(v, 0, 0), at(v, 1, 0), at(v, 2, 0))).toVar();
  const v1 = normalize2(vec33(at(v, 0, 1), at(v, 1, 1), at(v, 2, 1))).toVar();
  const v2 = normalize2(vec33(at(v, 0, 2), at(v, 1, 2), at(v, 2, 2))).toVar();
  const swap = (la, lb, va, vb) => {
    If3(la.lessThan(lb), () => {
      const l = la.toVar();
      la.assign(lb);
      lb.assign(l);
      const w = va.toVar();
      va.assign(vb);
      vb.assign(w);
    });
  };
  swap(l0, l1, v0, v1);
  swap(l0, l2, v0, v2);
  swap(l1, l2, v1, v2);
  If3(dot(cross(v0, v1), v2).lessThan(0), () => {
    v2.assign(v2.negate());
  });
  return Eigens(vec33(l0, l1, l2), mat3(v0, v1, v2));
});
var basisToQuat = Fn3(([basis3]) => {
  const x = basis3.element(0).toVar();
  const y = basis3.element(1).toVar();
  const z = basis3.element(2).toVar();
  const q = vec43(0).toVar();
  const set = (four, make) => {
    const inv = inverseSqrt(max3(four, 1e-30)).mul(0.5).toVar();
    q.assign(make(inv));
  };
  If3(z.z.lessThanEqual(0), () => {
    const dif10 = y.y.sub(x.x).toVar();
    const omm22 = float4(1).sub(z.z).toVar();
    If3(dif10.lessThanEqual(0), () => {
      const four = omm22.sub(dif10).toVar();
      set(four, (inv) => vec43(four.mul(inv), x.y.add(y.x).mul(inv), x.z.add(z.x).mul(inv), y.z.sub(z.y).mul(inv)));
    }).Else(() => {
      const four = omm22.add(dif10).toVar();
      set(four, (inv) => vec43(x.y.add(y.x).mul(inv), four.mul(inv), y.z.add(z.y).mul(inv), z.x.sub(x.z).mul(inv)));
    });
  }).Else(() => {
    const sum10 = y.y.add(x.x).toVar();
    const opm22 = float4(1).add(z.z).toVar();
    If3(sum10.lessThanEqual(0), () => {
      const four = opm22.sub(sum10).toVar();
      set(four, (inv) => vec43(x.z.add(z.x).mul(inv), y.z.add(z.y).mul(inv), four.mul(inv), x.y.sub(y.x).mul(inv)));
    }).Else(() => {
      const four = opm22.add(sum10).toVar();
      set(four, (inv) => vec43(y.z.sub(z.y).mul(inv), z.x.sub(x.z).mul(inv), x.y.sub(y.x).mul(inv), four.mul(inv)));
    });
  });
  q.assign(normalize2(q));
  return select4(q.w.lessThan(0), q.negate(), q);
});
var GpuSplatMath = class {
  // Rotate v by the unit quaternion q
  static quatRotate = quatRotate;
  // q1 applied after q2
  static quatMul = quatMul;
  static quatConj(q) {
    return vec43(q.xyz.negate(), q.w);
  }
  // Upper-left 3x3 of a mat4 (WGSL has no mat3x3(mat4x4) constructor)
  static mat3FromMat4(m) {
    return mat3(m.element(0).xyz, m.element(1).xyz, m.element(2).xyz);
  }
  // R(q) * diag(s), as columns
  static scaleQuatMatrix = scaleQuatMatrix;
  // Sigma = M M^T with M = R(q) diag(scales), as a mat3 (q normalized here)
  static covFromScaleQuat(scales, quat) {
    const m = scaleQuatMatrix(scales, normalize2(quat)).toVar();
    return m.mul(transpose(m));
  }
  // The symmetric matrix of a covariance's diagonal (xx, yy, zz) and
  // off-diagonal (xy, xz, yz)
  static covMatrix(xxyyzz, xyxzyz) {
    const d = xxyyzz.toVar();
    const o = xyxzyz.toVar();
    return mat3(vec33(d.x, o.x, o.y), vec33(o.x, d.y, o.z), vec33(o.y, o.z, d.z));
  }
  // Eigenvalues (descending, .get("values")) and eigenvectors (columns,
  // right-handed, .get("basis")) of a symmetric matrix
  static symEigens = symEigens;
  // Quaternion (w >= 0) of an orthonormal basis (columns)
  static basisToQuat = basisToQuat;
};

// src/gpu/sh.tsl.ts
var { If: If4, exp2, float: float5, int: int5, max: max4, min: min2, normalize: normalize3, select: select5, uint: uint4, uniform: uniform4, vec3: vec34 } = TSL;
var COMPONENTS = ["x", "y", "z", "w"];
var wordOf = (texel, w) => texel(w >> 2)[COMPONENTS[w & 3]];
var byteOf = (texel, b) => wordOf(texel, b >> 2).shiftRight(uint4((b & 3) * 8)).bitAnd(uint4(255));
var range = (band) => Array.from({ length: Sh.COEFFICIENTS[band] - Sh.COEFFICIENTS[band - 1] }, (_, i) => Sh.COEFFICIENTS[band - 1] + i);
var ext2 = {
  name: "ext",
  decodeBand: (band, texel) => range(band).map((k) => GpuEncoding.decodeExtRgb(wordOf(texel, k)))
};
var PACKED_BAND_START = [0, 0, 10, 26, 48];
var packed2 = {
  name: "packed",
  decodeBand(band, texel) {
    const start = PACKED_BAND_START[band];
    const code = byteOf(texel, start).toVar();
    const scale = select5(code.equal(uint4(0)), float5(0), exp2(float5(code).sub(192).div(16))).div(127).mul(2 ** -24).toVar();
    const signed = (b) => float5(int5(wordOf(texel, b >> 2).shiftLeft(uint4(24 - (b & 3) * 8)).bitAnd(uint4(4278190080))));
    const first = Sh.COEFFICIENTS[band - 1];
    return range(band).map((k) => {
      const at2 = start + 1 + (k - first) * 3;
      return vec34(signed(at2), signed(at2 + 1), signed(at2 + 2)).mul(scale);
    });
  }
};
var CODECS2 = { ext: ext2, packed: packed2 };
function basis2(band, d, squares) {
  const { x, y, z } = d;
  if (band === 1) {
    return [y.mul(-0.4886025), z.mul(0.4886025), x.mul(-0.4886025)];
  }
  const xx = squares.xx ??= x.mul(x).toVar();
  const yy = squares.yy ??= y.mul(y).toVar();
  const zz = squares.zz ??= z.mul(z).toVar();
  if (band === 2) {
    return [
      x.mul(y).mul(1.0925484),
      y.mul(z).mul(-1.0925484),
      zz.mul(2).sub(xx).sub(yy).mul(0.3153916),
      x.mul(z).mul(-1.0925484),
      xx.sub(yy).mul(0.5462742)
    ];
  }
  if (band === 3) {
    return [
      y.mul(xx.mul(3).sub(yy)).mul(-0.5900436),
      x.mul(y).mul(z).mul(2.8906114),
      y.mul(zz.mul(4).sub(xx).sub(yy)).mul(-0.4570458),
      z.mul(zz.mul(2).sub(xx.mul(3)).sub(yy.mul(3))).mul(0.3731763),
      x.mul(zz.mul(4).sub(xx).sub(yy)).mul(-0.4570458),
      z.mul(xx.sub(yy)).mul(1.4453057),
      x.mul(xx.sub(yy.mul(3))).mul(-0.5900436)
    ];
  }
  const zz7m1 = zz.mul(7).sub(1).toVar();
  const zz7m3 = zz.mul(7).sub(3).toVar();
  return [
    x.mul(y).mul(xx.sub(yy)).mul(2.5033429),
    y.mul(z).mul(xx.mul(3).sub(yy)).mul(-1.7701308),
    x.mul(y).mul(zz7m1).mul(0.9461747),
    y.mul(z).mul(zz7m3).mul(-0.6690465),
    zz.mul(zz.mul(35).sub(30)).add(3).mul(0.1057855),
    x.mul(z).mul(zz7m3).mul(-0.6690465),
    xx.sub(yy).mul(zz7m1).mul(0.4730873),
    x.mul(z).mul(xx.sub(yy.mul(3))).mul(-1.7701308),
    xx.mul(xx.sub(yy.mul(3))).sub(yy.mul(xx.mul(3).sub(yy))).mul(0.6258357)
  ];
}
var GpuSh = class _GpuSh {
  // The drawn degree's cap (uint): set per object from objectParams.maxShDegree
  // by the renderer, read by every GpuShReader
  static maxDegree = uniform4(Sh.MAX_DEGREE, "uint");
  // A codec's TSL decoder by name
  static codec(name) {
    return CODECS2[Sh.codec(name).name];
  }
  // The SH color (vec3) along unit `dir` through `degree`: band b's
  // coefficients come from coefficients(b), called inside a branch on
  // min(maxDegree, limit) >= b, each band's nested in the one below it, so
  // a band above the cap costs nothing and values (texels) made for one
  // band can be reused by the next (`limit`: a uint node, such as the
  // degree a reader is bound to; cap false: no branch)
  static evaluate(dir, degree, coefficients, { cap = true, limit } = {}) {
    const d = dir.toVar();
    const sum = vec34(0, 0, 0).toVar();
    const top = cap ? (limit ? min2(_GpuSh.maxDegree, limit) : _GpuSh.maxDegree).toVar() : void 0;
    const squares = {};
    const add = (band) => {
      const values = coefficients(band);
      sum.addAssign(basis2(band, d, squares).reduce((total, w, k) => total.add(values[k].mul(w)), vec34(0, 0, 0)));
      if (band < degree) {
        next(band + 1);
      }
    };
    const next = (band) => top ? If4(top.greaterThanEqual(uint4(band)), () => add(band)) : add(band);
    if (degree >= 1) {
      next(1);
    }
    return sum;
  }
};
var GpuShReader = class _GpuShReader {
  codec;
  degree;
  palette;
  gpuCodec;
  // One reader per channel (per splat), so a lower-degree bundle binds
  // the channels it has; one for the palette's entries
  channels;
  labels;
  stride;
  // The degree of the SH bound (0: none)
  bound;
  constructor({ codec, degree, palette = false }) {
    this.codec = codec;
    this.degree = degree;
    this.palette = palette;
    this.gpuCodec = GpuSh.codec(codec);
    const names = palette ? ["shEntries"] : Object.keys(Sh.bundle(this.codec, degree).channels);
    this.channels = names.map((name) => ({ name, reader: new GpuArrayReader(defineBundle({ [name]: "uint32x4" })) }));
    this.labels = palette ? new GpuArrayReader(Sh.LABEL) : void 0;
    this.stride = uniform4(1, "uint");
    this.bound = uniform4(0, "uint");
  }
  // The reader of the SH in `arrays` (and `palette`), or undefined when
  // they have none, at most `degree`
  static for(arrays, { palette, degree } = {}) {
    const found = _GpuShReader.find(arrays, palette);
    if (!found || degree === 0) {
      return void 0;
    }
    return new _GpuShReader({ codec: found.codec, degree: Math.min(degree ?? Sh.MAX_DEGREE, found.degree), palette: found.palette });
  }
  // What SH `arrays` (and `palette`) hold: { codec, degree, palette }
  static find(arrays, palette) {
    if (palette && arrays.bundles.shLabel) {
      const meta = palette.bundle("shPalette").meta;
      return { codec: Sh.codec(meta.codec).name, degree: meta.degree, palette: true };
    }
    const found = Sh.find(arrays.bundles);
    return found && { codec: found.codec, degree: found.degree, palette: false };
  }
  // Read the SH of `arrays` (per splat), or its labels and `palette`'s
  // entries; nothing reads zero
  bind(arrays, palette) {
    if (this.labels) {
      const ok = !!(arrays?.bundles.shLabel && palette?.bundles.shPalette);
      const meta = ok ? palette.bundle("shPalette").meta : void 0;
      const usable2 = ok && meta.codec === this.codec;
      this.labels.bind(usable2 ? arrays : void 0, "shLabel");
      this.channels[0].reader.bind(usable2 ? palette : void 0, "shPalette");
      this.stride.value = meta?.stride ?? 1;
      this.bound.value = usable2 ? Math.min(this.degree, meta.degree) : 0;
      return this;
    }
    const found = arrays && Sh.find(arrays.bundles);
    const usable = found?.codec === this.codec ? found : void 0;
    const bundle = usable && arrays.bundle(usable.name);
    for (const { name, reader } of this.channels) {
      reader.bind(bundle?.channels[name] ? arrays : void 0, usable?.name);
    }
    this.bound.value = usable ? Math.min(this.degree, usable.degree) : 0;
    return this;
  }
  // Texel j of stored splat `index`'s entry, each loaded on first use and
  // kept (the palette's label too): use it in one scope or nested ones
  texels(index) {
    const loaded = [];
    let first;
    return (j) => {
      if (!loaded[j]) {
        if (this.labels) {
          first ??= uint4(this.labels.load("label", index)).mul(this.stride).toVar();
          loaded[j] = this.channels[0].reader.load("shEntries", first.add(uint4(j))).toVar();
        } else {
          loaded[j] = this.channels[j].reader.load(this.channels[j].name, index).toVar();
        }
      }
      return loaded[j];
    };
  }
  decode(band, texel) {
    return this.gpuCodec.decodeBand(band, texel);
  }
  // Band `band`'s coefficients of stored splat `index` (vec3 each); texels
  // are loaded once per call
  band(index, band) {
    return this.decode(band, this.texels(index));
  }
  // All coefficients through the reader's degree (no cap), each texel
  // loaded once
  coefficients(index) {
    const texel = this.texels(index);
    return [1, 2, 3, 4].filter((b) => b <= this.degree).flatMap((b) => this.decode(b, texel));
  }
  // The SH color of stored splat `index` at `center` seen from `origin`
  // (both in the splats' space); add it to rgb and clamp at 0. Each texel
  // (and the label) loads once, in the branch of the first band needing it.
  color(index, origin, center) {
    const texel = this.texels(index.toVar());
    return GpuSh.evaluate(normalize3(center.sub(origin)), this.degree, (band) => this.decode(band, texel), { limit: this.bound });
  }
  // splat.rgb plus the SH color, clamped at 0, for a splat node of either form
  apply(splat, index, origin) {
    const out = splat.toVar();
    const rgb2 = out.get("rgb");
    rgb2.assign(max4(rgb2.add(this.color(index, origin, out.get("center"))), vec34(0, 0, 0)));
    return out;
  }
};
var GpuShPalette = class {
  static upload(renderer, palette) {
    return GpuArrays.fromData(renderer, palette.data);
  }
  static create(renderer, { codec, degree, size, stride, storage: storage2 }) {
    const s = stride ?? ShPalette.strideOf(codec, degree);
    const arrays = new GpuArrays({ renderer, bundles: { shPalette: ShPalette.BUNDLE }, capacity: size * s, storage: storage2 });
    arrays.bundle("shPalette").meta = { codec, degree, size, stride: s };
    return arrays;
  }
};

// src/gpu/sortKey.tsl.ts
var { clamp: clamp3, floatBitsToUint, floor: floor2, max: max5, min: min3, select: select6, uint: uint5, uvec4: uvec42, vec4: vec44 } = TSL;
var GpuSortKeys = class _GpuSortKeys {
  // The invalid key of a width: all ones
  static invalid(bits) {
    return select6(bits.equal(uint5(32)), uint5(4294967295), uint5(1).shiftLeft(bits).sub(uint5(1)));
  }
  // Key of a distance >= 0; non-finite distances give the invalid key
  static compute(distance, bits) {
    const mask = _GpuSortKeys.invalid(bits).toVar();
    const validMax = uint5(255).shiftLeft(bits.sub(uint5(8))).sub(uint5(1));
    const f = floatBitsToUint(max5(distance, 0)).toVar();
    const q16 = clamp3(f, uint5(SortKeys.KEY16_LO), uint5(SortKeys.KEY16_HI)).sub(uint5(SortKeys.KEY16_LO)).shiftRight(uint5(13));
    const q = select6(bits.equal(uint5(32)), f, select6(bits.equal(uint5(24)), f.shiftRight(uint5(7)), q16));
    return select6(f.lessThan(uint5(2139095040)), min3(mask.bitXor(q), validMax), mask);
  }
  // A key as the RGBA8 texel of a SortKeys.KEYS channel
  static pack(key) {
    return vec44(uvec42(key, key.shiftRight(uint5(8)), key.shiftRight(uint5(16)), key.shiftRight(uint5(24))).bitAnd(uvec42(255))).div(255);
  }
  static unpack(rgba) {
    const bytes2 = uvec42(floor2(rgba.mul(255).add(0.5))).toVar();
    return bytes2.x.bitOr(bytes2.y.shiftLeft(uint5(8))).bitOr(bytes2.z.shiftLeft(uint5(16))).bitOr(bytes2.w.shiftLeft(uint5(24)));
  }
};

// src/gpu/splatGenerator.ts
import * as THREE7 from "three";
var { uniform: uniform5 } = TSL;
function makeContext() {
  const values = {
    viewOrigin: new THREE7.Vector3(),
    viewForward: new THREE7.Vector3(0, 0, -1),
    objectToHead: new THREE7.Matrix4(),
    headToObject: new THREE7.Matrix4(),
    objectToWorld: new THREE7.Matrix4()
  };
  const nodes3 = {
    viewOrigin: uniform5(values.viewOrigin),
    viewForward: uniform5(values.viewForward),
    objectToHead: uniform5(values.objectToHead),
    headToObject: uniform5(values.headToObject),
    objectToWorld: uniform5(values.objectToWorld)
  };
  const set = (toWorld, toHead) => {
    values.objectToWorld.copy(toWorld);
    values.objectToHead.copy(toHead);
    values.headToObject.copy(toHead).invert();
    values.viewOrigin.setFromMatrixPosition(values.headToObject);
    values.viewForward.set(0, 0, -1).transformDirection(values.headToObject);
  };
  return { nodes: nodes3, values, set };
}
var generatorContext = makeContext();
var modifierContext = makeContext();
var SplatGenerator = {
  // The context nodes generators get, for code outside a generator call
  // (modifiers of fromSplats, tests)
  context: generatorContext.nodes,
  // A generator of stored splats of `layout`: splat i is the arrays' splat
  // remap(i) (entry i of an index list with "indices", or any TSL function
  // of the index; default i itself), its SH color added with `sh` (seen
  // from context.viewOrigin; GpuShReader), then each of `modifiers` in
  // turn. Its data is { splats, indices?, shPalette? }. Make it once: every
  // file of the layout and every index list then runs one program.
  fromSplats({ layout = "extSplats", remap, modifiers = [], sh } = {}) {
    const reader = GpuSplatReader.for(layout);
    const list = remap === "indices" ? new GpuArrayReader(ArrayData.INDICES) : void 0;
    const shReader = sh ? new GpuShReader(sh) : void 0;
    const at2 = (i) => list ? list.load("index", i) : typeof remap === "function" ? remap(i) : i;
    const bind = ({ splats, indices, shPalette }) => {
      reader.bind(splats);
      shReader?.bind(splats, shPalette);
      if (list) {
        if (!indices) {
          throw new Error('SplatGenerator.fromSplats: remap "indices" needs { splats, indices } as data');
        }
        list.bind(indices, "indices");
      }
    };
    const withSh = (load2) => (i, context = generatorContext.nodes) => {
      if (!shReader) {
        return load2(at2(i));
      }
      const stored = at2(i).toVar();
      return shReader.apply(load2(stored), stored, context.viewOrigin);
    };
    const loadSplat = withSh((i) => reader.loadSplat(i));
    if (modifiers.length === 0) {
      return { generateSplat: loadSplat, generateCovSplat: withSh((i) => reader.loadCovSplat(i)), bind };
    }
    return {
      generateSplat: (i, context = generatorContext.nodes) => modifiers.reduce((splat, modifier) => modifier(splat, context), loadSplat(i, context)),
      bind
    };
  },
  // The generator for `arrays` (and `shPalette`): fromSplats of their splat
  // layout, with the SH they hold (per splat, or a palette with shPalette),
  // shared by every set of arrays of the same kind. `sh` caps the degree (0
  // or false: none); modifiers make a generator of its own.
  forArrays(arrays, { remap, modifiers, sh, shPalette } = {}) {
    const layout = Splats.findBundle(arrays.bundles)?.layout;
    if (!layout) {
      throw new Error("SplatGenerator.forArrays: no splat bundle in these arrays");
    }
    const found = sh === false || sh === 0 ? void 0 : GpuShReader.find(arrays, shPalette);
    const shOptions = found && { codec: found.codec, degree: Math.min(sh || 4, found.degree), palette: found.palette };
    if (modifiers) {
      return SplatGenerator.fromSplats({ layout, remap, modifiers, sh: shOptions });
    }
    const key = `${layout}|${remap ?? ""}|${shOptions ? `${shOptions.codec}|${shOptions.degree}|${shOptions.palette}` : ""}`;
    let generator = shared.get(key);
    if (!generator) {
      generator = SplatGenerator.fromSplats({ layout, remap, sh: shOptions });
      shared.set(key, generator);
    }
    return generator;
  },
  // An index list as GpuArrays (bundle "indices" of ArrayData.INDICES),
  // uploaded into `into` when given (its count becomes the list's)
  indices(renderer, list, into) {
    const data = new ArrayData({ count: list.length }).addBundle("indices", ArrayData.INDICES);
    data.bundles.indices.channels.index.data.set(list);
    const arrays = into ?? new GpuArrays({ renderer, bundles: { indices: ArrayData.INDICES } });
    arrays.upload(data);
    return arrays;
  },
  // Sets the generator's context for an object placed by `objectToWorld`,
  // seen from `worldToHead`, and with `space` (a modifier's space: its
  // matrices to world and head) the modifier's (render/ calls this before
  // each object's dispatch)
  setContext(objectToWorld, worldToHead, space) {
    generatorContext.set(objectToWorld, scratch.multiplyMatrices(worldToHead, objectToWorld));
    if (space) {
      modifierContext.set(space.toWorld, space.toHead);
    }
  }
};
var shared = /* @__PURE__ */ new Map();
var scratch = new THREE7.Matrix4();

// src/gpu/splats.tsl.ts
var { Fn: Fn4, clamp: clamp4, exp: exp3, float: float6, floatBitsToUint: floatBitsToUint2, log, max: max6, min: min4, normalize: normalize4, select: select7, sign, sqrt, struct: struct2, uint: uint6, uintBitsToFloat: uintBitsToFloat2, uvec4: uvec43, vec3: vec35, vec4: vec45, abs: abs3 } = TSL;
var SplatStruct = struct2({
  center: "vec3",
  scales: "vec3",
  quaternion: "vec4",
  rgb: "vec3",
  opacity: "float",
  index: "uint"
}, "Splat");
var PbrStruct = struct2({
  normal: "vec3",
  roughness: "float",
  metallic: "float"
}, "SplatPbr");
var CovSplatStruct = struct2({
  center: "vec3",
  xxyyzz: "vec3",
  xyxzyz: "vec3",
  rgb: "vec3",
  opacity: "float",
  normal: "vec3",
  index: "uint"
}, "CovSplat");
var EncodedSplat = struct2({ a: "uvec4", b: "uvec4" }, "EncodedSplat");
var lnHalf2 = (v) => GpuEncoding.encodeHalf(log(v));
var expHalf2 = (h) => exp3(GpuEncoding.decodeHalf(h));
var decodeExt = Fn4(([a, b]) => {
  const s = SplatStruct().toVar();
  s.get("center").assign(uintBitsToFloat2(a.xyz));
  s.get("opacity").assign(GpuEncoding.decodeLodOpacity(a.w.shiftRight(uint6(24))));
  s.get("rgb").assign(GpuEncoding.decodeExtRgb(b.x));
  s.get("scales").assign(vec35(expHalf2(b.y), expHalf2(b.y.shiftRight(uint6(16))), expHalf2(b.z)));
  s.get("quaternion").assign(GpuEncoding.decodeQuatOct32(b.w));
  return s;
});
var decodeExtPbr = Fn4(([a, b]) => {
  const p = PbrStruct().toVar();
  p.get("normal").assign(GpuEncoding.decodeOct24(a.w.bitAnd(uint6(16777215))));
  p.get("roughness").assign(float6(b.z.shiftRight(uint6(16)).bitAnd(uint6(255))).div(255));
  p.get("metallic").assign(float6(b.z.shiftRight(uint6(24))).div(255));
  return p;
});
var encodeExt = Fn4(([s, p]) => {
  const scales = s.get("scales").toVar();
  const a = uvec43(
    floatBitsToUint2(s.get("center")),
    GpuEncoding.encodeOct24(p.get("normal")).bitOr(GpuEncoding.encodeLodOpacity(s.get("opacity")).shiftLeft(uint6(24)))
  );
  const b = uvec43(
    GpuEncoding.encodeExtRgb(s.get("rgb")),
    lnHalf2(scales.x).bitOr(lnHalf2(scales.y).shiftLeft(uint6(16))),
    lnHalf2(scales.z).bitOr(GpuEncoding.encodeUnorm8(p.get("roughness")).shiftLeft(uint6(16))).bitOr(GpuEncoding.encodeUnorm8(p.get("metallic")).shiftLeft(uint6(24))),
    GpuEncoding.encodeQuatOct32(s.get("quaternion"))
  );
  return EncodedSplat(a, b);
});
var encodeCorrelation2 = Fn4(([value, a, b]) => {
  const c = clamp4(value.div(sqrt(a.mul(b))), -1, 1).toVar();
  return select7(c.equal(0), float6(0), sign(c).mul(clamp4(log(abs3(c)), -100, -1e-7)));
});
var decodeCorrelation2 = (encoded) => select7(encoded.equal(0), float6(0), sign(encoded).negate().mul(exp3(abs3(encoded).negate())));
var decodeCov = Fn4(([a, b]) => {
  const c = CovSplatStruct().toVar();
  c.get("center").assign(uintBitsToFloat2(a.xyz));
  c.get("normal").assign(GpuEncoding.decodeOct24(a.w.bitAnd(uint6(16777215))));
  c.get("opacity").assign(GpuEncoding.decodeLodOpacity(a.w.shiftRight(uint6(24))));
  c.get("rgb").assign(GpuEncoding.decodeExtRgb(b.x));
  const d = vec35(expHalf2(b.y), expHalf2(b.y.shiftRight(uint6(16))), expHalf2(b.z)).toVar();
  c.get("xxyyzz").assign(d);
  const correlations = vec35(
    decodeCorrelation2(GpuEncoding.decodeHalf(b.z.shiftRight(uint6(16)))),
    decodeCorrelation2(GpuEncoding.decodeHalf(b.w)),
    decodeCorrelation2(GpuEncoding.decodeHalf(b.w.shiftRight(uint6(16))))
  );
  c.get("xyxzyz").assign(correlations.mul(sqrt(vec35(d.x.mul(d.y), d.x.mul(d.z), d.y.mul(d.z)))));
  return c;
});
var encodeCov = Fn4(([c]) => {
  const d = c.get("xxyyzz").toVar();
  const o = c.get("xyxzyz").toVar();
  const a = uvec43(
    floatBitsToUint2(c.get("center")),
    GpuEncoding.encodeOct24(c.get("normal")).bitOr(GpuEncoding.encodeLodOpacity(c.get("opacity")).shiftLeft(uint6(24)))
  );
  const b = uvec43(
    GpuEncoding.encodeExtRgb(c.get("rgb")),
    lnHalf2(d.x).bitOr(lnHalf2(d.y).shiftLeft(uint6(16))),
    lnHalf2(d.z).bitOr(GpuEncoding.encodeHalf(encodeCorrelation2(o.x, d.x, d.y)).shiftLeft(uint6(16))),
    GpuEncoding.encodeHalf(encodeCorrelation2(o.y, d.x, d.z)).bitOr(GpuEncoding.encodeHalf(encodeCorrelation2(o.z, d.y, d.z)).shiftLeft(uint6(16)))
  );
  return EncodedSplat(a, b);
});
var decodePacked = Fn4(([p, encoding]) => {
  const s = SplatStruct().toVar();
  const byte = (word, shift) => float6(word.shiftRight(uint6(shift)).bitAnd(uint6(255)));
  const color = (v) => encoding.x.add(v.div(255).mul(encoding.y.sub(encoding.x)));
  s.get("rgb").assign(vec35(color(byte(p.x, 0)), color(byte(p.x, 8)), color(byte(p.x, 16))));
  s.get("opacity").assign(byte(p.x, 24).div(255));
  s.get("center").assign(vec35(GpuEncoding.decodeHalf(p.y), GpuEncoding.decodeHalf(p.y.shiftRight(uint6(16))), GpuEncoding.decodeHalf(p.z)));
  const step = encoding.w.sub(encoding.z).div(254).toVar();
  const scale = (code) => select7(code.equal(0), float6(0), exp3(encoding.z.add(code.sub(1).mul(step))));
  s.get("scales").assign(vec35(scale(byte(p.w, 0)), scale(byte(p.w, 8)), scale(byte(p.w, 16))));
  s.get("quaternion").assign(GpuEncoding.decodeQuatOct24(p.z.shiftRight(uint6(16)).bitOr(p.w.shiftRight(uint6(24)).shiftLeft(uint6(16)))));
  return s;
});
var encodePacked = Fn4(([s, encoding]) => {
  const rgb2 = s.get("rgb").sub(encoding.x).div(encoding.y.sub(encoding.x)).toVar();
  const x = GpuEncoding.encodeUnorm8(rgb2.x).bitOr(GpuEncoding.encodeUnorm8(rgb2.y).shiftLeft(uint6(8))).bitOr(GpuEncoding.encodeUnorm8(rgb2.z).shiftLeft(uint6(16))).bitOr(GpuEncoding.encodeUnorm8(s.get("opacity")).shiftLeft(uint6(24)));
  const step = encoding.w.sub(encoding.z).div(254).toVar();
  const scale = (v) => select7(v.lessThanEqual(0), uint6(0), uint6(clamp4(roundHalfUp(log(v).sub(encoding.z).div(step)).add(1), 1, 255)));
  const scales = s.get("scales").toVar();
  const center = s.get("center").toVar();
  const quat = GpuEncoding.encodeQuatOct24(s.get("quaternion")).toVar();
  return uvec43(
    x,
    GpuEncoding.encodeHalf(center.x).bitOr(GpuEncoding.encodeHalf(center.y).shiftLeft(uint6(16))),
    GpuEncoding.encodeHalf(center.z).bitOr(quat.bitAnd(uint6(65535)).shiftLeft(uint6(16))),
    scale(scales.x).bitOr(scale(scales.y).shiftLeft(uint6(8))).bitOr(scale(scales.z).shiftLeft(uint6(16))).bitOr(quat.shiftRight(uint6(16)).shiftLeft(uint6(24)))
  );
});
var toCov = Fn4(([s]) => {
  const c = CovSplatStruct().toVar();
  c.get("center").assign(s.get("center"));
  c.get("rgb").assign(s.get("rgb"));
  c.get("opacity").assign(s.get("opacity"));
  c.get("normal").assign(vec35(0));
  c.get("index").assign(s.get("index"));
  const cov = GpuSplatMath.covFromScaleQuat(s.get("scales"), s.get("quaternion")).toVar();
  c.get("xxyyzz").assign(vec35(cov.element(0).x, cov.element(1).y, cov.element(2).z));
  c.get("xyxzyz").assign(vec35(cov.element(0).y, cov.element(0).z, cov.element(1).z));
  return c;
});
var fromCov = Fn4(([c]) => {
  const s = SplatStruct().toVar();
  s.get("center").assign(c.get("center"));
  s.get("rgb").assign(c.get("rgb"));
  s.get("opacity").assign(c.get("opacity"));
  s.get("index").assign(c.get("index"));
  const eigens = GpuSplatMath.symEigens(c.get("xxyyzz"), c.get("xyxzyz")).toVar();
  s.get("scales").assign(sqrt(max6(eigens.get("values"), vec35(0))));
  s.get("quaternion").assign(GpuSplatMath.basisToQuat(eigens.get("basis")));
  return s;
});
var encodingVec4 = (encoding) => encoding.isNode ? encoding : vec45(encoding.rgbMin, encoding.rgbMax, encoding.lnScaleMin, encoding.lnScaleMax);
var GpuSplats = class _GpuSplats {
  // Struct constructors: GpuSplats.Splat(center, scales, quaternion, rgb,
  // opacity, index?), GpuSplats.CovSplat(center, xxyyzz, xyxzyz, rgb,
  // opacity, normal, index?); fields left out are zero
  static Splat = SplatStruct;
  static CovSplat = CovSplatStruct;
  static Pbr = PbrStruct;
  static decodeExt(a, b) {
    return decodeExt(a, b);
  }
  static decodeExtPbr(a, b) {
    return decodeExtPbr(a, b);
  }
  // The words { a, b } (a struct) of a splat and its PBR fields
  static encodeExt(s, p) {
    return encodeExt(s, p);
  }
  static decodeCov(a, b) {
    return decodeCov(a, b);
  }
  static encodeCov(c) {
    return encodeCov(c);
  }
  // `encoding`: a PackedEncoding or a vec4 node (GpuPackedSplatReader.encoding)
  static decodePacked(p, encoding = Splats.DEFAULT_PACKED_ENCODING) {
    return decodePacked(p, encodingVec4(encoding));
  }
  static encodePacked(s, encoding = Splats.DEFAULT_PACKED_ENCODING) {
    return encodePacked(s, encodingVec4(encoding));
  }
  // Without pbr: no normal, roughness 0, metallic 0
  static storeExt(out, s, pbr) {
    const encoded = encodeExt(s, pbr ?? PbrStruct(vec35(0), float6(0), float6(0))).toVar();
    out.extA.assign(encoded.get("a"));
    out.extB.assign(encoded.get("b"));
  }
  static storeCov(out, c) {
    const encoded = encodeCov(c).toVar();
    out.covA.assign(encoded.get("a"));
    out.covB.assign(encoded.get("b"));
  }
  static storePacked(out, s, encoding = Splats.DEFAULT_PACKED_ENCODING) {
    out.packed.assign(encodePacked(s, encodingVec4(encoding)));
  }
  // The covariance of a splat; the normal is zero
  static toCov(s) {
    return toCov(s);
  }
  // Diagonalizes the covariance (a Jacobi eigen decomposition)
  static fromCov(c) {
    return fromCov(c);
  }
  // A generator's splat i in the 3DGS form, converted when it only has
  // covariances (context: default the generator context Radix sets)
  static splatOf(generator, index, context = generatorContext.nodes) {
    return generator.generateSplat ? generator.generateSplat(index, context) : _GpuSplats.fromCov(generator.generateCovSplat(index, context));
  }
  // A generator's splat i as a covariance, converted when it only has 3DGS splats
  static covSplatOf(generator, index, context = generatorContext.nodes) {
    return generator.generateCovSplat ? generator.generateCovSplat(index, context) : _GpuSplats.toCov(generator.generateSplat(index, context));
  }
  // `node` (a splat struct) with its index field set
  static withIndex(node, index) {
    const v = node.toVar();
    v.get("index").assign(uint6(index));
    return v;
  }
  // The unit axis of the smallest scale (a flat splat's normal), rotated
  static normalOf(s) {
    const scales = s.get("scales").toVar();
    const axis = select7(scales.x.lessThanEqual(min4(scales.y, scales.z)), vec35(1, 0, 0), select7(scales.y.lessThanEqual(scales.z), vec35(0, 1, 0), vec35(0, 0, 1)));
    return GpuSplatMath.quatRotate(normalize4(s.get("quaternion")), axis);
  }
};

// src/gpu/splatAccess.ts
var { float: float7, uint: uint7, uintBitsToFloat: uintBitsToFloat3, uniform: uniform6, vec3: vec36, vec4: vec46 } = TSL;
function splatBundleName(arrays, layout, name) {
  const bundles = arrays.bundles;
  const match = (name !== void 0 ? [name] : [layout, ...Object.keys(bundles)]).find((n) => bundles[n] && Splats.layoutOf(bundles[n]) === layout);
  if (match === void 0) {
    throw new Error(name !== void 0 ? `Bundle ${name} is not ${layout}` : `No ${layout} bundle in these arrays`);
  }
  return match;
}
var GpuSplatReader = class _GpuSplatReader extends GpuArrayReader {
  static for(layout) {
    return layout === "extSplats" ? new GpuExtSplatReader() : layout === "covSplats" ? new GpuCovSplatReader() : new GpuPackedSplatReader();
  }
  // The reader of the splat bundle of `arrays` (`name`, else the standard
  // names, else any splat layout), bound to it; `reader.layout` narrows it
  static from(arrays, name) {
    const found = Splats.findBundle(arrays.bundles, name);
    if (!found) {
      throw new Error(name !== void 0 ? `Bundle ${name} is not a splat bundle` : "No extSplats, covSplats or packedSplats bundle in these arrays");
    }
    return _GpuSplatReader.for(found.layout).bind(arrays, found.name);
  }
  bind(arrays, name) {
    return super.bind(arrays, arrays && splatBundleName(arrays, this.layout, name));
  }
};
var GpuExtSplatReader = class extends GpuSplatReader {
  layout = "extSplats";
  constructor() {
    super(Splats.EXT);
  }
  loadSplat(index) {
    return GpuSplats.withIndex(GpuSplats.decodeExt(this.load("extA", index), this.load("extB", index)), index);
  }
  loadCovSplat(index) {
    return GpuSplats.toCov(this.loadSplat(index));
  }
  loadPbr(index) {
    return GpuSplats.decodeExtPbr(this.load("extA", index), this.load("extB", index));
  }
  loadCenter(index) {
    return uintBitsToFloat3(this.load("extA", index).xyz);
  }
  loadRgb(index) {
    return GpuEncoding.decodeExtRgb(this.load("extB", index).x);
  }
  loadOpacity(index) {
    return GpuEncoding.decodeLodOpacity(this.load("extA", index).w.shiftRight(uint7(24)));
  }
};
var GpuCovSplatReader = class extends GpuSplatReader {
  layout = "covSplats";
  constructor() {
    super(Splats.COV);
  }
  // Diagonalized (a Jacobi eigen decomposition per call)
  loadSplat(index) {
    return GpuSplats.fromCov(this.loadCovSplat(index));
  }
  loadCovSplat(index) {
    return GpuSplats.withIndex(GpuSplats.decodeCov(this.load("covA", index), this.load("covB", index)), index);
  }
  loadCenter(index) {
    return uintBitsToFloat3(this.load("covA", index).xyz);
  }
  loadRgb(index) {
    return GpuEncoding.decodeExtRgb(this.load("covB", index).x);
  }
  loadOpacity(index) {
    return GpuEncoding.decodeLodOpacity(this.load("covA", index).w.shiftRight(uint7(24)));
  }
};
var GpuPackedSplatReader = class extends GpuSplatReader {
  layout = "packedSplats";
  // vec4(rgbMin, rgbMax, lnScaleMin, lnScaleMax), set by bind from the
  // bundle's meta.encoding
  encoding;
  constructor() {
    super(Splats.PACKED);
    const { rgbMin, rgbMax, lnScaleMin, lnScaleMax } = Splats.DEFAULT_PACKED_ENCODING;
    this.encoding = uniform6(vec46(rgbMin, rgbMax, lnScaleMin, lnScaleMax));
  }
  bind(arrays, name) {
    const bundle = arrays && splatBundleName(arrays, this.layout, name);
    super.bind(arrays, bundle);
    const { rgbMin, rgbMax, lnScaleMin, lnScaleMax } = arrays && bundle ? Splats.packedEncodingOf(arrays.bundle(bundle)) : Splats.DEFAULT_PACKED_ENCODING;
    this.encoding.value.set(rgbMin, rgbMax, lnScaleMin, lnScaleMax);
    return this;
  }
  loadSplat(index) {
    return GpuSplats.withIndex(GpuSplats.decodePacked(this.load("packed", index), this.encoding), index);
  }
  loadCovSplat(index) {
    return GpuSplats.toCov(this.loadSplat(index));
  }
  loadCenter(index) {
    const p = this.load("packed", index).toVar();
    return vec36(GpuEncoding.decodeHalf(p.y), GpuEncoding.decodeHalf(p.y.shiftRight(uint7(16))), GpuEncoding.decodeHalf(p.z));
  }
  loadRgb(index) {
    return this.loadSplat(index).get("rgb");
  }
  loadOpacity(index) {
    return float7(this.load("packed", index).x.shiftRight(uint7(24))).div(255);
  }
};

// src/render/SplatCollection.ts
import * as THREE8 from "three";
var IDENTITY = new THREE8.Matrix4();
var LOCKED = ["generator", "data", "count"];
var SplatCollection = class _SplatCollection {
  static EMPTY = new _SplatCollection([]);
  objects;
  // Splats in all
  count;
  constructor(objects) {
    let offset = 0;
    this.objects = Object.freeze(objects.map((object) => {
      for (const key of LOCKED) {
        Object.defineProperty(object, key, { value: object[key], writable: false, configurable: false, enumerable: true });
      }
      const mapped = Object.freeze({ object, offset });
      offset += object.count;
      return mapped;
    }));
    this.count = offset;
  }
  // An object whose data is checked against its generator's
  static object(object) {
    return object;
  }
  // An object for splat arrays (all of them unless `count` says
  // otherwise), drawn with the spherical harmonics they hold (per splat, or
  // through `shPalette`; `sh` caps the degree, 0 or false: none): one shared
  // generator per kind (SplatGenerator.forArrays), so arrays of the same
  // kind run one program
  static arrays(arrays, { sh, shPalette, ...object } = {}) {
    if (!Splats.findBundle(arrays.bundles)) {
      throw new Error("SplatCollection.arrays: no splat bundle in these arrays");
    }
    const generator = SplatGenerator.forArrays(arrays, { sh, shPalette });
    return { count: arrays.count, ...object, generator, data: { splats: arrays, shPalette } };
  }
  // An object's world transform this render, or the identity
  static matrixWorldOf(object) {
    return (typeof object.matrixWorld === "function" ? object.matrixWorld() : object.matrixWorld) ?? IDENTITY;
  }
};

// src/wgpu/WgpuArrayStore.ts
var { int: int6, storageTexture, textureStore, uint: uint8, uniform: uniform7, uvec2: uvec22 } = TSL;
var WgpuArrayStore = class {
  def;
  // log2 and mask of the bound layout's height
  yBits;
  yMask;
  channels = {};
  constructor(def) {
    this.def = def;
    this.yBits = uniform7(0, "uint");
    this.yMask = uniform7(0, "uint");
    for (const [label, format] of Object.entries(def.channels)) {
      const { scalar, components } = ArrayFormats.info(format);
      const texelFormat = ArrayFormats.make(scalar, components * def.packing);
      if (!gpuFormatInfo(texelFormat).storable) {
        throw new Error(`Channel ${label}: ${texelFormat} cannot be a storage texture`);
      }
      this.channels[label] = { format, texelFormat, node: storageTexture(placeholder2(texelFormat)) };
    }
  }
  // Store into bundle `name` of `arrays` from now on; bind again after the
  // arrays are resized or swapped
  bind(arrays, name) {
    const target = arrays.bundle(name);
    if (target.def.packing !== this.def.packing) {
      throw new Error(`Bundle ${name} has packing ${target.def.packing}, the store ${this.def.packing}`);
    }
    for (const [label, channel] of Object.entries(this.channels)) {
      const texture = target.channels[label];
      if (texture?.format !== channel.format) {
        throw new Error(`Channel ${name}.${label} missing or not ${channel.format}`);
      }
      if (!texture.storage) {
        throw new Error(`Channel ${name}.${label} is not a storage texture (GpuArrays with storage: true)`);
      }
      channel.node.value = texture.texture;
    }
    this.yBits.value = target.layout.yBits;
    this.yMask.value = target.layout.height - 1;
    return this;
  }
  // Store element `index` (uint) of an unpacked bundle
  store(channel, index, value) {
    if (this.def.packing !== 1) {
      throw new Error("store() writes unpacked bundles; use storeTexel() for whole packed texels");
    }
    this.storeTexel(channel, index, value);
  }
  // Store a whole texel (uint): `packing` elements of a packed bundle,
  // valued by the texel format (packing 2 of "uint32x2" is a uvec4)
  storeTexel(channel, texel, value) {
    const entry = this.channels[channel];
    if (!entry) {
      throw new Error(`Channel ${channel} not in the store's bundle`);
    }
    const { x, y, layer } = texelCoord(uint8(texel), this.yBits, this.yMask);
    textureStore(entry.node.depth(int6(layer)), uvec22(x, y), widen(entry.texelFormat, value));
  }
};
var placeholders2 = /* @__PURE__ */ new Map();
function placeholder2(texelFormat) {
  let texture = placeholders2.get(texelFormat);
  if (!texture) {
    texture = makeArrayTexture(`radix_storePlaceholder_${texelFormat}`, texelFormat, TextureLayout.for(1));
    Object.assign(texture, { isStorageTexture: true, isArrayTexture: true });
    placeholders2.set(texelFormat, texture);
  }
  return texture;
}

// src/wgpu/workgroupScan.ts
var { If: If5, Loop: Loop2, invocationSubgroupIndex, select: select8, subgroupAdd, subgroupExclusiveAdd, subgroupIndex, subgroupSize, uint: uint9, workgroupBarrier } = TSL;
var SCAN_WORKGROUP = 256;
function scanTier(renderer, tier = "auto") {
  const subgroups = getGpuCaps(renderer).subgroups;
  if (tier === "subgroup" && !subgroups) {
    throw new Error("Subgroups are not supported on this device");
  }
  return tier === "auto" ? subgroups ? "subgroup" : "portable" : tier;
}
function threadRank(tier, localId2) {
  return tier === "subgroup" ? subgroupIndex.mul(subgroupSize).add(invocationSubgroupIndex).toVar() : localId2.x.toVar();
}
function workgroupExclusiveScan(tier, scratch5, rank, value) {
  if (tier === "subgroup") {
    const inTile = subgroupExclusiveAdd(value).toVar();
    const tileSum = subgroupAdd(value).toVar();
    If5(invocationSubgroupIndex.equal(uint9(0)), () => {
      scratch5.element(subgroupIndex).assign(tileSum);
    });
    workgroupBarrier();
    const before = uint9(0).toVar();
    const total2 = uint9(0).toVar();
    Loop2({ start: uint9(0), end: uint9(SCAN_WORKGROUP).div(subgroupSize), type: "uint", condition: "<" }, ({ i }) => {
      const sum = scratch5.element(i).toVar();
      before.addAssign(select8(i.lessThan(subgroupIndex), sum, uint9(0)));
      total2.addAssign(sum);
    });
    workgroupBarrier();
    return { exclusive: before.add(inTile), total: total2 };
  }
  scratch5.element(rank).assign(value);
  workgroupBarrier();
  for (let stride = 1; stride < SCAN_WORKGROUP; stride <<= 1) {
    const partner = select8(rank.greaterThanEqual(uint9(stride)), scratch5.element(rank.sub(uint9(stride))), uint9(0)).toVar();
    workgroupBarrier();
    scratch5.element(rank).addAssign(partner);
    workgroupBarrier();
  }
  const inclusive = scratch5.element(rank).toVar();
  const total = scratch5.element(uint9(SCAN_WORKGROUP - 1)).toVar();
  workgroupBarrier();
  return { exclusive: inclusive.sub(value), total };
}

// src/wgpu/WgpuCompute.ts
var { Fn: Fn5, globalId, instanceIndex, localId, numWorkgroups, workgroupId } = TSL;
function requireWebGPU(renderer, what) {
  if (!isWebGPUBackend(renderer)) {
    throw new Error(`${what} needs the WebGPU backend`);
  }
}
var WgpuCompute = class {
  // Workgroup-wide scans for kernel bodies (workgroupScan.ts): threads per
  // scan workgroup, the tier a device supports ("subgroup" or "portable"),
  // each thread's rank in scan order, and an exclusive prefix sum of one
  // uint per thread plus the total
  static SCAN_WORKGROUP = SCAN_WORKGROUP;
  static scanTier = scanTier;
  static threadRank = threadRank;
  static workgroupExclusiveScan = workgroupExclusiveScan;
  workgroupSize;
  computeNode;
  constructor({ workgroupSize = [64], body, label }) {
    this.workgroupSize = [workgroupSize[0], workgroupSize[1] ?? 1, workgroupSize[2] ?? 1];
    this.computeNode = Fn5(() => {
      body({ globalId, localId, workgroupId, numWorkgroups, index: instanceIndex });
    })().compute([1, 1, 1], this.workgroupSize);
    if (label) {
      this.computeNode.name = label;
    }
  }
  // A number is a thread count (three divides by the workgroup size); an
  // array is the workgroup count per dimension
  dispatch(renderer, size) {
    requireWebGPU(renderer, "WgpuCompute");
    if (typeof size === "number") {
      if (size > 0) {
        renderer.compute(this.computeNode, size);
      }
    } else {
      renderer.compute(this.computeNode, dispatchArgument(size));
    }
  }
  // The compute node with its dispatch size set, for WgpuComputeBatch
  prepare(size) {
    this.computeNode.dispatchSize = typeof size === "number" ? size : dispatchArgument(size);
    return this.computeNode;
  }
  dispose() {
    this.computeNode.dispose?.();
  }
};
function dispatchArgument(size) {
  return Array.isArray(size) ? [size[0], size[1] ?? 1, size[2] ?? 1] : size;
}
var WgpuComputeBatch = class {
  renderer;
  queue = [];
  constructor(renderer) {
    requireWebGPU(renderer, "WgpuComputeBatch");
    this.renderer = renderer;
  }
  add(kernel, size) {
    const empty = typeof size === "number" ? size <= 0 : Array.isArray(size) && size[0] <= 0;
    if (!empty) {
      this.queue.push({ kernel, size });
    }
    return this;
  }
  submit({ split = false } = {}) {
    const { renderer, queue } = this;
    this.queue = [];
    if (split) {
      for (const { kernel, size } of queue) {
        kernel.dispatch(renderer, size);
      }
      return;
    }
    let pass = [];
    const sizes = /* @__PURE__ */ new Map();
    const flush = () => {
      if (pass.length > 0) {
        renderer.compute(pass.map(({ kernel, size }) => kernel.prepare(size)));
      }
      pass = [];
      sizes.clear();
    };
    for (const entry of queue) {
      const key = String(entry.size);
      const previous = sizes.get(entry.kernel);
      if (previous !== void 0 && previous !== key) {
        flush();
      }
      sizes.set(entry.kernel, key);
      pass.push(entry);
    }
    flush();
  }
};

// src/wgpu/WgpuArrayWriter.ts
var { If: If6, uint: uint10, uniform: uniform8 } = TSL;
var MAX_COMPUTE_WRITER_CHANNELS = 4;
var WgpuArrayWriter = class {
  // Output channels one compute writer may have
  static MAX_CHANNELS = MAX_COMPUTE_WRITER_CHANNELS;
  outputs;
  packing;
  channels;
  storage = true;
  run = runComputeWriters;
  kernel;
  stores = {};
  range = { start: uniform8(0, "uint"), count: uniform8(0, "uint"), first: uniform8(0, "uint") };
  constructor({ outputs, write, workgroupSize = 64, label }) {
    this.outputs = outputs;
    const { channels, packing } = writerChannels(outputs);
    this.channels = channels;
    this.packing = packing;
    for (const { bundle, channel, texelFormat } of channels) {
      if (!gpuFormatInfo(texelFormat).storable) {
        throw new Error(`Writer output ${bundle}.${channel}: ${texelFormat} cannot be a storage texture`);
      }
    }
    if (channels.length > MAX_COMPUTE_WRITER_CHANNELS) {
      throw new Error(`Compute writer writes ${channels.length} channels (at most ${MAX_COMPUTE_WRITER_CHANNELS})`);
    }
    for (const [bundle, def] of Object.entries(outputs)) {
      this.stores[bundle] = new WgpuArrayStore(def);
    }
    const { start, count, first } = this.range;
    this.kernel = new WgpuCompute({
      workgroupSize: [workgroupSize],
      label: label ?? `radix_write_${channels.map(({ bundle, channel }) => `${bundle}_${channel}`).join("_")}`,
      body: ({ index }) => {
        If6(index.lessThan(count), () => {
          const { out, vars } = writerVars(channels);
          write(index.mul(uint10(packing)).add(first), out);
          const texel = index.add(start).toVar();
          channels.forEach(({ bundle, channel }, i) => this.stores[bundle].storeTexel(channel, texel, vars[i]));
        });
      }
    });
  }
  // Point the stores at `arrays` and set the range of one dispatch
  prepare(arrays, start, end, first) {
    for (const [bundle, store] of Object.entries(this.stores)) {
      store.bind(arrays, bundle);
    }
    this.range.start.value = start;
    this.range.count.value = end - start;
    this.range.first.value = first;
  }
  dispose() {
    this.kernel.dispose();
  }
};
function runComputeWriters(arrays, items) {
  requireWebGPU(arrays.renderer, "WgpuArrayWriter");
  for (const item of items) {
    if (item.count <= 0) {
      continue;
    }
    const writer = item.writer;
    const { start, end } = writeItemTexels(arrays, item);
    writer.prepare(arrays, start, end, item.first ?? 0);
    writer.kernel.dispatch(arrays.renderer, end - start);
  }
  countWrites(arrays, items);
}

// src/render/splatCamera.ts
import * as THREE9 from "three";

// src/render/viewIndex.ts
import { Node as Node2 } from "three/webgpu";
var ViewIndexNode = class extends Node2 {
  constructor() {
    super("uint");
  }
  generate(builder) {
    const b = builder;
    if (b.camera?.isMultiViewCamera) {
      return b.renderer.backend.isWebGPUBackend ? b.getBuiltin("view_index", "viewIndex", "u32", "attribute") : "gl_ViewID_OVR";
    }
    return TSL.cameraIndex.build(builder, "uint");
  }
};
var splatViewIndex = TSL.nodeObject(new ViewIndexNode());

// src/render/splatCamera.ts
var { uint: uint11, uniform: uniform9, uniformArray } = TSL;
var MAX_EYES = 2;
var nodes = {
  fromHeads: uniformArray(Array.from({ length: MAX_EYES }, () => new THREE9.Matrix4())),
  fromHeadQuats: uniformArray(Array.from({ length: MAX_EYES }, () => new THREE9.Vector4(0, 0, 0, 1))),
  projections: uniformArray(Array.from({ length: MAX_EYES }, () => new THREE9.Matrix4())),
  orthos: uniformArray(new Array(MAX_EYES).fill(0), "uint"),
  renderSize: uniform9(new THREE9.Vector2(1, 1)),
  // NDC depth of the near plane: -1 (WebGL clip convention) or 0 (WebGPU)
  ndcZMin: uniform9(0)
};
var TO_WEBGPU = new THREE9.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
var TO_WEBGL = TO_WEBGPU.clone().invert();
var SplatCamera = class _SplatCamera {
  // In a draw's shaders, the index (uint) of the eye being drawn: one draw
  // per eye of an ArrayCamera, or both in one with multiview
  static viewIndex = splatViewIndex;
  // Eyes of the latest set()
  static eyes = 1;
  // World to head of the latest set()
  static head = new THREE9.Matrix4();
  // Eye v (a number, or a TSL index such as SplatCamera.viewIndex)
  static eye(v) {
    const at2 = typeof v === "number" ? uint11(v) : v;
    return {
      fromHead: nodes.fromHeads.element(at2),
      fromHeadQuat: nodes.fromHeadQuats.element(at2),
      projection: nodes.projections.element(at2),
      isOrtho: nodes.orthos.element(at2).notEqual(uint11(0)),
      renderSize: nodes.renderSize,
      ndcZMin: nodes.ndcZMin
    };
  }
  // The camera of a render: `camera` as three passes it to onBeforeRender.
  // Eyes whose projection is in the other clip convention than the
  // renderer's (sub-cameras an app made for WebGL) are converted, not changed.
  static set(renderer, camera2) {
    const array = camera2;
    const cameras = array.isArrayCamera && array.cameras.length > 0 ? array.cameras : [camera2];
    const count = Math.min(cameras.length, MAX_EYES);
    camera2.updateMatrixWorld();
    const size = scratch2.size;
    const viewport = cameras[0].viewport;
    const target = renderer.getRenderTarget();
    if (viewport && array.isArrayCamera) {
      size.set(viewport.z, viewport.w);
    } else if (target) {
      size.set(target.width, target.height);
    } else {
      renderer.getDrawingBufferSize(size);
      const canvas = renderer.getViewport(scratch2.viewport);
      const full = renderer.getSize(scratch2.canvas);
      if (canvas.z !== full.x || canvas.w !== full.y) {
        const ratio = renderer.getPixelRatio();
        size.set(Math.floor(canvas.z * ratio), Math.floor(canvas.w * ratio));
      }
    }
    const webgpu = renderer.coordinateSystem === THREE9.WebGPUCoordinateSystem;
    scratch2.eyes.length = count;
    for (let v = 0; v < count; v += 1) {
      const eye = cameras[v];
      eye.updateMatrixWorld();
      scratch2.eyes[v] ??= { view: new THREE9.Matrix4(), projection: new THREE9.Matrix4() };
      const setting = scratch2.eyes[v];
      setting.view.copy(eye.matrixWorld).invert();
      const converted = !renderer.xr.isPresenting && eye.coordinateSystem !== renderer.coordinateSystem;
      setting.projection.copy(eye.projectionMatrix);
      if (converted) {
        setting.projection.premultiply(webgpu ? TO_WEBGPU : TO_WEBGL);
      }
      setting.ortho = eye.isOrthographicCamera === true;
    }
    _SplatCamera.setViews({ head: scratch2.head.copy(camera2.matrixWorld).invert(), eyes: scratch2.eyes, size, ndcZMin: webgpu ? 0 : -1 });
  }
  // The views directly: `head` and each eye's `view` map world to view
  static setViews({ head, eyes, size, ndcZMin }) {
    if (eyes.length < 1 || eyes.length > MAX_EYES) {
      throw new Error(`SplatCamera: 1 or ${MAX_EYES} eyes, not ${eyes.length}`);
    }
    _SplatCamera.eyes = eyes.length;
    _SplatCamera.head.copy(head);
    const headWorld = scratch2.headWorld.copy(head).invert();
    eyes.forEach(({ view, projection, ortho = false }, v) => {
      const fromHead = view.equals(head) ? scratch2.fromHead.identity() : scratch2.fromHead.multiplyMatrices(view, headWorld);
      nodes.fromHeads.array[v].copy(fromHead);
      fromHead.decompose(scratch2.position, scratch2.quaternion, scratch2.scale);
      const q = scratch2.quaternion;
      nodes.fromHeadQuats.array[v].set(q.x, q.y, q.z, q.w);
      nodes.projections.array[v].copy(projection);
      nodes.orthos.array[v] = ortho ? 1 : 0;
    });
    nodes.renderSize.value.copy(size);
    nodes.ndcZMin.value = ndcZMin;
  }
};
var scratch2 = {
  head: new THREE9.Matrix4(),
  headWorld: new THREE9.Matrix4(),
  size: new THREE9.Vector2(),
  viewport: new THREE9.Vector4(),
  canvas: new THREE9.Vector2(),
  eyes: [],
  fromHead: new THREE9.Matrix4(),
  position: new THREE9.Vector3(),
  quaternion: new THREE9.Quaternion(),
  scale: new THREE9.Vector3()
};

// src/render/splatParams.ts
var { uniform: uniform10 } = TSL;
var nodes2 = {
  minAlpha: uniform10(0.5 / 255),
  maxStdDev: uniform10(Math.sqrt(8)),
  falloff: uniform10(1),
  lodInflate: uniform10(true),
  blurAmount: uniform10(0.3),
  preBlurAmount: uniform10(0),
  clipXY: uniform10(1.4),
  minPixelRadius: uniform10(0),
  maxPixelRadius: uniform10(512),
  minContribution: uniform10(0),
  focalDistance: uniform10(0),
  apertureTan: uniform10(0),
  sortGuard: uniform10(0),
  maxShDegree: GpuSh.maxDegree
};
var SplatParams = class _SplatParams {
  static VIEW = { maxStdDev: Math.sqrt(8), minAlpha: 0.5 / 255, falloff: 1 };
  static OBJECT = {
    lodInflate: true,
    blurAmount: 0.3,
    preBlurAmount: 0,
    clipXY: 1.4,
    minPixelRadius: 0,
    maxPixelRadius: 512,
    minContribution: 0,
    focalDistance: 0,
    apertureTan: 0,
    sortGuard: 0,
    maxShDegree: 4
  };
  static nodes = nodes2;
  static setView(params) {
    nodes2.maxStdDev.value = params.maxStdDev;
    nodes2.minAlpha.value = params.minAlpha;
    nodes2.falloff.value = params.falloff;
  }
  // `params`, with `overrides` on top
  static setObject(params, overrides) {
    for (const key of Object.keys(_SplatParams.OBJECT)) {
      nodes2[key].value = overrides?.[key] ?? params[key];
    }
  }
};

// src/render/projection.tsl.ts
var { quatConj, quatMul: quatMul2, quatRotate: quatRotate2 } = GpuSplatMath;
var {
  Fn: Fn6,
  If: If7,
  abs: abs4,
  all,
  any,
  atan: atan2,
  bool,
  ceil: ceil2,
  clamp: clamp5,
  cos: cos3,
  cross: cross2,
  dot: dot2,
  exp: exp4,
  exp2: exp22,
  float: float8,
  floatBitsToUint: floatBitsToUint3,
  floor: floor3,
  length: length2,
  log2: log22,
  max: max7,
  min: min5,
  mix: mix3,
  normalize: normalize5,
  pow,
  select: select9,
  sin: sin3,
  sqrt: sqrt2,
  transpose: transpose2,
  uint: uint12,
  uintBitsToFloat: uintBitsToFloat4,
  uvec2: uvec23,
  vec2: vec22,
  vec3: vec37,
  vec4: vec47
} = TSL;
var E = Math.E;
var NDC_RANGE = 2;
var LOG_SCALE_MIN = -4;
var LOG_SCALE_MAX = 12;
function prepareSplat(source, form, params) {
  const splat = source.toVar();
  const opacity = splat.get("opacity").toVar();
  const inflate = float8(1).toVar();
  If7(opacity.greaterThan(1), () => {
    opacity.assign(min5(opacity.mul(4).sub(3), 5));
    If7(params.lodInflate, () => {
      inflate.assign(pow(exp4(opacity.mul(opacity).sub(1).div(E)), 1 / 3));
      opacity.assign(1);
    });
  });
  if (form === "cov") {
    splat.get("xxyyzz").mulAssign(inflate.mul(inflate));
    splat.get("xyxzyz").mulAssign(inflate.mul(inflate));
  } else {
    splat.get("scales").mulAssign(inflate);
  }
  const stdDev = select9(opacity.greaterThan(1), params.maxStdDev.add(opacity.sub(1).mul(0.7)), params.maxStdDev).toVar();
  return { form, splat, opacity, stdDev };
}
function cullInvisible({ form, splat, opacity }, params) {
  const degenerate = all(splat.get(form === "cov" ? "xxyyzz" : "scales").equal(vec37(0)));
  return opacity.lessThanEqual(0).or(opacity.lessThan(params.minAlpha)).or(degenerate);
}
var storedOpacity = (opacity) => select9(opacity.greaterThan(1), opacity.add(3).mul(0.25), opacity);
function eyeFrame(v) {
  const eye = SplatCamera.eye(v);
  return {
    matrix: eye.fromHead,
    quat: eye.fromHeadQuat,
    projection: eye.projection,
    isOrtho: eye.isOrtho,
    renderSize: eye.renderSize,
    ndcZMin: eye.ndcZMin
  };
}
function headFrame() {
  return { ...eyeFrame(0), matrix: void 0, quat: void 0 };
}
var frameQuat = (frame, q) => frame.quat ? quatMul2(frame.quat, normalize5(q)) : normalize5(q);
function splatInView(s, frame, params) {
  const splatCenter = s.splat.get("center");
  const center = (frame.matrix ? frame.matrix.mul(vec47(splatCenter, 1)).xyz : splatCenter).toVar();
  const clip = frame.projection.mul(vec47(center, 1)).toVar();
  const blur = params.blurAmount.toVar();
  If7(params.focalDistance.greaterThan(0).and(params.apertureTan.greaterThan(0)).and(center.z.lessThan(0)), () => {
    const depth = center.z.negate().toVar();
    const cocView = abs4(depth.sub(params.focalDistance)).mul(params.apertureTan);
    const focalPixels = frame.renderSize.y.mul(0.5).mul(frame.projection.element(1).y);
    const cocPixels = select9(frame.isOrtho, cocView.mul(focalPixels), cocView.mul(focalPixels).div(depth)).toVar();
    blur.assign(clamp5(cocPixels.mul(cocPixels), blur, params.maxPixelRadius.mul(params.maxPixelRadius)));
  });
  const ndc = select9(clip.w.greaterThan(0), clip.xy.div(clip.w), vec22(0)).toVar();
  return { frame, center, clip, ndc, blur };
}
function cullDepth({ center, clip, frame }) {
  return center.z.greaterThanEqual(0).or(clip.z.lessThan(frame.ndcZMin.mul(clip.w))).or(clip.z.greaterThanEqual(clip.w));
}
function cullClipXY({ clip }, params) {
  const limit = min5(params.clipXY, NDC_RANGE).mul(clip.w).toVar();
  return abs4(clip.x).greaterThan(limit).or(abs4(clip.y).greaterThan(limit));
}
function inSortGuard({ form, splat }, head, guard, params) {
  const s = splat;
  const extent = form === "cov" ? sqrt2(max7(max7(s.get("xxyyzz").x, s.get("xxyyzz").y), s.get("xxyyzz").z)) : max7(max7(s.get("scales").x, s.get("scales").y), s.get("scales").z);
  const radius = extent.mul(params.maxStdDev).toVar();
  const { center, clip, frame } = head;
  const w = max7(clip.w, 1e-6).toVar();
  const reach = vec22(frame.projection.element(0).x, frame.projection.element(1).y).mul(radius).div(w);
  const inside = all(abs4(clip.xy.div(w)).sub(reach).lessThanEqual(vec22(guard.add(1))));
  const near = center.z.negate().lessThanEqual(radius);
  return center.z.lessThan(radius).and(inside.or(near));
}
function viewCov(s, frame) {
  const cov = GpuSplatMath.covMatrix(s.splat.get("xxyyzz"), s.splat.get("xyxzyz"));
  if (!frame.matrix) {
    return cov;
  }
  const M = GpuSplatMath.mat3FromMat4(frame.matrix).toVar();
  return M.mul(cov).mul(transpose2(M));
}
function viewBasis(s, frame) {
  const quat = frameQuat(frame, s.splat.get("quaternion")).toVar();
  const scales = s.splat.get("scales").toVar();
  scales.assign(max7(scales, vec37(max7(scales.x, max7(scales.y, scales.z)).mul(1e-4))));
  return { quat, scales };
}
var detTimesMahalanobis = (l2, s2) => l2.x.mul(s2.y).mul(s2.z).add(l2.y.mul(s2.x).mul(s2.z)).add(l2.z.mul(s2.x).mul(s2.y));
function mipInflate(v, quat, scales, opacity, params) {
  const local = quatRotate2(quatConj(quat), v.center).toVar();
  const l2 = local.mul(local).toVar();
  const pixel = float8(2).div(v.frame.renderSize.y.mul(v.frame.projection.element(1).y)).toVar();
  const footprint = pixel.mul(pixel).mul(select9(v.frame.isOrtho, float8(1), dot2(v.center, v.center))).toVar();
  const s2 = scales.mul(scales).add(params.preBlurAmount.mul(footprint)).toVar();
  const s2Blur = s2.add(v.blur.mul(footprint)).toVar();
  const num = detTimesMahalanobis(l2, s2).toVar();
  const den = detTimesMahalanobis(l2, s2Blur).toVar();
  opacity.mulAssign(select9(den.greaterThan(0), sqrt2(max7(num.div(den), 0)), float8(1)));
  scales.assign(sqrt2(s2Blur));
}
var mahalanobis2 = (center, quat, scales) => {
  const local = quatRotate2(quatConj(quat), center).div(scales);
  return dot2(local, local);
};
var makeBound = () => ({ ndc: vec22(0).toVar(), angle: float8(0).toVar(), scales: vec22(0).toVar() });
var eigenvector2 = Fn6(([a, b, d, eig]) => {
  const v = select9(abs4(a.sub(eig)).greaterThanEqual(abs4(d.sub(eig))), vec22(b, eig.sub(a)), vec22(eig.sub(d), b)).toVar();
  const len = length2(v).toVar();
  return select9(len.greaterThan(0), v.div(len), vec22(1, 0));
});
function boundFromCov(a, b, d, stdDev, params, bound) {
  const det = a.mul(d).sub(b.mul(b));
  const half = a.sub(d).mul(0.5).toVar();
  const eigen1 = a.add(d).mul(0.5).add(sqrt2(half.mul(half).add(b.mul(b)))).toVar();
  const eigen2 = select9(eigen1.greaterThan(0), max7(det.div(eigen1), 0), float8(0));
  const scale1 = min5(params.maxPixelRadius, stdDev.mul(sqrt2(max7(eigen1, 0)))).toVar();
  const scale2 = min5(params.maxPixelRadius, stdDev.mul(sqrt2(eigen2))).toVar();
  const ok = scale1.greaterThanEqual(params.minPixelRadius).or(scale2.greaterThanEqual(params.minPixelRadius)).toVar();
  If7(ok, () => {
    const axis = eigenvector2(a, b, d, eigen1).toVar();
    const angle = atan2(axis.y, axis.x).toVar();
    bound.angle.assign(select9(angle.lessThan(0), angle.add(Math.PI), angle));
    bound.scales.assign(vec22(scale1, scale2));
  });
  return ok;
}
function screenBound(frame, params, bound) {
  bound.ndc.assign(vec22(0));
  bound.angle.assign(0);
  bound.scales.assign(vec22(min5(params.maxPixelRadius, length2(frame.renderSize).mul(0.5))));
}
function clipBoundToScreen(renderSize, bound) {
  const halfSize = renderSize.mul(0.5).toVar();
  const c = cos3(bound.angle).mul(bound.scales).toVar();
  const s = sin3(bound.angle).mul(bound.scales).toVar();
  const extent = vec22(length2(vec22(c.x, s.y)), length2(vec22(s.x, c.y))).toVar();
  const center = bound.ndc.mul(halfSize).toVar();
  const lo = center.sub(extent).toVar();
  const hi = center.add(extent).toVar();
  const ok = bool(true).toVar();
  If7(all(lo.greaterThanEqual(halfSize.negate())).and(all(hi.lessThanEqual(halfSize))).not(), () => {
    lo.assign(max7(lo, halfSize.negate()));
    hi.assign(min5(hi, halfSize));
    If7(any(lo.greaterThanEqual(hi)), () => {
      ok.assign(false);
    }).Else(() => {
      bound.ndc.assign(lo.add(hi).mul(0.5).div(halfSize));
      bound.angle.assign(0);
      bound.scales.assign(hi.sub(lo).mul(0.5));
    });
  });
  return ok;
}
var encodeFixed16 = (value) => uint12(clamp5(floor3(value.add(NDC_RANGE).div(2 * NDC_RANGE).mul(65535).add(0.5)), 0, 65535));
var decodeFixed16 = (code) => float8(code).div(65535).mul(2 * NDC_RANGE).sub(NDC_RANGE);
var encodeNdc = (ndc) => encodeFixed16(ndc.x).bitOr(encodeFixed16(ndc.y).shiftLeft(uint12(16)));
var decodeNdc = (word) => vec22(decodeFixed16(word.bitAnd(uint12(65535))), decodeFixed16(word.shiftRight(uint12(16))));
var DEPTH_LO = 113 << 23;
var encodeDepth20 = (viewZ) => {
  const f = clamp5(floatBitsToUint3(viewZ.negate()), uint12(DEPTH_LO), uint12((145 << 23) - 1));
  return min5(f.sub(uint12(DEPTH_LO)).add(uint12(128)).shiftRight(uint12(8)), uint12(1048575));
};
var decodeDepth20 = (code) => uintBitsToFloat4(code.shiftLeft(uint12(8)).add(uint12(DEPTH_LO))).negate();
var encodeAngle12 = (angle) => uint12(floor3(angle.div(Math.PI).mul(4096).add(0.5))).bitAnd(uint12(4095));
var decodeAngle12 = (code) => float8(code).div(4096).mul(Math.PI);
function encodeLogScale(scale, bits, outward = false) {
  const top = 2 ** bits - 2;
  const normalized = clamp5(log22(max7(scale, 1e-20)), LOG_SCALE_MIN, LOG_SCALE_MAX).sub(LOG_SCALE_MIN).div(LOG_SCALE_MAX - LOG_SCALE_MIN).mul(top);
  return uint12(clamp5(outward ? ceil2(normalized) : floor3(normalized.add(0.5)), 0, top)).add(uint12(1));
}
function decodeLogScale(code, bits) {
  return exp22(float8(code.sub(uint12(1))).div(2 ** bits - 2).mul(LOG_SCALE_MAX - LOG_SCALE_MIN).add(LOG_SCALE_MIN));
}
var encodeOpacity = (opacity) => max7(uint12(floor3(clamp5(opacity.mul(128), 0, 255).add(0.5))), uint12(1));
var decodeOpacity = (byte) => float8(byte).div(128);
function encodeCenter(center) {
  const distance = length2(center).toVar();
  const p = center.xy.div(max7(abs4(center.x).add(abs4(center.y)).add(abs4(center.z)), 1e-30)).toVar();
  const signs = vec22(select9(p.x.greaterThanEqual(0), float8(1), float8(-1)), select9(p.y.greaterThanEqual(0), float8(1), float8(-1)));
  If7(center.z.lessThan(0), () => {
    p.assign(vec22(float8(1).sub(abs4(p.y)), float8(1).sub(abs4(p.x))).mul(signs));
  });
  const q = uvec23(floor3(p.mul(0.5).add(0.5).mul(1048575).add(0.5))).toVar();
  const dir = q.x.shiftRight(uint12(4)).bitOr(q.y.shiftRight(uint12(4)).shiftLeft(uint12(16)));
  const low = q.x.bitAnd(uint12(15)).shiftLeft(uint12(24)).bitOr(q.y.shiftLeft(uint12(28)));
  return [dir, floatBitsToUint3(distance), low];
}
var decodeCenter = Fn6(([dir, distance, last]) => {
  const qx = dir.bitAnd(uint12(65535)).shiftLeft(uint12(4)).bitOr(last.shiftRight(uint12(24)).bitAnd(uint12(15)));
  const qy = dir.shiftRight(uint12(16)).shiftLeft(uint12(4)).bitOr(last.shiftRight(uint12(28)));
  const x = float8(qx).div(1048575).mul(2).sub(1).toVar();
  const y = float8(qy).div(1048575).mul(2).sub(1).toVar();
  const z = float8(1).sub(abs4(x)).sub(abs4(y)).toVar();
  const t = max7(z.negate(), 0).toVar();
  x.addAssign(select9(x.greaterThanEqual(0), t.negate(), t));
  y.addAssign(select9(y.greaterThanEqual(0), t.negate(), t));
  return normalize5(vec37(x, y, z)).mul(uintBitsToFloat4(distance));
});
var ANGLE_STEPS = 1024;
function encodeBound(bound) {
  const angleCode = uint12(floor3(bound.angle.div(Math.PI).mul(ANGLE_STEPS).add(0.5))).bitAnd(uint12(ANGLE_STEPS - 1));
  const slack = max7(bound.scales.x, bound.scales.y).mul(Math.sin(Math.PI / ANGLE_STEPS / 2) * 1.001).toVar();
  const scales = bound.scales.add(slack).toVar();
  return [encodeNdc(bound.ndc), angleCode.bitOr(encodeLogScale(scales.x, 11, true).shiftLeft(uint12(10))).bitOr(encodeLogScale(scales.y, 11, true).shiftLeft(uint12(21)))];
}
function decodeBound(w0, w1) {
  return {
    ndc: decodeNdc(w0),
    angle: float8(w1.bitAnd(uint12(ANGLE_STEPS - 1))).div(ANGLE_STEPS).mul(Math.PI),
    scales: vec22(decodeLogScale(w1.shiftRight(uint12(10)).bitAnd(uint12(2047)), 11), decodeLogScale(w1.shiftRight(uint12(21)), 11))
  };
}
var clipW = (viewZ, projection) => projection.element(2).w.mul(viewZ).add(projection.element(3).w);
var clipZ = (viewZ, projection) => projection.element(2).z.mul(viewZ).add(projection.element(3).z);
var unproject = Fn6(([ndc, viewZ, projection]) => {
  const w = clipW(viewZ, projection).toVar();
  return vec37(
    ndc.x.mul(w).sub(projection.element(2).x.mul(viewZ)).sub(projection.element(3).x).div(projection.element(0).x),
    ndc.y.mul(w).sub(projection.element(2).y.mul(viewZ)).sub(projection.element(3).y).div(projection.element(1).y),
    viewZ
  );
});
function boundCorner(bound, center, corner, projection, renderSize, out) {
  const axis1 = vec22(cos3(bound.angle), sin3(bound.angle)).toVar();
  const axis2 = vec22(axis1.y, axis1.x.negate());
  const pixelOffset = corner.x.mul(axis1).mul(bound.scales.x).add(corner.y.mul(axis2).mul(bound.scales.y));
  const ndc = bound.ndc.add(vec22(2).div(renderSize).mul(pixelOffset)).toVar();
  const w = clipW(center.z, projection).toVar();
  out.get("position").assign(vec47(ndc.mul(w), clipZ(center.z, projection), w));
  return ndc;
}
function rayVertex(bound, center, quat, scales, cornerIn, shrink, projection, isOrtho, renderSize, out) {
  const axis1 = vec22(cos3(bound.angle), sin3(bound.angle)).toVar();
  const axis2 = vec22(axis1.y, axis1.x.negate()).toVar();
  const halfSize = renderSize.mul(0.5).toVar();
  const extent = vec22(length2(vec22(axis1.x.mul(bound.scales.x), axis2.x.mul(bound.scales.y))), length2(vec22(axis1.y.mul(bound.scales.x), axis2.y.mul(bound.scales.y)))).toVar();
  const onScreen = all(abs4(bound.ndc.mul(halfSize)).add(extent).lessThan(halfSize));
  const corner = select9(onScreen, cornerIn.mul(shrink), cornerIn).toVar();
  const ndc = boundCorner(bound, center, corner, projection, renderSize, out);
  const viewPos = unproject(ndc, center.z, projection).toVar();
  const origin = select9(isOrtho, vec37(viewPos.xy, 0), vec37(0)).toVar();
  const dir = select9(isOrtho, vec37(0, 0, -1), viewPos).toVar();
  const conj = quatConj(quat).toVar();
  const localOrigin = quatRotate2(conj, origin.sub(center)).div(scales).toVar();
  const localDir = quatRotate2(conj, dir).div(scales).toVar();
  out.get("localDir").assign(localDir);
  out.get("localCross").assign(cross2(localOrigin, localDir));
}
function rayDensity(v) {
  const dd = dot2(v.localDir, v.localDir).toVar();
  return select9(dd.lessThanEqual(0), float8(1e30), dot2(v.localCross, v.localCross).div(max7(dd, 1e-30)));
}
function fragmentAlpha(z2, opacity, falloff) {
  const alpha = opacity.toVar();
  const g = exp4(z2.mul(-0.5)).toVar();
  If7(alpha.lessThanEqual(1), () => {
    alpha.assign(mix3(alpha, alpha.mul(g), falloff));
  }).Else(() => {
    const a = exp4(alpha.mul(alpha).sub(1).div(E));
    alpha.assign(mix3(1, float8(1).sub(pow(float8(1).sub(g), a)), falloff));
  });
  return alpha;
}

// src/render/projections.tsl.ts
var { basisToQuat: basisToQuat2, quatConj: quatConj2, quatMul: quatMul3, quatRotate: quatRotate3, scaleQuatMatrix: scaleQuatMatrix2 } = GpuSplatMath;
var { decodeExtRgb: decodeExtRgb2, decodeHalf, decodeHalf2, decodeQuatOct32, encodeExtRgb: encodeExtRgb2, encodeHalf, encodeHalf2, encodeQuatOct32 } = GpuEncoding;
var {
  If: If8,
  bool: bool2,
  cross: cross3,
  dot: dot3,
  exp: exp5,
  float: float9,
  floatBitsToUint: floatBitsToUint4,
  inverseSqrt: inverseSqrt2,
  length: length3,
  log: log3,
  mat3: mat32,
  mat4,
  max: max8,
  normalize: normalize6,
  select: select10,
  sqrt: sqrt3,
  transpose: transpose3,
  uint: uint13,
  uintBitsToFloat: uintBitsToFloat5,
  vec2: vec23,
  vec3: vec38,
  vec4: vec48
} = TSL;
var zeroWords = (n) => Array.from({ length: n }, () => uint13(0).toVar());
function assignWords(words, values) {
  values.forEach((value, i) => words[i].assign(value));
}
var ewa = {
  input: "cov",
  headWords: 0,
  eyeWords: 4,
  varyings: ["uv"],
  project({ splat: s, eyes, params }) {
    const words = [];
    const visible = bool2(false).toVar();
    for (let v = 0; v < eyes; v += 1) {
      const eye = splatInView(s, eyeFrame(v), params);
      const out = zeroWords(4);
      const ok = cullInvisible(s, params).or(cullDepth(eye)).or(cullClipXY(eye, params)).not().toVar();
      If8(ok, () => {
        const { frame, center } = eye;
        const cov3D = viewCov(s, frame).toVar();
        const focal = frame.renderSize.mul(0.5).mul(vec23(frame.projection.element(0).x, frame.projection.element(1).y)).toVar();
        const J = mat32(vec38(0), vec38(0), vec38(0)).toVar();
        If8(frame.isOrtho, () => {
          J.assign(mat32(vec38(focal.x, 0, 0), vec38(0, focal.y, 0), vec38(0)));
        }).Else(() => {
          const invZ = float9(1).div(center.z).toVar();
          const J1 = focal.mul(invZ).toVar();
          const J2 = J1.mul(center.xy).negate().mul(invZ).toVar();
          J.assign(mat32(vec38(J1.x, 0, J2.x), vec38(0, J1.y, J2.y), vec38(0)));
        });
        const cov2D = transpose3(J).mul(cov3D).mul(J).toVar();
        const a = cov2D.element(0).x.add(params.preBlurAmount).toVar();
        const d = cov2D.element(1).y.add(params.preBlurAmount).toVar();
        const b = cov2D.element(0).y.toVar();
        const detOrig = a.mul(d).sub(b.mul(b)).toVar();
        a.addAssign(eye.blur);
        d.addAssign(eye.blur);
        const opacity = s.opacity.mul(sqrt3(max8(0, detOrig.div(a.mul(d).sub(b.mul(b)))))).toVar();
        const contribution = opacity.mul(2 * Math.PI).mul(sqrt3(max8(0, a.mul(d).sub(b.mul(b)))));
        const bound = makeBound();
        ok.assign(opacity.greaterThanEqual(params.minAlpha).and(contribution.greaterThanEqual(params.minContribution)).and(boundFromCov(a, b, d, s.stdDev, params, bound)));
        If8(ok, () => {
          assignWords(out, [
            encodeNdc(eye.ndc),
            encodeDepth20(center.z).bitOr(encodeAngle12(bound.angle).shiftLeft(uint13(20))),
            encodeExtRgb2(s.splat.get("rgb")),
            encodeOpacity(storedOpacity(opacity)).bitOr(encodeLogScale(bound.scales.x, 12).shiftLeft(uint13(8))).bitOr(encodeLogScale(bound.scales.y, 12).shiftLeft(uint13(20)))
          ]);
          visible.assign(true);
        });
      });
      words.push(...out);
    }
    return { words, visible };
  },
  look: (_head, eye) => {
    const byte = eye[3].bitAnd(uint13(255));
    return { visible: byte.notEqual(uint13(0)), rgb: decodeExtRgb2(eye[2]), opacity: decodeOpacity(byte) };
  },
  vertex(_head, eye, view, corner, boundStdDev, cutoffStdDev, out) {
    const bound = {
      ndc: decodeNdc(eye[0]),
      angle: decodeAngle12(eye[1].shiftRight(uint13(20))),
      scales: vec23(decodeLogScale(eye[3].shiftRight(uint13(8)).bitAnd(uint13(4095)), 12), decodeLogScale(eye[3].shiftRight(uint13(20)), 12))
    };
    boundCorner(bound, vec38(0, 0, decodeDepth20(eye[1].bitAnd(uint13(1048575)))), corner.mul(cutoffStdDev.div(boundStdDev)), view.projection, view.renderSize, out);
    out.get("uv").assign(corner.mul(cutoffStdDev));
  },
  density: (v) => dot3(v.uv, v.uv)
};
function headBasis({ splat: s, head, params }) {
  const ok = cullInvisible(s, params).not().toVar();
  const opacity = s.opacity.toVar();
  const { quat, scales } = viewBasis(s, head.frame);
  mipInflate(head, quat, scales, opacity, params);
  ok.assign(ok.and(opacity.greaterThanEqual(params.minAlpha)));
  return { ok, opacity, quat, scales };
}
function gutBound(eye, quat, scales, stdDev, params, bound) {
  const ok = bool2(true).toVar();
  const basis3 = scaleQuatMatrix2(scales.mul(Math.sqrt(3)), quat).toVar();
  const c = eye.center;
  const points = [c, c.add(basis3.element(0)), c.sub(basis3.element(0)), c.add(basis3.element(1)), c.sub(basis3.element(1)), c.add(basis3.element(2)), c.sub(basis3.element(2))];
  const halfSize = eye.frame.renderSize.mul(0.5).toVar();
  const inFront = bool2(true).toVar();
  const pixels = points.map((point) => {
    const clip = eye.frame.projection.mul(vec48(point, 1)).toVar();
    inFront.assign(inFront.and(clip.w.greaterThan(0)));
    return clip.xy.div(clip.w).mul(halfSize).toVar();
  });
  If8(inFront.not(), () => {
    screenBound(eye.frame, params, bound);
  }).Else(() => {
    const mean = vec23(0).toVar();
    for (let i = 1; i < 7; i += 1) {
      mean.addAssign(pixels[i].mul(1 / 6));
    }
    const d0 = pixels[0].sub(mean).toVar();
    const a = d0.x.mul(d0.x).mul(2).toVar();
    const b = d0.x.mul(d0.y).mul(2).toVar();
    const d = d0.y.mul(d0.y).mul(2).toVar();
    for (let i = 1; i < 7; i += 1) {
      const di = pixels[i].sub(mean).toVar();
      a.addAssign(di.x.mul(di.x).mul(1 / 6));
      b.addAssign(di.x.mul(di.y).mul(1 / 6));
      d.addAssign(di.y.mul(di.y).mul(1 / 6));
    }
    ok.assign(boundFromCov(a, b, d, stdDev, params, bound));
    bound.ndc.assign(mean.div(halfSize));
  });
  return ok;
}
function htgsBound(eye, quat, scales, stdDev, params, bound) {
  const ok = bool2(true).toVar();
  const basis3 = scaleQuatMatrix2(scales.mul(stdDev), quat).toVar();
  const T = eye.frame.projection.mul(mat4(vec48(basis3.element(0), 0), vec48(basis3.element(1), 0), vec48(basis3.element(2), 0), vec48(eye.center, 1))).toVar();
  const xs = vec38(T.element(0).x, T.element(1).x, T.element(2).x).toVar();
  const ys = vec38(T.element(0).y, T.element(1).y, T.element(2).y).toVar();
  const ws = vec38(T.element(0).w, T.element(1).w, T.element(2).w).toVar();
  const c3 = T.element(3).toVar();
  const qww = dot3(ws, ws).sub(c3.w.mul(c3.w)).toVar();
  const valid = qww.lessThan(0).and(c3.w.greaterThan(0)).toVar();
  const center = vec23(0).toVar();
  const a = float9(0).toVar();
  const b = float9(0).toVar();
  const d = float9(0).toVar();
  If8(valid, () => {
    const u = xs.mul(c3.w).sub(ws.mul(c3.x)).toVar();
    const v = ys.mul(c3.w).sub(ws.mul(c3.y)).toVar();
    const sww = dot3(ws, ws).toVar();
    const xw = dot3(xs, ws).toVar();
    const yw = dot3(ys, ws).toVar();
    const invC2 = float9(1).div(qww.mul(qww)).toVar();
    const halfSize = eye.frame.renderSize.mul(0.5).toVar();
    a.assign(dot3(u, u).sub(sww.mul(dot3(xs, xs)).sub(xw.mul(xw))).mul(invC2).mul(halfSize.x).mul(halfSize.x));
    b.assign(dot3(u, v).sub(sww.mul(dot3(xs, ys)).sub(xw.mul(yw))).mul(invC2).mul(halfSize.x).mul(halfSize.y));
    d.assign(dot3(v, v).sub(sww.mul(dot3(ys, ys)).sub(yw.mul(yw))).mul(invC2).mul(halfSize.y).mul(halfSize.y));
    center.assign(eye.ndc.add(vec23(dot3(ws, u), dot3(ws, v)).div(c3.w.mul(qww))));
    valid.assign(a.greaterThan(0).and(d.greaterThan(0)).and(a.mul(d).sub(b.mul(b)).greaterThan(0)));
  });
  If8(valid.not(), () => {
    screenBound(eye.frame, params, bound);
  }).Else(() => {
    ok.assign(boundFromCov(a, b, d, float9(1), params, bound));
    bound.ndc.assign(center);
  });
  return ok;
}
function rayProjection(boundOf, shrinkToCutoff) {
  return {
    input: "splat",
    headWords: 6,
    eyeWords: 2,
    varyings: ["localDir", "localCross"],
    project(ctx) {
      const { splat: s, eyes, params } = ctx;
      const { ok, opacity, quat, scales } = headBasis(ctx);
      const head = zeroWords(6);
      const words = [];
      const visible = bool2(false).toVar();
      for (let v = 0; v < eyes; v += 1) {
        const eye = splatInView(s, eyeFrame(v), params);
        const out = zeroWords(2);
        If8(ok.and(cullDepth(eye).not()), () => {
          const bound = makeBound();
          const eyeQuat = frameQuat(eye.frame, s.splat.get("quaternion"));
          If8(boundOf(eye, eyeQuat, scales, s.stdDev, params, bound).and(clipBoundToScreen(eye.frame.renderSize, bound)), () => {
            assignWords(out, encodeBound(bound));
            visible.assign(true);
          });
        });
        words.push(...out);
      }
      If8(ok, () => {
        const [dir, distance, low] = encodeCenter(ctx.head.center);
        assignWords(head, [
          dir,
          distance,
          encodeExtRgb2(s.splat.get("rgb")),
          encodeQuatOct32(quat),
          encodeHalf2(log3(scales.xy)),
          encodeHalf(log3(scales.z)).bitOr(encodeOpacity(storedOpacity(opacity)).shiftLeft(uint13(16))).bitOr(low)
        ]);
      });
      return { words: [...head, ...words], visible };
    },
    look: (head, eye) => ({
      visible: eye[1].notEqual(uint13(0)),
      rgb: decodeExtRgb2(head[2]),
      opacity: decodeOpacity(head[5].shiftRight(uint13(16)).bitAnd(uint13(255)))
    }),
    vertex(head, eye, view, corner, boundStdDev, cutoffStdDev, out) {
      const center = view.fromHead.mul(vec48(decodeCenter(head[0], head[1], head[5]), 1)).xyz.toVar();
      const quat = quatMul3(view.fromHeadQuat, decodeQuatOct32(head[3])).toVar();
      const scales = exp5(vec38(decodeHalf2(head[4]), decodeHalf(head[5]))).toVar();
      const shrink = shrinkToCutoff ? cutoffStdDev.div(boundStdDev) : float9(1);
      rayVertex(decodeBound(eye[0], eye[1]), center, quat, scales, corner, shrink, view.projection, view.isOrtho, view.renderSize, out);
      out.get("uv").assign(corner.mul(boundStdDev));
    },
    density: rayDensity
  };
}
function quadOffScreen(projection, mu, axis0, axis1) {
  const c = projection.mul(vec48(mu, 1)).toVar();
  const a0 = projection.mul(vec48(axis0, 0)).toVar();
  const a1 = projection.mul(vec48(axis1, 0)).toVar();
  const inFront = bool2(true).toVar();
  const outside = [bool2(true).toVar(), bool2(true).toVar(), bool2(true).toVar(), bool2(true).toVar()];
  for (let i = 0; i < 4; i += 1) {
    const clip = c.add((i & 1) === 0 ? a0.negate() : a0).add((i & 2) === 0 ? a1.negate() : a1).toVar();
    inFront.assign(inFront.and(clip.w.greaterThan(0)));
    outside[0].assign(outside[0].and(clip.x.lessThan(clip.w.negate())));
    outside[1].assign(outside[1].and(clip.x.greaterThan(clip.w)));
    outside[2].assign(outside[2].and(clip.y.lessThan(clip.w.negate())));
    outside[3].assign(outside[3].and(clip.y.greaterThan(clip.w)));
  }
  return inFront.and(outside[0].or(outside[1]).or(outside[2]).or(outside[3]));
}
function raygsFrame(eye, quat, scales, stdDev) {
  const ok = bool2(true).toVar();
  const kappa = stdDev.mul(stdDev).toVar();
  const c2 = mahalanobis2(eye.center, quat, scales).toVar();
  const muHat = vec38(0).toVar();
  If8(eye.frame.isOrtho, () => {
    muHat.assign(normalize6(quatRotate3(quatConj2(quat), vec38(0, 0, -1)).div(scales)));
    c2.assign(1e18);
  }).Else(() => {
    ok.assign(c2.greaterThan(kappa.mul(1.0001)));
    muHat.assign(quatRotate3(quatConj2(quat), eye.center).div(scales).mul(inverseSqrt2(c2)));
  });
  const t = muHat.add(vec38(0, 0, select10(muHat.z.greaterThanEqual(0), float9(1), float9(-1)))).toVar();
  const invDen = float9(2).div(dot3(t, t)).toVar();
  const q0 = quatRotate3(quat, scales.mul(t.mul(t.x.mul(invDen)).sub(vec38(1, 0, 0)))).toVar();
  const q1 = quatRotate3(quat, scales.mul(t.mul(t.y.mul(invDen)).sub(vec38(0, 1, 0)))).toVar();
  const bxx = dot3(q0, q0).toVar();
  const bxy = dot3(q0, q1).toVar();
  const byy = dot3(q1, q1).toVar();
  const diff = bxx.sub(byy);
  const eig1 = bxx.add(byy).mul(0.5).add(sqrt3(max8(0, diff.mul(diff).mul(0.25).add(bxy.mul(bxy))))).toVar();
  const u1 = eigenvector2(bxx, bxy, byy, eig1).toVar();
  const u0 = vec23(u1.y.negate(), u1.x).toVar();
  const axis0 = q0.mul(u0.x).add(q1.mul(u0.y)).toVar();
  const axis1 = q0.mul(u1.x).add(q1.mul(u1.y)).toVar();
  const lengths = vec23(length3(axis0), length3(axis1)).toVar();
  ok.assign(ok.and(lengths.x.greaterThan(0)).and(lengths.y.greaterThan(0)));
  const zScale = stdDev.mul(inverseSqrt2(max8(float9(1).sub(kappa.div(c2)), 1e-4))).toVar();
  ok.assign(ok.and(quadOffScreen(eye.frame.projection, eye.center, axis0.mul(zScale), axis1.mul(zScale)).not()));
  const n0 = axis0.div(lengths.x).toVar();
  const n1 = axis1.div(lengths.y).toVar();
  return { ok, quat: basisToQuat2(mat32(n0, n1, cross3(n0, n1))), lengths, c2 };
}
var raygs = {
  input: "splat",
  headWords: 4,
  eyeWords: 3,
  varyings: ["uv", "c2"],
  project(ctx) {
    const { splat: s, eyes, params } = ctx;
    const { ok, opacity, scales } = headBasis(ctx);
    const head = zeroWords(4);
    const words = [];
    const visible = bool2(false).toVar();
    for (let v = 0; v < eyes; v += 1) {
      const eye = splatInView(s, eyeFrame(v), params);
      const out = zeroWords(3);
      If8(ok.and(cullDepth(eye).not()), () => {
        const eyeQuat = frameQuat(eye.frame, s.splat.get("quaternion"));
        const frame = raygsFrame(eye, eyeQuat, scales, s.stdDev);
        If8(frame.ok, () => {
          assignWords(out, [encodeQuatOct32(frame.quat), floatBitsToUint4(frame.c2), encodeHalf2(log3(frame.lengths))]);
          visible.assign(true);
        });
      });
      words.push(...out);
    }
    If8(ok, () => {
      const [dir, distance, low] = encodeCenter(ctx.head.center);
      assignWords(head, [dir, distance, encodeExtRgb2(s.splat.get("rgb")), encodeOpacity(storedOpacity(opacity)).bitOr(low)]);
    });
    return { words: [...head, ...words], visible };
  },
  look: (head, eye) => ({
    visible: eye[1].notEqual(uint13(0)),
    rgb: decodeExtRgb2(head[2]),
    opacity: decodeOpacity(head[3].bitAnd(uint13(255)))
  }),
  // z = (sqrt(kappa) / b) * corner, b = sqrt(1 - kappa / c^2); the quad is
  // built around the center, so the tighter cutoff applies directly
  vertex(head, eye, view, corner, _boundStdDev, cutoffStdDev, out) {
    const center = view.fromHead.mul(vec48(decodeCenter(head[0], head[1], head[3]), 1)).xyz.toVar();
    const quat = decodeQuatOct32(eye[0]).toVar();
    const c2 = uintBitsToFloat5(eye[1]).toVar();
    const lengths = exp5(decodeHalf2(eye[2])).toVar();
    const kappa = cutoffStdDev.mul(cutoffStdDev);
    const z = corner.mul(cutoffStdDev.mul(inverseSqrt2(max8(float9(1).sub(kappa.div(c2)), 1e-4)))).toVar();
    const offset = quatRotate3(quat, vec38(lengths.x.mul(z.x), lengths.y.mul(z.y), 0));
    const centerClip = view.projection.mul(vec48(center, 1)).toVar();
    const clip = centerClip.add(view.projection.mul(vec48(offset, 0))).toVar();
    out.get("position").assign(vec48(clip.xy, centerClip.z.div(centerClip.w).mul(clip.w), clip.w));
    out.get("uv").assign(z);
    out.get("c2").assign(c2);
  },
  // D = 1 / (1/c^2 + 1/|z|^2)
  density(v) {
    const zz = dot3(v.uv, v.uv).toVar();
    return zz.mul(v.c2).div(v.c2.add(zz));
  }
};
var PROJECTIONS = {
  ewa,
  "3dgut": rayProjection(gutBound, true),
  htgs: rayProjection(htgsBound, false),
  raygs
};

// src/render/SplatProjection.ts
var { length: length4, select: select11, uint: uint14, uniform: uniform11, uvec2: uvec24, uvec4: uvec44 } = TSL;
var sortBits = uniform11(32, "uint");
var cullKeys = uniform11(1, "uint");
function wordChannels(words) {
  const channels = [];
  for (let left = words; left > 0; left -= 4) {
    channels.push(left > 2 ? 4 : 2);
  }
  return channels;
}
var guarded = (prepared, head, params) => params.sortGuard.lessThanEqual(0).or(inSortGuard(prepared, head, params.sortGuard, params));
var instances = /* @__PURE__ */ new Map();
var SplatProjection = class _SplatProjection {
  static METHODS = ["ewa", "3dgut", "htgs", "raygs"];
  method;
  // The splat form project() takes: "cov" (ewa) or "splat"
  input;
  headWords;
  eyeWords;
  // The varyings the draw's vertex stage fills and density() reads
  varyings;
  def;
  constructor(method, def) {
    this.method = method;
    this.def = def;
    this.input = def.input;
    this.headWords = def.headWords;
    this.eyeWords = def.eyeWords;
    this.varyings = def.varyings;
  }
  // The projection of a method (one object per method)
  static get(method) {
    let projection = instances.get(method);
    if (!projection) {
      projection = new _SplatProjection(method, PROJECTIONS[method]);
      instances.set(method, projection);
    }
    return projection;
  }
  // Words per splat for `eyes` eyes
  words(eyes) {
    return this.headWords + this.eyeWords * eyes;
  }
  // The `projected` bundle for `eyes`: channels w0, w1, ...
  bundle(eyes) {
    const channels = {};
    wordChannels(this.words(eyes)).forEach((components, c) => {
      channels[`w${c}`] = components === 4 ? "uint32x4" : "uint32x2";
    });
    return defineBundle(channels, { serialize: false });
  }
  // What a projection writes: bundles `projected` and `sortKeys`
  outputs(eyes) {
    return { projected: this.bundle(eyes), sortKeys: SortKeys.KEYS };
  }
  // A reader of the projected bundle (bind it to arrays, bundle "projected")
  reader(eyes) {
    return new GpuArrayReader(this.bundle(eyes));
  }
  // All words of element `index`
  loadWords(reader, eyes, index) {
    const words = [];
    wordChannels(this.words(eyes)).forEach((components, c) => {
      const texel = reader.load(`w${c}`, index).toVar();
      words.push(...["x", "y", "z", "w"].slice(0, components).map((k) => texel[k]));
    });
    return words.slice(0, this.words(eyes));
  }
  // The words of one head-space splat for the camera's eyes, whether any
  // eye shows it, whether it is invisible anyway (zero opacity or size),
  // whether it is inside params.sortGuard (always, when that is 0), and
  // its distance from the head (the sort distance)
  project(splat, eyes) {
    const params = SplatParams.nodes;
    const prepared = prepareSplat(splat, this.input, params);
    const head = splatInView(prepared, headFrame(), params);
    const { words, visible } = this.def.project({ splat: prepared, head, eyes, params });
    return { words, visible, invisible: cullInvisible(prepared, params), guarded: guarded(prepared, head, params), distance: length4(head.center) };
  }
  // write(index, out) for a GpuArrayWriter / WgpuArrayWriter with outputs
  // outputs(eyes): projects head-space splat `splat(index)` and writes its key
  write(splat, eyes) {
    return (index, out) => {
      const { words, visible, invisible, guarded: guarded2, distance } = this.project(splat(index), eyes);
      wordChannels(words.length).forEach((components, c) => {
        const w = (i) => words[c * 4 + i] ?? uint14(0);
        out.projected[`w${c}`].assign(components === 4 ? uvec44(w(0), w(1), w(2), w(3)) : uvec24(w(0), w(1)));
      });
      const keyed = select11(cullKeys.equal(uint14(1)), visible, invisible.not().and(guarded2));
      out.sortKeys.key.assign(GpuSortKeys.pack(select11(keyed, GpuSortKeys.compute(distance, sortBits), GpuSortKeys.invalid(sortBits))));
    };
  }
  // The uniforms every projection reads: the key width, and whether keys
  // of splats culled in every eye are invalid
  static setKeys(bits, cull) {
    sortBits.value = bits;
    cullKeys.value = cull ? 1 : 0;
  }
  // write(index, out) for a writer with outputs { sortKeys: SortKeys.KEYS }:
  // only the key of head-space splat `splat(index)` of `form` (any method;
  // invisible splats and those outside params.sortGuard get the invalid one)
  static writeKeys(splat, form) {
    return (index, out) => {
      const params = SplatParams.nodes;
      const prepared = prepareSplat(splat(index), form, params);
      const head = splatInView(prepared, headFrame(), params);
      const keyed = cullInvisible(prepared, params).not().and(guarded(prepared, head, params));
      out.sortKeys.key.assign(GpuSortKeys.pack(select11(keyed, GpuSortKeys.compute(length4(head.center), sortBits), GpuSortKeys.invalid(sortBits))));
    };
  }
  // --- The draw's side ---
  // What one eye's draw decodes from the head words and that eye's
  look(head, eye) {
    return this.def.look(head, eye);
  }
  // Fills the draw's vertex struct `out` for a quad corner in [-1, 1]^2
  vertex(head, eye, view, corner, boundStdDev, cutoffStdDev, out) {
    this.def.vertex(head, eye, view, corner, boundStdDev, cutoffStdDev, out);
  }
  // Squared Mahalanobis distance at a fragment
  density(varyings) {
    return this.def.density(varyings);
  }
};

// src/render/splatTransform.tsl.ts
import * as THREE10 from "three";
var { If: If9, cross: cross4, dot: dot4, float: float10, length: length5, normalize: normalize7, select: select12, transpose: transpose4, uint: uint15, uniform: uniform12, vec3: vec39, vec4: vec49 } = TSL;
var transformNodes = () => ({
  matrix: uniform12(new THREE10.Matrix4()),
  quat: uniform12(new THREE10.Vector4(0, 0, 0, 1)),
  scale: uniform12(1),
  uniform: uniform12(1, "uint")
});
var transforms = { a: transformNodes(), b: transformNodes() };
function isUniformScale(m, tolerance = 1e-6) {
  const e = m.elements;
  const cols = [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]];
  const d = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const s2 = (d(cols[0], cols[0]) + d(cols[1], cols[1]) + d(cols[2], cols[2])) / 3;
  if (!(s2 > 0)) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = i; j < 3; j += 1) {
      if (Math.abs(d(cols[i], cols[j]) - (i === j ? s2 : 0)) > tolerance * s2) {
        return false;
      }
    }
  }
  return m.determinant() > 0;
}
function setTransform(t, m) {
  t.matrix.value.copy(m);
  const uniformScale = isUniformScale(m);
  t.uniform.value = uniformScale ? 1 : 0;
  if (uniformScale) {
    m.decompose(scratch3.position, scratch3.quaternion, scratch3.scale);
    const q = scratch3.quaternion;
    t.quat.value.set(q.x, q.y, q.z, q.w);
    t.scale.value = Math.cbrt(Math.abs(m.determinant()));
  }
}
function setTransforms(object, space) {
  const head = SplatCamera.head;
  const { a, b } = scratch3;
  if (space === void 0 || space === "view") {
    a.multiplyMatrices(head, object);
    b.identity();
  } else if (space === "object") {
    a.identity();
    b.multiplyMatrices(head, object);
  } else if (space === "world") {
    a.copy(object);
    b.copy(head);
  } else {
    a.copy(space).invert().multiply(object);
    b.multiplyMatrices(head, space);
  }
  setTransform(transforms.a, a);
  setTransform(transforms.b, b);
  if (space === void 0) {
    SplatGenerator.setContext(object, head);
    return;
  }
  if (!scratch3.head.equals(head)) {
    scratch3.head.copy(head);
    scratch3.headToWorld.copy(head).invert();
  }
  SplatGenerator.setContext(object, head, { toWorld: scratch3.spaceToWorld.multiplyMatrices(scratch3.headToWorld, b), toHead: b });
}
var scratch3 = {
  a: new THREE10.Matrix4(),
  b: new THREE10.Matrix4(),
  spaceToWorld: new THREE10.Matrix4(),
  head: new THREE10.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  headToWorld: new THREE10.Matrix4(),
  position: new THREE10.Vector3(),
  quaternion: new THREE10.Quaternion(),
  scale: new THREE10.Vector3()
};
function transformCov(c, t) {
  const out = GpuSplats.CovSplat().toVar();
  const M = GpuSplatMath.mat3FromMat4(t.matrix).toVar();
  const cov = M.mul(GpuSplatMath.covMatrix(c.get("xxyyzz"), c.get("xyxzyz"))).mul(transpose4(M)).toVar();
  out.get("center").assign(t.matrix.mul(vec49(c.get("center"), 1)).xyz);
  out.get("xxyyzz").assign(vec39(cov.element(0).x, cov.element(1).y, cov.element(2).z));
  out.get("xyxzyz").assign(vec39(cov.element(0).y, cov.element(0).z, cov.element(1).z));
  out.get("rgb").assign(c.get("rgb"));
  out.get("opacity").assign(c.get("opacity"));
  out.get("index").assign(c.get("index"));
  const c0 = M.element(0).toVar();
  const c1 = M.element(1).toVar();
  const c2 = M.element(2).toVar();
  const n = c.get("normal").toVar();
  const cofactor = cross4(c1, c2).mul(n.x).add(cross4(c2, c0).mul(n.y)).add(cross4(c0, c1).mul(n.z)).toVar();
  const signed = cofactor.mul(select12(dot4(c0, cross4(c1, c2)).lessThan(0), float10(-1), float10(1))).toVar();
  out.get("normal").assign(select12(length5(signed).greaterThan(0), normalize7(signed), vec39(0)));
  return out;
}
function transformUniform(s, t) {
  const out = GpuSplats.Splat().toVar();
  out.get("center").assign(t.matrix.mul(vec49(s.get("center"), 1)).xyz);
  out.get("quaternion").assign(GpuSplatMath.quatMul(t.quat, normalize7(s.get("quaternion"))));
  out.get("scales").assign(s.get("scales").mul(t.scale));
  out.get("rgb").assign(s.get("rgb"));
  out.get("opacity").assign(s.get("opacity"));
  out.get("index").assign(s.get("index"));
  return out;
}
function transformSplat(s, t) {
  const out = GpuSplats.Splat().toVar();
  If9(t.uniform.equal(uint15(1)), () => {
    out.assign(transformUniform(s, t));
  }).Else(() => {
    out.assign(GpuSplats.fromCov(transformCov(GpuSplats.toCov(s), t)));
  });
  return out;
}
function transformForm(node, form, t, next) {
  if (form === "cov") {
    return { node: transformCov(node, t), form: "cov" };
  }
  if (next === "cov") {
    return { node: transformCov(GpuSplats.toCov(node), t), form: "cov" };
  }
  return { node: transformSplat(node, t), form: "splat" };
}
function convertForm(node, from, to) {
  if (from === to) {
    return node;
  }
  return to === "cov" ? GpuSplats.toCov(node) : GpuSplats.fromCov(node);
}

// src/render/SplatProjector.ts
var NONE = {};
var cache3 = /* @__PURE__ */ new WeakMap();
var SplatProjector = class {
  // Programs built so far (for tests and stats)
  static programs = 0;
  // Dispose a generator's programs, once no live collection has it (an
  // object's release can; garbage collection does not free GPU pipelines)
  static dispose(generator) {
    const programs = cache3.get(generator);
    if (programs) {
      programs.all.forEach((writer) => writer.dispose());
      cache3.delete(generator);
    }
  }
};
function programOf(generator, key) {
  let programs = cache3.get(generator);
  if (!programs) {
    programs = { all: /* @__PURE__ */ new Set(), byModifier: /* @__PURE__ */ new WeakMap() };
    cache3.set(generator, programs);
  }
  let byCov = programs.byModifier.get(key.modifier ?? NONE);
  if (!byCov) {
    byCov = /* @__PURE__ */ new WeakMap();
    programs.byModifier.set(key.modifier ?? NONE, byCov);
  }
  let byKey = byCov.get(key.covModifier ?? NONE);
  if (!byKey) {
    byKey = /* @__PURE__ */ new Map();
    byCov.set(key.covModifier ?? NONE, byKey);
  }
  const name = key.pass === "keys" ? `keys:${key.webgpu}` : `${key.method}:${key.eyes}:${key.webgpu}`;
  let writer = byKey.get(name);
  if (!writer) {
    writer = build(generator, key);
    byKey.set(name, writer);
    programs.all.add(writer);
    SplatProjector.programs += 1;
  }
  return writer;
}
function projectCollection({ renderer, settings, collection, arrays, pass, cullKeys: cullKeys2 = false }) {
  const webgpu = isWebGPUBackend(renderer);
  if (webgpu && !arrays.hasStorage()) {
    throw new Error("SplatProjector: on WebGPU the output needs storage: true");
  }
  arrays.ensureCapacity(collection.count);
  arrays.count = 0;
  const { method, modifier, covModifier, modifierSpace } = settings;
  SplatParams.setView(settings.params);
  SplatProjection.setKeys(settings.sortBits, cullKeys2);
  const modified = modifier !== void 0 || covModifier !== void 0;
  const key = { pass, method, eyes: SplatCamera.eyes, modifier, covModifier, webgpu };
  for (const { object, offset } of collection.objects) {
    if (object.count <= 0) {
      continue;
    }
    setTransforms(SplatCollection.matrixWorldOf(object), modified ? modifierSpace : void 0);
    SplatParams.setObject(settings.objectParams, object.params);
    if (object.data !== void 0) {
      object.generator.bind?.(object.data, generatorContext.values);
    }
    arrays.write(programOf(object.generator, key), { at: offset, count: object.count });
  }
  arrays.count = collection.count;
}
async function readSortKeys(arrays, count = arrays.count) {
  const data = await arrays.read({ bundles: ["sortKeys"], count });
  const bytes2 = data.bundles.sortKeys.channels.key.data;
  return new Uint32Array(bytes2.buffer, bytes2.byteOffset, count);
}
function build(generator, { pass, method, eyes, modifier, covModifier, webgpu }) {
  const projection = SplatProjection.get(method);
  const want = pass === "full" ? projection.input : void 0;
  const modified = modifier !== void 0 || covModifier !== void 0;
  const modifierForm = modifier && covModifier ? void 0 : modifier ? "splat" : covModifier ? "cov" : void 0;
  const wantFirst = modified ? modifierForm ?? want : want;
  const has = { splat: generator.generateSplat !== void 0, cov: generator.generateCovSplat !== void 0 };
  const start = wantFirst && has[wantFirst] ? wantFirst : has.splat ? "splat" : "cov";
  const after = (form2, next) => form2 === "cov" || next === "cov" ? "cov" : "splat";
  let form = after(start, wantFirst);
  if (modified) {
    form = after(modifierForm ?? form, want);
  }
  const end = want ?? form;
  const splatOf = (index) => {
    const context = generatorContext.nodes;
    let node = start === "splat" ? generator.generateSplat(index, context) : generator.generateCovSplat(index, context);
    let f = start;
    ({ node, form: f } = transformForm(node, f, transforms.a, wantFirst));
    if (modified) {
      const use = modifierForm ?? f;
      node = convertForm(node, f, use);
      node = use === "splat" ? modifier(node, modifierContext.nodes) : covModifier(node, modifierContext.nodes);
      ({ node, form: f } = transformForm(node, use, transforms.b, want));
    }
    return convertForm(node, f, end);
  };
  if (pass === "keys") {
    const outputs2 = { sortKeys: SortKeys.KEYS };
    const write2 = SplatProjection.writeKeys(splatOf, end);
    const label2 = "radix_splatKeys";
    return webgpu ? new WgpuArrayWriter({ outputs: outputs2, write: write2, label: label2 }) : new GpuArrayWriter({ outputs: outputs2, write: write2, label: label2 });
  }
  const outputs = projection.outputs(eyes);
  const write = projection.write(splatOf, eyes);
  const label = `radix_project_${method}`;
  return webgpu ? new WgpuArrayWriter({ outputs, write, label }) : new GpuArrayWriter({ outputs, write, label });
}

// src/render/SplatRenderer.ts
import * as THREE13 from "three";
import { NodeMaterial as NodeMaterial3 } from "three/webgpu";

// src/wgpu/WgpuBuffer.ts
import { IndirectStorageBufferAttribute, StorageBufferAttribute } from "three/webgpu";
var { storage } = TSL;
var WgpuBuffer = class {
  renderer;
  format;
  atomic;
  indirect;
  attribute;
  node;
  capacity;
  constructor({ renderer, format, count, atomic = false, indirect = false, label = "" }) {
    requireWebGPU(renderer, "WgpuBuffer");
    if (ArrayFormats.info(format).scalarBytes !== 4 || !ArrayFormats.info(format).gpu) {
      throw new Error(`WgpuBuffer needs a 32-bit format with 1, 2 or 4 components, not ${format}`);
    }
    this.renderer = renderer;
    this.format = format;
    this.atomic = atomic;
    this.indirect = indirect;
    this.capacity = Math.max(1, count);
    this.checkSize(this.capacity);
    this.attribute = this.makeAttribute(this.capacity, label);
    this.node = storage(this.attribute, gpuFormatInfo(format).node, this.capacity);
    if (atomic) {
      this.node = this.node.toAtomic();
    }
  }
  get components() {
    return ArrayFormats.info(this.format).components;
  }
  get byteLength() {
    return this.capacity * ArrayFormats.info(this.format).bytes;
  }
  element(index) {
    return this.node.element(index);
  }
  // The GPU buffer, created if three has not yet
  gpuBuffer() {
    const backend = this.backend();
    if (!backend.get(this.attribute).buffer) {
      if (this.indirect) {
        backend.createIndirectStorageAttribute(this.attribute);
      } else {
        backend.createStorageAttribute(this.attribute);
      }
    }
    return backend.get(this.attribute).buffer;
  }
  // Resize to `count` elements; with `keep` the old contents are copied over
  setCapacity(count, { keep = false } = {}) {
    const capacity = Math.max(1, count);
    if (capacity === this.capacity) {
      return false;
    }
    this.checkSize(capacity);
    const previous = this.attribute;
    const previousBuffer = this.backend().get(previous).buffer;
    this.attribute = this.makeAttribute(capacity, previous.name);
    this.capacity = capacity;
    this.node.value = this.attribute;
    if (keep && previousBuffer) {
      this.copyBuffer(previousBuffer, 0, this.gpuBuffer(), 0, Math.min(previousBuffer.size, this.byteLength));
    }
    if (previousBuffer) {
      this.backend().destroyAttribute(previous);
    }
    return true;
  }
  // Grows by doubling, at most to the binding limit (count itself must fit)
  ensureCapacity(count, options) {
    if (count <= this.capacity) {
      return false;
    }
    const limit = Math.floor(this.backend().device.limits.maxStorageBufferBindingSize / ArrayFormats.info(this.format).bytes);
    return this.setCapacity(Math.max(count, Math.min(this.capacity * 2, limit)), options);
  }
  // Trade GPU buffers (and capacities) with `other`, of the same format:
  // shaders built on either node follow, as when a buffer grows
  swap(other) {
    if (other.format !== this.format || other.atomic !== this.atomic || other.indirect !== this.indirect) {
      throw new Error("WgpuBuffer.swap: the buffers differ in format or kind");
    }
    [this.attribute, other.attribute] = [other.attribute, this.attribute];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
    this.node.value = this.attribute;
    other.node.value = other.attribute;
  }
  // Write `data` (scalars of this format) starting at element `offset`
  upload(data, offset = 0) {
    const bytes2 = ArrayFormats.info(this.format).bytes;
    this.backend().device.queue.writeBuffer(this.gpuBuffer(), offset * bytes2, data.buffer, data.byteOffset, data.byteLength);
  }
  // Zero elements [offset, offset + count) (default: all)
  clear(offset = 0, count = this.capacity - offset) {
    const bytes2 = ArrayFormats.info(this.format).bytes;
    const device = this.backend().device;
    const encoder = device.createCommandEncoder({ label: "radix_clearBuffer" });
    encoder.clearBuffer(this.gpuBuffer(), offset * bytes2, count * bytes2);
    device.queue.submit([encoder.finish()]);
  }
  // GPU copy of elements from a buffer of the same format
  copyFrom(src, { srcStart = 0, dstStart = 0, count = src.capacity - srcStart } = {}) {
    if (src.format !== this.format || srcStart + count > src.capacity || dstStart + count > this.capacity) {
      throw new Error("WgpuBuffer.copyFrom: formats differ or the range is out of bounds");
    }
    const bytes2 = ArrayFormats.info(this.format).bytes;
    this.copyBuffer(src.gpuBuffer(), srcStart * bytes2, this.gpuBuffer(), dstStart * bytes2, count * bytes2);
  }
  // Read back elements [offset, offset + count)
  async read(offset = 0, count = this.capacity - offset) {
    const { bytes: bytes2, components, array } = ArrayFormats.info(this.format);
    this.gpuBuffer();
    const buffer = await this.renderer.getArrayBufferAsync(this.attribute, null, offset * bytes2, count * bytes2);
    return new array(buffer, 0, count * components);
  }
  dispose() {
    if (this.backend().get(this.attribute).buffer) {
      this.backend().destroyAttribute(this.attribute);
    }
    this.capacity = 0;
  }
  // Shaders bind the whole buffer, so it must fit the device's binding limit
  checkSize(capacity) {
    const bytes2 = capacity * ArrayFormats.info(this.format).bytes;
    const limit = this.backend().device.limits.maxStorageBufferBindingSize;
    if (bytes2 > limit) {
      throw new Error(`WgpuBuffer: ${capacity.toLocaleString("en-US")} elements take ${bytes2.toLocaleString("en-US")} bytes, past this device's maxStorageBufferBindingSize of ${limit.toLocaleString("en-US")}; createRenderer({ limits: { maxStorageBufferBindingSize: "adapter" } }) asks for all the adapter has`);
    }
  }
  // Three labels the GPU buffer with the attribute's name
  makeAttribute(capacity, name) {
    const { components, array } = ArrayFormats.info(this.format);
    const attribute = this.indirect ? new IndirectStorageBufferAttribute(new Uint32Array(capacity * components), components) : new StorageBufferAttribute(new array(capacity * components), components);
    attribute.name = name;
    return attribute;
  }
  copyBuffer(src, srcOffset, dst, dstOffset, size) {
    const device = this.backend().device;
    const encoder = device.createCommandEncoder({ label: "radix_copyBuffer" });
    encoder.copyBufferToBuffer(src, srcOffset, dst, dstOffset, size);
    device.queue.submit([encoder.finish()]);
  }
  backend() {
    return backendOf(this.renderer);
  }
};

// src/wgpu/WgpuCompact.ts
var { If: If10, Loop: Loop3, select: select13, uint: uint16, uniform: uniform13, workgroupArray } = TSL;
var KEYS_PER_THREAD = 8;
var BLOCK2 = SCAN_WORKGROUP * KEYS_PER_THREAD;
var WgpuCompact = class {
  renderer;
  tier;
  keys;
  values;
  // count[0]: pairs written by the latest compact()
  count;
  // The key of the indices to drop
  invalid = uniform13(4294967295, "uint");
  blockOffsets;
  n = uniform13(0, "uint");
  numBlocks = uniform13(0, "uint");
  kernels;
  constructor({ renderer, key, tier = "auto" }) {
    requireWebGPU(renderer, "WgpuCompact");
    this.renderer = renderer;
    this.tier = scanTier(renderer, tier);
    const buffer = (label) => new WgpuBuffer({ renderer, format: "uint32", count: 1, label });
    this.keys = buffer("radix_compactKeys");
    this.values = buffer("radix_compactValues");
    this.count = buffer("radix_compactCount");
    this.blockOffsets = buffer("radix_compactBlockOffsets");
    const { n, numBlocks, blockOffsets, count, keys, values, invalid } = this;
    const tierOf = this.tier;
    const valid = (i) => i.lessThan(n).and(key(i).notEqual(invalid));
    const threadCount = (base) => {
      const sum = uint16(0).toVar();
      for (let j = 0; j < KEYS_PER_THREAD; j += 1) {
        sum.addAssign(select13(valid(base.add(uint16(j))), uint16(1), uint16(0)));
      }
      return sum;
    };
    const threadBase = (workgroupId2, rank) => workgroupId2.x.mul(uint16(BLOCK2)).add(rank.mul(uint16(KEYS_PER_THREAD))).toVar();
    const blockCounts = new WgpuCompute({
      label: "radix_compactBlockCounts",
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId: localId2, workgroupId: workgroupId2 }) => {
        const rank = threadRank(tierOf, localId2);
        const scratch5 = workgroupArray("uint", SCAN_WORKGROUP);
        const { total } = workgroupExclusiveScan(tierOf, scratch5, rank, threadCount(threadBase(workgroupId2, rank)).toVar());
        If10(rank.equal(uint16(0)), () => {
          blockOffsets.element(workgroupId2.x).assign(total);
        });
      }
    });
    const scan = new WgpuCompute({
      label: "radix_compactScan",
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId: localId2 }) => {
        const rank = threadRank(tierOf, localId2);
        const scratch5 = workgroupArray("uint", SCAN_WORKGROUP);
        const carry = uint16(0).toVar();
        Loop3({ start: uint16(0), end: numBlocks, type: "uint", condition: "<", update: SCAN_WORKGROUP }, ({ i }) => {
          const index = i.add(rank).toVar();
          const inRange = index.lessThan(numBlocks).toVar();
          const value = select13(inRange, blockOffsets.element(index), uint16(0)).toVar();
          const { exclusive, total } = workgroupExclusiveScan(tierOf, scratch5, rank, value);
          If10(inRange, () => {
            blockOffsets.element(index).assign(carry.add(exclusive));
          });
          carry.addAssign(total);
        });
        If10(rank.equal(uint16(0)), () => {
          count.element(uint16(0)).assign(carry);
        });
      }
    });
    const scatter = new WgpuCompute({
      label: "radix_compactScatter",
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId: localId2, workgroupId: workgroupId2 }) => {
        const rank = threadRank(tierOf, localId2);
        const scratch5 = workgroupArray("uint", SCAN_WORKGROUP);
        const base = threadBase(workgroupId2, rank);
        const { exclusive } = workgroupExclusiveScan(tierOf, scratch5, rank, threadCount(base).toVar());
        const at2 = blockOffsets.element(workgroupId2.x).add(exclusive).toVar();
        for (let j = 0; j < KEYS_PER_THREAD; j += 1) {
          const i = base.add(uint16(j)).toVar();
          const k = key(i).toVar();
          If10(i.lessThan(n).and(k.notEqual(invalid)), () => {
            keys.element(at2).assign(k);
            values.element(at2).assign(i);
            at2.addAssign(uint16(1));
          });
        }
      }
    });
    this.kernels = [blockCounts, scan, scatter];
  }
  // Compact the first n indices (queued synchronously)
  compact(n) {
    const blocks = Math.max(1, Math.ceil(n / BLOCK2));
    this.keys.ensureCapacity(n);
    this.values.ensureCapacity(n);
    this.blockOffsets.ensureCapacity(blocks);
    this.n.value = n;
    this.numBlocks.value = blocks;
    const [blockCounts, scan, scatter] = this.kernels;
    new WgpuComputeBatch(this.renderer).add(blockCounts, [blocks]).add(scan, [1]).add(scatter, [blocks]).submit();
  }
  dispose() {
    this.kernels.forEach((kernel) => kernel.dispose());
    [this.keys, this.values, this.count, this.blockOffsets].forEach((buffer) => buffer.dispose());
  }
};

// src/wgpu/WgpuRadixSort.ts
var { If: If11, Loop: Loop4, atomicAdd, atomicLoad, atomicStore, max: max9, min: min6, select: select14, uint: uint17, uniform: uniform14, workgroupArray: workgroupArray2, workgroupBarrier: workgroupBarrier2 } = TSL;
var RADIX_BITS = 8;
var BINS = 1 << RADIX_BITS;
var MAX_PASSES = 4;
var PACK_SHIFT = 12;
var PAD_DIGIT = BINS - 1;
function scatterWorkgroupBytes(block) {
  return block * 4 + 3 * BINS * 4;
}
var WgpuRadixSort = class {
  renderer;
  tier;
  // Keys per thread and per block (256 threads)
  keysPerThread;
  blockSize;
  // The caller's buffers, sorted in place
  keys;
  values;
  keysB;
  valuesB;
  // blockHistograms[digit * numBlocks + block]: per-block digit counts, then
  // each block's exclusive offset within its digit
  blockHistograms;
  digitTotals;
  count = uniform14(0, "uint");
  numBlocks = uniform14(0, "uint");
  // The keys' capacity and its blocks, bounds of an indirect sort
  capacity = uniform14(0, "uint");
  maxBlocks = uniform14(0, "uint");
  direct;
  indirect;
  // keysPerThread 8 (default) or 16: 16 needs about 19 KB of workgroup
  // storage and sorted 10-25% slower on an Apple M3 (fewer workgroups in
  // flight)
  constructor({ renderer, keys, values, tier = "auto", keysPerThread = 8 }) {
    requireWebGPU(renderer, "WgpuRadixSort");
    this.renderer = renderer;
    this.tier = scanTier(renderer, tier);
    const limit = getGpuCaps(renderer).maxWorkgroupStorage;
    this.keysPerThread = keysPerThread;
    this.blockSize = SCAN_WORKGROUP * this.keysPerThread;
    if (scatterWorkgroupBytes(this.blockSize) > limit) {
      throw new Error(`WgpuRadixSort: ${this.keysPerThread} keys per thread need ${scatterWorkgroupBytes(this.blockSize)} bytes of workgroup memory (limit ${limit})`);
    }
    this.keys = keys;
    this.values = values;
    const buffer = (count, label) => new WgpuBuffer({ renderer, format: "uint32", count, label });
    this.keysB = buffer(keys.capacity, "radix_sortKeysB");
    this.valuesB = buffer(values.capacity, "radix_sortValuesB");
    this.blockHistograms = buffer(BINS * this.blocksFor(keys.capacity), "radix_sortBlockHistograms");
    this.digitTotals = buffer(BINS, "radix_sortDigitTotals");
  }
  // Grow the scratch buffers to the keys' and values' capacity
  ensureCapacity() {
    this.keysB.ensureCapacity(this.keys.capacity);
    this.valuesB.ensureCapacity(this.values.capacity);
    this.blockHistograms.ensureCapacity(BINS * this.blocksFor(this.keys.capacity));
  }
  // Sort the first `count` keys and values in place (ascending, stable);
  // keys must be below 2^bits
  sort(count, { bits = 32 } = {}) {
    if (count <= 0) {
      return;
    }
    this.ensureCapacity();
    const numBlocks = this.blocksFor(count);
    this.count.value = count;
    this.numBlocks.value = numBlocks;
    this.direct ??= this.makeKernels({ count: this.count, numBlocks: this.numBlocks, loopBlocks: this.numBlocks });
    this.run(this.direct, bits, [numBlocks]);
  }
  // Sort the first countBuffer[0] keys and values (at most the capacity),
  // with every dispatch sized on the GPU: nothing is read back
  sortIndirect(countBuffer, { bits = 32 } = {}) {
    this.ensureCapacity();
    this.capacity.value = this.keys.capacity;
    this.maxBlocks.value = this.blocksFor(this.keys.capacity);
    if (this.indirect?.countBuffer !== countBuffer) {
      this.indirect?.dispose();
      this.indirect = this.makeIndirectKernels(countBuffer);
    }
    this.run(this.indirect, bits, this.indirect.argsBuffer.attribute, this.indirect.args);
  }
  dispose() {
    this.direct?.dispose();
    this.indirect?.dispose();
    [this.keysB, this.valuesB, this.blockHistograms, this.digitTotals].forEach((buffer) => buffer.dispose());
  }
  run(kernels, bits, blocks, args) {
    if (bits !== 16 && bits !== 24 && bits !== 32) {
      throw new Error(`WgpuRadixSort: bits must be 16, 24 or 32 (got ${bits})`);
    }
    const passes = bits / RADIX_BITS;
    const batch = new WgpuComputeBatch(this.renderer);
    if (args) {
      batch.add(args, [1]);
    }
    for (let pass = 0; pass < passes; pass += 1) {
      batch.add(kernels.histogram[pass], blocks).add(kernels.scanBlocks, [BINS]).add(kernels.scatter[pass], blocks);
    }
    batch.submit();
    if (passes % 2 === 1) {
      this.keys.swap(this.keysB);
      this.values.swap(this.valuesB);
    }
  }
  blocksFor(count) {
    return Math.max(1, Math.ceil(count / this.blockSize));
  }
  makeKernels(counts) {
    const { keys, values, keysB, valuesB } = this;
    const histogram = [];
    const scatter = [];
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const forward = pass % 2 === 0;
      const shift = pass * RADIX_BITS;
      histogram.push(this.makeHistogram(counts, shift, forward ? keys : keysB));
      scatter.push(forward ? this.makeScatter(counts, shift, keys, values, keysB, valuesB) : this.makeScatter(counts, shift, keysB, valuesB, keys, values));
    }
    const scanBlocks = this.makeScanBlocks(counts);
    return {
      histogram,
      scanBlocks,
      scatter,
      dispose: () => [...histogram, ...scatter, scanBlocks].forEach((kernel) => kernel.dispose())
    };
  }
  makeIndirectKernels(countBuffer) {
    const count = min6(countBuffer.element(uint17(0)), this.capacity);
    const numBlocks = max9(count.add(uint17(this.blockSize - 1)).div(uint17(this.blockSize)), uint17(1));
    const kernels = this.makeKernels({ count, numBlocks, loopBlocks: this.maxBlocks });
    const argsBuffer = new WgpuBuffer({ renderer: this.renderer, format: "uint32", count: 3, indirect: true, label: "radix_sortIndirectArgs" });
    const args = new WgpuCompute({
      label: "radix_sortIndirectArgs",
      workgroupSize: [1],
      body: () => {
        argsBuffer.element(uint17(0)).assign(numBlocks);
        argsBuffer.element(uint17(1)).assign(uint17(1));
        argsBuffer.element(uint17(2)).assign(uint17(1));
      }
    });
    return {
      ...kernels,
      countBuffer,
      args,
      argsBuffer,
      dispose: () => {
        kernels.dispose();
        args.dispose();
        argsBuffer.dispose();
      }
    };
  }
  makeHistogram({ count, numBlocks }, shift, keys) {
    const { tier, keysPerThread, blockSize, blockHistograms } = this;
    return new WgpuCompute({
      label: `radix_sortHistogram_${shift}`,
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId: localId2, workgroupId: workgroupId2 }) => {
        const rank = threadRank(tier, localId2);
        const block = workgroupId2.x;
        const counts = workgroupArray2("uint", BINS).setAtomic(true);
        atomicStore(counts.element(rank), uint17(0));
        workgroupBarrier2();
        const base = block.mul(uint17(blockSize)).add(rank.mul(uint17(keysPerThread))).toVar();
        for (let j = 0; j < keysPerThread; j += 1) {
          const i = base.add(uint17(j));
          If11(i.lessThan(count), () => {
            atomicAdd(counts.element(keys.element(i).shiftRight(uint17(shift)).bitAnd(uint17(BINS - 1))), uint17(1));
          });
        }
        workgroupBarrier2();
        blockHistograms.element(rank.mul(numBlocks).add(block)).assign(atomicLoad(counts.element(rank)));
      }
    });
  }
  // One workgroup per digit: exclusive scan over that digit's block counts
  // in chunks of 256 with a carry; the digit total to digitTotals[digit]
  makeScanBlocks({ numBlocks, loopBlocks }) {
    const { tier, blockHistograms, digitTotals } = this;
    return new WgpuCompute({
      label: "radix_sortScanBlocks",
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId: localId2, workgroupId: workgroupId2 }) => {
        const rank = threadRank(tier, localId2);
        const digit = workgroupId2.x;
        const scratch5 = workgroupArray2("uint", SCAN_WORKGROUP);
        const carry = uint17(0).toVar();
        const rowBase = digit.mul(numBlocks).toVar();
        const blocks = numBlocks.toVar();
        Loop4({ start: uint17(0), end: loopBlocks, type: "uint", condition: "<", update: SCAN_WORKGROUP }, ({ i }) => {
          const index = i.add(rank).toVar();
          const inRange = index.lessThan(blocks).toVar();
          const value = select14(inRange, blockHistograms.element(rowBase.add(index)), uint17(0)).toVar();
          const { exclusive, total } = workgroupExclusiveScan(tier, scratch5, rank, value);
          If11(inRange, () => {
            blockHistograms.element(rowBase.add(index)).assign(carry.add(exclusive));
          });
          carry.addAssign(total);
        });
        If11(rank.equal(uint17(0)), () => {
          digitTotals.element(digit).assign(carry);
        });
      }
    });
  }
  // One workgroup per block: scan the digit totals into bin offsets, sort
  // the block's (digit, position) words by digit in workgroup memory (8
  // stable one-bit splits), rank = position - first position of the digit,
  // then gather each element from the source block and scatter it to
  // binOffset[d] + blockOffset[d][block] + rank
  makeScatter({ count, numBlocks }, shift, srcKeys, srcValues, dstKeys, dstValues) {
    const { tier, keysPerThread, blockSize, blockHistograms, digitTotals } = this;
    const posMask = (1 << PACK_SHIFT) - 1;
    return new WgpuCompute({
      label: `radix_sortScatter_${shift}`,
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId: localId2, workgroupId: workgroupId2 }) => {
        const rank = threadRank(tier, localId2);
        const block = workgroupId2.x;
        const packedWords = workgroupArray2("uint", blockSize);
        const scratch5 = workgroupArray2("uint", SCAN_WORKGROUP);
        const digitStart = workgroupArray2("uint", BINS);
        const binOffsets = workgroupArray2("uint", BINS);
        const n = count.toVar();
        const { exclusive: binOffset } = workgroupExclusiveScan(tier, scratch5, rank, digitTotals.element(rank).toVar());
        binOffsets.element(rank).assign(binOffset);
        const blockBase = block.mul(uint17(blockSize)).toVar();
        const blockCount = select14(n.sub(blockBase).lessThan(uint17(blockSize)), n.sub(blockBase), uint17(blockSize)).toVar();
        const threadBase = rank.mul(uint17(keysPerThread)).toVar();
        for (let j = 0; j < keysPerThread; j += 1) {
          const p = threadBase.add(uint17(j)).toVar();
          const i = blockBase.add(p);
          const digit = select14(i.lessThan(n), srcKeys.element(i).shiftRight(uint17(shift)).bitAnd(uint17(BINS - 1)), uint17(PAD_DIGIT));
          packedWords.element(p).assign(digit.shiftLeft(uint17(PACK_SHIFT)).bitOr(p));
        }
        for (let bit = 0; bit < RADIX_BITS; bit += 1) {
          workgroupBarrier2();
          const words = [];
          const bits = [];
          const ones = uint17(0).toVar();
          for (let j = 0; j < keysPerThread; j += 1) {
            words.push(packedWords.element(threadBase.add(uint17(j))).toVar());
            bits.push(words[j].shiftRight(uint17(PACK_SHIFT + bit)).bitAnd(uint17(1)).toVar());
            ones.addAssign(bits[j]);
          }
          const { exclusive: onesBefore, total: totalOnes } = workgroupExclusiveScan(tier, scratch5, rank, ones);
          const totalZeros = uint17(blockSize).sub(totalOnes).toVar();
          const onesSoFar = onesBefore.toVar();
          for (let j = 0; j < keysPerThread; j += 1) {
            const p = threadBase.add(uint17(j));
            const dst = select14(bits[j].equal(uint17(1)), totalZeros.add(onesSoFar), p.sub(onesSoFar)).toVar();
            packedWords.element(dst).assign(words[j]);
            onesSoFar.addAssign(bits[j]);
          }
        }
        workgroupBarrier2();
        for (let j = 0; j < keysPerThread; j += 1) {
          const p = threadBase.add(uint17(j));
          const digit = packedWords.element(p).shiftRight(uint17(PACK_SHIFT)).toVar();
          const previous = select14(p.equal(uint17(0)), digit.add(uint17(1)), packedWords.element(p.sub(uint17(1))).shiftRight(uint17(PACK_SHIFT)));
          If11(digit.notEqual(previous), () => {
            digitStart.element(digit).assign(p);
          });
        }
        workgroupBarrier2();
        for (let j = 0; j < keysPerThread; j += 1) {
          const p = threadBase.add(uint17(j));
          If11(p.lessThan(blockCount), () => {
            const word = packedWords.element(p).toVar();
            const digit = word.shiftRight(uint17(PACK_SHIFT)).toVar();
            const src = blockBase.add(word.bitAnd(uint17(posMask))).toVar();
            const dst = binOffsets.element(digit).add(blockHistograms.element(digit.mul(numBlocks).add(block))).add(p.sub(digitStart.element(digit))).toVar();
            dstKeys.element(dst).assign(srcKeys.element(src));
            dstValues.element(dst).assign(srcValues.element(src));
          });
        }
      }
    });
  }
};

// src/wgpu/WgpuSplatSorter.ts
var { uint: uint18 } = TSL;
var WgpuSplatSorter = class _WgpuSplatSorter {
  // Splats per instance of the indirect draw: SplatRenderer's quads
  static QUADS_PER_INSTANCE = 1024;
  renderer;
  // Sorted splat indices: values.element(i) is the i-th splat drawn
  values;
  // The number of them (a TSL node, the sort's visible count)
  count;
  // drawIndexedIndirect arguments: the indices of QUADS_PER_INSTANCE
  // quads, enough instances for the visible count, first index, base
  // vertex and first instance 0
  indirect;
  keys = new GpuArrayReader(SortKeys.KEYS);
  compact;
  radix;
  args;
  constructor(renderer) {
    requireWebGPU(renderer, "WgpuSplatSorter");
    this.renderer = renderer;
    this.compact = new WgpuCompact({ renderer, key: (i) => GpuSortKeys.unpack(this.keys.load("key", i)) });
    this.radix = new WgpuRadixSort({ renderer, keys: this.compact.keys, values: this.compact.values });
    this.values = this.compact.values;
    const indirect = this.indirect = new WgpuBuffer({ renderer, format: "uint32", count: 5, indirect: true, label: "radix_splatDrawArgs" });
    const count = this.count = this.compact.count.element(uint18(0));
    const quads = _WgpuSplatSorter.QUADS_PER_INSTANCE;
    this.args = new WgpuCompute({
      label: "radix_splatDrawArgs",
      workgroupSize: [1],
      body: () => {
        indirect.element(uint18(0)).assign(uint18(quads * 6));
        indirect.element(uint18(1)).assign(count.add(uint18(quads - 1)).div(uint18(quads)));
        indirect.element(uint18(2)).assign(uint18(0));
        indirect.element(uint18(3)).assign(uint18(0));
        indirect.element(uint18(4)).assign(uint18(0));
      }
    });
  }
  // Sort the first `count` splats of `projected` (arrays with a sortKeys
  // bundle of SortKeys.KEYS, as a SplatRenderer's projected arrays) by their keys of
  // width `bits`
  sort(projected, count, bits) {
    this.keys.bind(projected, "sortKeys");
    this.compact.invalid.value = SortKeys.invalid(bits);
    this.compact.compact(count);
    this.radix.sortIndirect(this.compact.count, { bits });
    this.args.dispatch(this.renderer, [1]);
  }
  // The visible count of the latest sort (a readback, for tests and stats)
  async readCount() {
    return (await this.compact.count.read(0, 1))[0];
  }
  dispose() {
    this.compact.dispose();
    this.radix.dispose();
    this.args.dispose();
    this.indirect.dispose();
  }
};

// inline-worker:/Users/dmarcos/Development/radix/src/worker/coreModule
var coreModule_default = 'var gn={uint8:{bytes:1,array:Uint8Array},sint8:{bytes:1,array:Int8Array},unorm8:{bytes:1,array:Uint8Array},snorm8:{bytes:1,array:Int8Array},uint16:{bytes:2,array:Uint16Array},sint16:{bytes:2,array:Int16Array},float16:{bytes:2,array:Uint16Array},uint32:{bytes:4,array:Uint32Array},sint32:{bytes:4,array:Int32Array},float32:{bytes:4,array:Float32Array}},Wt=new Map,ce=class{static info(e){let t=Wt.get(e);if(!t){let[n,a]=e.split("x"),o=gn[n],s=a===void 0?1:Number(a);if(!o||!Number.isInteger(s)||s<1)throw new Error(`Invalid array format "${e}"`);t={format:e,scalar:n,components:s,scalarBytes:o.bytes,bytes:o.bytes*s,array:o.array,gpu:s===1||s===2||s===4},Wt.set(e,t)}return t}static make(e,t){return t===1?e:`${e}x${t}`}};function ne(r,{packing:e=1,serialize:t=!0}={}){for(let n of Object.values(r)){let a=ce.info(n).components*e;if(e>1&&![1,2,4].includes(a))throw new Error(`Format ${n} cannot be packed ${e} per texel`)}return{channels:r,packing:e,serialize:t}}var ie=class r{static WIDTH=1024;static MAX_PACKING=4;static ROW_ELEMENTS=r.WIDTH*r.MAX_PACKING;static MAX_HEIGHT=4096;static MAX_LAYERS=512;width;height;layers;xBits;yBits;texels;constructor(e,t){this.width=r.WIDTH,this.height=e,this.layers=t,this.xBits=Math.log2(this.width),this.yBits=Math.log2(e),this.texels=this.width*e*t}static for(e){let t=Math.max(1,Math.ceil(e/r.WIDTH)),n=Math.min(r.MAX_HEIGHT,2**Math.max(0,Math.floor(Math.log2(t/2)))),a=Math.max(2,Math.ceil(t/n));if(a>r.MAX_LAYERS)throw new Error(`${e} texels do not fit in an array texture`);return new r(n,a)}static alignCapacity(e){return Math.max(1,Math.ceil(e/r.ROW_ELEMENTS))*r.ROW_ELEMENTS}spans(e,t){let{width:n,height:a}=this,o=n*a,s=[],i=e+t,c=e;for(;c<i;){let l=Math.floor(c/o),u=c-l*o,f=Math.floor(u/n),d=u-f*n;if(d>0||i-c<n){let y=Math.min(n-d,i-c);s.push({x:d,y:f,layer:l,width:y,rows:1,offset:c-e}),c+=y}else{let y=Math.min(Math.floor((i-c)/n),a-f);s.push({x:0,y:f,layer:l,width:n,rows:y,offset:c-e}),c+=y*n}}return s}static copySpans(e,t,n,a,o){let s=r.WIDTH,i=(u,f)=>{let d=s*u.height,y=Math.floor(f/d),p=Math.floor((f-y*d)/s);return{x:f%s,y:p,layer:y}},c=[],l=0;for(;l<o;){let u=i(e,t+l),f=i(n,a+l),d=o-l,y;if(u.x===0&&f.x===0&&d>=s){let p=Math.min(Math.floor(d/s),e.height-u.y,n.height-f.y);y={src:u,dst:f,width:s,rows:p}}else y={src:u,dst:f,width:Math.min(d,s-u.x,s-f.x),rows:1};c.push(y),l+=y.width*y.rows}return c}};var Z=class r{static INDICES=ne({index:"uint32"},{packing:4});count;capacity;bundles;meta;constructor({bundles:e,count:t=0,capacity:n,meta:a={}}={}){if(this.count=t,this.capacity=n??ie.alignCapacity(t),this.capacity<t)throw new Error(`Capacity ${this.capacity} is below count ${t}`);this.bundles={},this.meta=a;for(let[o,s]of Object.entries(e??{}))this.addBundle(o,s)}addBundle(e,t,n={}){let a={};for(let[o,s]of Object.entries(t.channels)){let i=ce.info(s),c=this.capacity*i.components,l=n.data?.[o];if(l&&l.constructor!==i.array)throw new Error(`Channel ${e}.${o}: ${l.constructor.name} does not hold ${s}`);if(!l||l.length<c){let u=new i.array(c);l&&u.set(l),l=u}a[o]={format:s,data:l}}return this.anyBundles[e]={def:t,channels:a,meta:{...n.meta}},this}removeBundle(e){return e in this.bundles?(delete this.anyBundles[e],!0):!1}setCapacity(e){if(e===this.capacity)return!1;for(let t of Object.values(this.anyBundles))for(let n of Object.values(t.channels)){let a=ce.info(n.format),o=new a.array(e*a.components);o.set(n.data.subarray(0,o.length)),n.data=o}return this.capacity=e,this.count=Math.min(this.count,e),!0}ensureCapacity(e){return e<=this.capacity?!1:this.setCapacity(ie.alignCapacity(Math.max(e,this.capacity*2)))}copyFrom(e,{bundles:t,srcStart:n=0,dstStart:a=0,count:o=e.count-n}={}){if(n<0||o<0||n+o>e.capacity)throw new Error(`Copy of ${o} elements from ${n} exceeds the source capacity ${e.capacity}`);this.ensureCapacity(a+o);let s=t??Object.keys(this.bundles).filter(i=>i in e.bundles);for(let i of s){let c=e.anyBundles[i],l=this.anyBundles[i];if(!c||!l)throw new Error(`Bundle ${i} missing`);for(let[u,f]of Object.entries(l.channels)){let d=c.channels[u];if(d?.format!==f.format)throw new Error(`Channel ${i}.${u} missing or of another format`);let y=ce.info(f.format).components,p=d.data.subarray(n*y,(n+o)*y);f.data.set(p,a*y)}}this.count=Math.max(this.count,a+o)}clone(){let e=new r({count:this.count,capacity:this.capacity,meta:structuredClone(this.meta)});for(let[t,n]of Object.entries(this.anyBundles)){let a=Object.fromEntries(Object.entries(n.channels).map(([o,s])=>[o,s.data.slice()]));e.addBundle(t,n.def,{data:a,meta:structuredClone(n.meta)})}return e}swap(e){[this.count,e.count]=[e.count,this.count],[this.capacity,e.capacity]=[e.capacity,this.capacity],[this.bundles,e.bundles]=[e.bundles,this.bundles],[this.meta,e.meta]=[e.meta,this.meta]}toTransferable(){let e={};for(let[t,n]of Object.entries(this.anyBundles)){let a=Object.fromEntries(Object.entries(n.channels).map(([o,s])=>[o,s.data]));e[t]={def:n.def,meta:n.meta,channels:a}}return{count:this.count,capacity:this.capacity,meta:this.meta,bundles:e}}setFromTransferable(e){this.count=e.count,this.capacity=e.capacity,this.meta=e.meta;let t={};for(let[n,a]of Object.entries(e.bundles)){let o=this.anyBundles[n],s=Object.keys(a.def.channels);if(o&&o.def.packing===a.def.packing&&s.length===Object.keys(o.channels).length&&s.every(c=>o.channels[c]?.format===a.def.channels[c])){for(let c of s)o.channels[c].data=a.channels[c];o.def=a.def,o.meta=a.meta,t[n]=o}else{let c=Object.fromEntries(s.map(l=>[l,{format:a.def.channels[l],data:a.channels[l]}]));t[n]={def:a.def,channels:c,meta:a.meta}}}return this.bundles=t,this}static fromTransferable(e){return new r().setFromTransferable(e)}static transferables(e){let t=new Set,n=new Set,a=o=>{!o||typeof o!="object"||n.has(o)||(n.add(o),o instanceof ArrayBuffer?t.add(o):ArrayBuffer.isView(o)?o.buffer instanceof ArrayBuffer&&t.add(o.buffer):Object.values(o).forEach(a))};return a(e),[...t]}get anyBundles(){return this.bundles}};function Ne(r,e,t){return r&&((n,a)=>r(e+(t-e)*Math.min(1,Math.max(0,n)),a))}function ae(r,e,t){return r?n=>(n&65535)===0&&r(n/Math.max(1,e),t):()=>{}}async function Gt(r,e){let t=Number(r.headers.get("content-length")??0);if(!e||!r.body||!(t>0))return new Uint8Array(await r.arrayBuffer());let n=[],a=0,o=r.body.getReader();for(;;){let{done:c,value:l}=await o.read();if(c)break;n.push(l),a+=l.byteLength,e(Math.min(1,a/t),"downloading")}let s=new Uint8Array(a),i=0;for(let c of n)s.set(c,i),i+=c.byteLength;return s}var Xt=new WeakMap,wt=new Float32Array(1),xn=new Uint32Array(wt.buffer),Jt=globalThis.Float16Array,at=Jt?new Jt(1):void 0,er=at?new Uint16Array(at.buffer):void 0;function sr(r){if(r<1||r>16)throw new Error(`Octahedral codes take 1 to 16 bits per axis, not ${r}`);let e=2**r-1,t=(e|e<<r)>>>0;return{encode(n){let a=Math.abs(n.x)+Math.abs(n.y)+Math.abs(n.z);if(!(a>0))return 0;let o=n.x/a,s=n.y/a;if(n.z<0){let c=Math.abs(o);o=(1-Math.abs(s))*(o>=0?1:-1),s=(1-c)*(s>=0?1:-1)}let i=(Math.round((o*.5+.5)*e)|Math.round((s*.5+.5)*e)<<r)>>>0;return i===0?t:i},decode(n,a){if(n===0)return a.x=0,a.y=0,a.z=0,a;let o=(n&e)/e*2-1,s=(n>>>r&e)/e*2-1,i=1-Math.abs(o)-Math.abs(s),c=Math.max(-i,0);o+=o>=0?-c:c,s+=s>=0?-c:c;let l=Math.sqrt(o*o+s*s+i*i);return a.x=o/l,a.y=s/l,a.z=i/l,a}}}function An(r,e){let t=2*r;if(t+e>32)throw new Error(`Quaternion codes hold at most 32 bits, not ${t+e}`);let n=sr(r),a=2**t-1,o=2**e-1,s={x:0,y:0,z:0};return{encode(i){let c=Math.sqrt(i.x*i.x+i.y*i.y+i.z*i.z+i.w*i.w);if(!(c>0))return 0;let l=(i.w<0?-1:1)/c;s.x=i.x*l,s.y=i.y*l,s.z=i.z*l;let u=2*Math.acos(Math.min(1,i.w*l)),f=Math.round(u/Math.PI*o);return(n.encode(s)|f<<t)>>>0},decode(i,c){n.decode(i&a,c);let l=(i>>>t&o)/o*Math.PI,u=Math.sin(l/2);return c.x*=u,c.y*=u,c.z*=u,c.w=Math.cos(l/2),c}}}var tr=new Map,rr=new Map;function Et(r){let e=tr.get(r);return e||(e=sr(r),tr.set(r,e)),e}function ot(r,e){let t=`${r}:${e}`,n=rr.get(t);return n||(n=An(r,e),rr.set(t,n)),n}var nr=Et(12),ar=ot(10,12),or=ot(8,8),T=class{static floatView(e){let t=Xt.get(e);return t||(t=new Float32Array(e.buffer,e.byteOffset,e.length),Xt.set(e,t)),t}static encodeHalf(e){if(at&&er)return at[0]=e,er[0];wt[0]=e;let t=xn[0],n=t>>>16&32768,a=t>>>23&255,o=t&8388607;if(a===255)return n|31744|(o?512:0);let s=a-127+15;if(s>=31)return n|31744;if(s<=0){let l=Math.abs(wt[0])*16777216,u=Math.floor(l),f=l-u;return(f>.5||f===.5&&u&1)&&(u+=1),n|u}let i=n|s<<10|o>>13,c=o&8191;return c>4096||c===4096&&i&1?i+1:i}static decodeHalf(e){let t=e&32768?-1:1,n=e>>10&31,a=e&1023;return n===0?t*a*2**-24:n===31?a?Number.NaN:t*Number.POSITIVE_INFINITY:t*(1+a/1024)*2**(n-15)}static encodeUnorm8(e){return Math.max(0,Math.min(255,Math.round(e*255)))}static encodeLodOpacity(e){return Math.max(0,Math.min(255,Math.round(e*128)))}static decodeLodOpacity(e){return e/128}static encodeExtRgb({r:e,g:t,b:n}){let a=Math.max(Math.abs(e),Math.abs(t),Math.abs(n)),o=Math.max(0,Math.min(31,(a>0?Math.ceil(Math.log2(a)):0)+15)),s=255*2**(15-o),i=Math.min(255,Math.round(Math.abs(e)*s)),c=Math.min(255,Math.round(Math.abs(t)*s)),l=Math.min(255,Math.round(Math.abs(n)*s)),u=(e<0?1:0)|(t<0?2:0)|(n<0?4:0);return(i|c<<8|l<<16|(o<<3|u)<<24)>>>0}static decodeExtRgb(e,t){let n=2**((e>>>27&31)-15)/255;return t.r=(e&255)*n*(e&16777216?-1:1),t.g=(e>>>8&255)*n*(e&33554432?-1:1),t.b=(e>>>16&255)*n*(e&67108864?-1:1),t}static encodeOct(e,t){return Et(t).encode(e)}static decodeOct(e,t,n){return Et(t).decode(e,n)}static encodeQuatOct(e,t,n){return ot(t,n).encode(e)}static decodeQuatOct(e,t,n,a){return ot(t,n).decode(e,a)}static encodeOct24=nr.encode;static decodeOct24=nr.decode;static encodeQuatOct32=ar.encode;static decodeQuatOct32=ar.decode;static encodeQuatOct24=or.encode;static decodeQuatOct24=or.decode};var oe=[0,3,8,15,24],Ce=4,Ve=oe[Ce]*3,Sn=[10,16,22,28],wn=[0,10,26,48,76],En={1:["A"],2:["A","B"],3:["A","B","C","D"],4:["A","B","C","D","E","F"]},Un={1:["A"],2:["A","B"],3:["A","B","C"],4:["A","B","C","D","E"]},dr=192,yr=16;function pr(r){if(!(r>0))return 0;let e=Math.max(1,Math.min(255,Math.ceil(Math.log2(r)*yr)+dr));for(;e<255&&ct(e)<r;)e+=1;return e}function ct(r){return r===0?0:2**((r-dr)/yr)}var cr=(r,e,t)=>r[e+(t>>2)]>>>(t&3)*8&255,te={out:new Uint32Array(0),at:0,word:0,shift:0},vn=(r,e)=>{te.out=r,te.at=e,te.word=0,te.shift=0},ir=r=>{te.word|=(r&255)<<te.shift,te.shift+=8,te.shift===32&&(te.out[te.at++]=te.word>>>0,te.word=0,te.shift=0)},Mn=()=>{te.shift>0&&(te.out[te.at++]=te.word>>>0)},ye={r:0,g:0,b:0},Cn={name:"ext",words:r=>oe[r],channels:r=>En[r],encode(r,e,t,n){for(let a=0;a<oe[e];a+=1)ye.r=r[a*3],ye.g=r[a*3+1],ye.b=r[a*3+2],t[n+a]=T.encodeExtRgb(ye)},decode(r,e,t,n){for(let a=0;a<oe[t];a+=1)T.decodeExtRgb(r[e+a],ye),n[a*3]=ye.r,n[a*3+1]=ye.g,n[a*3+2]=ye.b;return n}},Ln={name:"packed",words:r=>Math.ceil(wn[r]/4),channels:r=>Un[r],encode(r,e,t,n){vn(t,n);for(let a=0;a<e;a+=1){let o=oe[a]*3,s=oe[a+1]*3,i=0;for(let u=o;u<s;u+=1)i=Math.max(i,Math.abs(r[u]));let c=pr(i),l=ct(c);ir(c);for(let u=o;u<s;u+=1)ir(l>0?Math.max(-127,Math.min(127,Math.round(r[u]/l*127))):0)}Mn()},decode(r,e,t,n){let a=0;for(let o=0;o<t;o+=1){let s=oe[o]*3,i=oe[o+1]*3,c=ct(cr(r,e,a))/127;for(let l=s;l<i;l+=1)n[l]=(cr(r,e,a+1+l-s)<<24>>24)*c;a+=Sn[o]}return n}},mr={ext:Cn,packed:Ln},Ut=new Map,vt={};for(let r of Object.values(mr)){vt[r.name]=[0,0,0,0,0];for(let e of[1,2,3,4]){let t=r.channels(e);vt[r.name][e]=t.length;for(let n of t){let a=`${r.name}Sh${n}`,o=Ut.get(a);o?o.degrees|=1<<e:Ut.set(a,{codec:r.name,degrees:1<<e})}}}var lr=r=>r===1||r===2||r===3||r===4?r:void 0,O=class r{static COEFFICIENTS=oe;static MAX_DEGREE=Ce;static VALUES=Ve;static LABEL=ne({label:"uint16"});static codec(e){let t=mr[e];if(!t)throw new Error(`Unknown SH codec ${e}`);return t}static texels(e,t){return Math.ceil(r.codec(e).words(t)/4)}static degreeOf(e){return lr(oe.indexOf(e))}static bundleName(e){return`${r.codec(e).name}Sh`}static bundle(e,t){return ne(Object.fromEntries(r.codec(e).channels(t).map(n=>[`${e}Sh${n}`,"uint32x4"])))}static add(e,t,n){return e.addBundle(r.bundleName(t),r.bundle(t,n),{meta:{codec:t,degree:n}}),e.bundles[r.bundleName(t)]}static find(e){for(let t in e){let n=e[t],a,o=30,s=0;for(let c in n.channels){let l=Ut.get(c);if(!l||n.channels[c]?.format!=="uint32x4"||a!==void 0&&l.codec!==a){a=void 0;break}a=l.codec,o&=l.degrees,s+=1}if(a===void 0)continue;let i=vt[a];for(let c=Ce;c>=1;c-=1)if((o&1<<c)!==0&&i[c]===s)return{name:t,codec:a,degree:c}}}static prepare(e,t,n="ext"){let a=lr(t);if(e.meta.ignoredShDegree=a&&n===!1?a:0,!(!a||n===!1))return r.add(e,n,a),r.encoder(e)}static encoder(e,t=r.find(e.bundles)){if(!t)throw new Error("No SH bundle");let{degree:n}=t,a=r.codec(t.codec),o=fr(e.bundles[t.name]),s=new Uint32Array(o.length*4);return(i,c)=>{a.encode(c,n,s,0);let l=i*4;for(let u=0;u<o.length;u+=1){let f=o[u],d=u*4;f[l]=s[d],f[l+1]=s[d+1],f[l+2]=s[d+2],f[l+3]=s[d+3]}}}static decoder(e,t=r.find(e.bundles)){if(!t)throw new Error("No SH bundle");let{degree:n}=t,a=r.codec(t.codec),o=fr(e.bundles[t.name]),s=new Uint32Array(o.length*4);return(i,c)=>{let l=i*4;for(let u=0;u<o.length;u+=1){let f=o[u],d=u*4;s[d]=f[l],s[d+1]=f[l+1],s[d+2]=f[l+2],s[d+3]=f[l+3]}return a.decode(s,0,n,c)}}static convert(e,t,{degree:n}={}){let a=r.find(e.bundles);if(!a)return e;let o=Math.min(n??a.degree,a.degree);if(a.codec===t&&o===a.degree)return e;let s=hr(e,a.name);r.add(s,t,o);let i=r.decoder(e,a),c=r.encoder(s),l=new Float32Array(Ve);for(let u=0;u<e.count;u+=1)c(u,i(u,l));return s}static evaluate(e,t,n,a=[0,0,0]){r.basis(t,st),a[0]=0,a[1]=0,a[2]=0;for(let o=0;o<oe[Math.max(0,Math.min(Ce,n))];o+=1)a[0]+=e[o*3]*st[o],a[1]+=e[o*3+1]*st[o],a[2]+=e[o*3+2]*st[o];return a}static basis(e,t=new Float64Array(oe[Ce])){let{x:n,y:a,z:o}=e,s=n*n,i=a*a,c=o*o;return t[0]=-.4886025*a,t[1]=.4886025*o,t[2]=-.4886025*n,t[3]=1.0925484*n*a,t[4]=-1.0925484*a*o,t[5]=.3153916*(2*c-s-i),t[6]=-1.0925484*n*o,t[7]=.5462742*(s-i),t[8]=-.5900436*a*(3*s-i),t[9]=2.8906114*n*a*o,t[10]=-.4570458*a*(4*c-s-i),t[11]=.3731763*o*(2*c-3*s-3*i),t[12]=-.4570458*n*(4*c-s-i),t[13]=1.4453057*o*(s-i),t[14]=-.5900436*n*(s-3*i),t[15]=2.5033429*n*a*(s-i),t[16]=-1.7701308*a*o*(3*s-i),t[17]=.9461747*n*a*(7*c-1),t[18]=-.6690465*a*o*(7*c-3),t[19]=.1057855*(c*(35*c-30)+3),t[20]=-.6690465*n*o*(7*c-3),t[21]=.4730873*(s-i)*(7*c-1),t[22]=-1.7701308*n*o*(s-3*i),t[23]=.6258357*(s*(s-3*i)-i*(3*s-i)),t}},st=new Float64Array(oe[Ce]),fr=r=>Object.values(r.channels).map(e=>e.data),Bn=r=>Object.fromEntries(Object.entries(r.channels).map(([e,t])=>[e,t.data]));function hr(r,e){let t=new Z({count:r.count,capacity:r.capacity,meta:{...r.meta}});for(let[n,a]of Object.entries(r.bundles))n!==e&&t.addBundle(n,a.def,{data:Bn(a),meta:a.meta});return t}var ur=ne({shEntries:"uint32x4"}),xe=class r{static BUNDLE=ur;data;constructor(e){if(e.bundles.shPalette?.channels.shEntries?.format!=="uint32x4")throw new Error("Not an SH palette: no shPalette.shEntries channel");this.data=e}static strideOf(e,t){return 2**Math.ceil(Math.log2(O.texels(e,t)))}static create({codec:e,degree:t,size:n,stride:a}){let o=a??r.strideOf(e,t);if(o<O.texels(e,t))throw new Error(`Palette stride ${o} below the codec\'s ${O.texels(e,t)} texels`);let s=new Z({count:n*o,meta:{}});return s.addBundle("shPalette",ur,{meta:{codec:e,degree:t,size:n,stride:o}}),new r(s)}get meta(){return this.data.bundles.shPalette.meta}get codec(){return O.codec(this.meta.codec).name}get degree(){return this.meta.degree}get size(){return this.meta.size}get stride(){return this.meta.stride}get words(){return this.data.bundles.shPalette.channels.shEntries.data}set(e,t){O.codec(this.codec).encode(t,this.degree,this.words,e*this.stride*4)}get(e,t=new Float32Array(Ve)){return O.codec(this.codec).decode(this.words,e*this.stride*4,this.degree,t)}convert(e,{stride:t}={}){let n=r.create({codec:e,degree:this.degree,size:this.size,stride:t}),a=new Float32Array(Ve);for(let o=0;o<this.size;o+=1)n.set(o,this.get(o,a));return n}expand(e,t,n=this.codec){O.add(e,n,this.degree);let a=O.encoder(e),o=new Float32Array(Ve);for(let s=0;s<t.length;s+=1)a(s,this.get(t[s],o));return e}expanded(e,t=this.codec){let n=e.bundles.shLabel?.channels.label?.data;return n?this.expand(hr(e,"shLabel"),n.subarray(0,e.count),t):e}};var re=class r{static normalizeQuat(e,t){let n=Math.sqrt(e.x*e.x+e.y*e.y+e.z*e.z+e.w*e.w);return n>0?(t.x=e.x/n,t.y=e.y/n,t.z=e.z/n,t.w=e.w/n,t):(t.x=0,t.y=0,t.z=0,t.w=1,t)}static covFromScaleQuat(e,t,n){let{x:a,y:o,z:s,w:i}=r.normalizeQuat(t,{x:0,y:0,z:0,w:1}),c=[e.x*(1-2*(o*o+s*s)),e.x*2*(a*o+i*s),e.x*2*(a*s-i*o),e.y*2*(a*o-i*s),e.y*(1-2*(a*a+s*s)),e.y*2*(o*s+i*a),e.z*2*(a*s+i*o),e.z*2*(o*s-i*a),e.z*(1-2*(a*a+o*o))],l=(u,f)=>c[u]*c[f]+c[u+3]*c[f+3]+c[u+6]*c[f+6];return n.xx=l(0,0),n.yy=l(1,1),n.zz=l(2,2),n.xy=l(0,1),n.xz=l(0,2),n.yz=l(1,2),n}static symEigens(e){let t=[e.xx,e.xy,e.xz,e.xy,e.yy,e.yz,e.xz,e.yz,e.zz],n=[1,0,0,0,1,0,0,0,1],a=(f,d)=>f*3+d,o=1e-9*(Math.abs(e.xx)+Math.abs(e.yy)+Math.abs(e.zz));for(let f=0;f<16;f+=1){let d=0,y=1,p=Math.abs(t[a(0,1)]);if(Math.abs(t[a(0,2)])>p&&(p=Math.abs(t[a(0,2)]),y=2),Math.abs(t[a(1,2)])>p&&(p=Math.abs(t[a(1,2)]),d=1,y=2),p<=o)break;let h=.5*Math.atan2(2*t[a(d,y)],t[a(y,y)]-t[a(d,d)]),g=Math.cos(h),b=Math.sin(h);for(let x=0;x<3;x+=1){let A=t[a(x,d)],C=t[a(x,y)];t[a(x,d)]=g*A-b*C,t[a(x,y)]=b*A+g*C}for(let x=0;x<3;x+=1){let A=t[a(d,x)],C=t[a(y,x)];t[a(d,x)]=g*A-b*C,t[a(y,x)]=b*A+g*C}t[a(d,y)]=0,t[a(y,d)]=0;for(let x=0;x<3;x+=1){let A=n[a(x,d)],C=n[a(x,y)];n[a(x,d)]=g*A-b*C,n[a(x,y)]=b*A+g*C}}let s=[0,1,2].map(f=>{let d=[n[a(0,f)],n[a(1,f)],n[a(2,f)]],y=Math.max(Math.hypot(d[0],d[1],d[2]),1e-30);return{value:t[a(f,f)],vector:d.map(p=>p/y)}});s.sort((f,d)=>d.value-f.value);let[i,c,l]=s.map(f=>f.vector);return i[0]*(c[1]*l[2]-c[2]*l[1])-c[0]*(i[1]*l[2]-i[2]*l[1])+l[0]*(i[1]*c[2]-i[2]*c[1])<0&&(l[0]=-l[0],l[1]=-l[1],l[2]=-l[2]),{values:{x:s[0].value,y:s[1].value,z:s[2].value},basis:[...i,...c,...l]}}static basisToQuat(e,t){let[n,a,o,s,i,c,l,u,f]=e,d,y,p,h;if(f<=0){let b=i-n,x=1-f;if(b<=0){let A=x-b,C=.5/Math.sqrt(Math.max(A,1e-30));[d,y,p,h]=[A*C,(a+s)*C,(o+l)*C,(c-u)*C]}else{let A=x+b,C=.5/Math.sqrt(Math.max(A,1e-30));[d,y,p,h]=[(a+s)*C,A*C,(c+u)*C,(l-o)*C]}}else{let b=i+n,x=1+f;if(b<=0){let A=x-b,C=.5/Math.sqrt(Math.max(A,1e-30));[d,y,p,h]=[(o+l)*C,(c+u)*C,A*C,(a-s)*C]}else{let A=x+b,C=.5/Math.sqrt(Math.max(A,1e-30));[d,y,p,h]=[(c-u)*C,(l-o)*C,(a-s)*C,A*C]}}let g=h<0?-1:1;return r.normalizeQuat({x:d*g,y:y*g,z:p*g,w:h*g},t)}};var Er=ne({extA:"uint32x4",extB:"uint32x4"}),Ur=ne({covA:"uint32x4",covB:"uint32x4"}),vr=ne({packed:"uint32x4"}),zn=ne({node:"uint32x2"}),je={extSplats:Er,covSplats:Ur,packedSplats:vr},Mt={rgbMin:0,rgbMax:1,lnScaleMin:-12,lnScaleMax:9};function it(r,e){let t=je[e].channels,n=Object.keys(t);return n.length===Object.keys(r.channels).length&&n.every(a=>r.channels[a]?.format===t[a])}var He=r=>"extA"in r.channels,Qe=r=>"covA"in r.channels,Be=r=>T.encodeHalf(Math.log(r)),ze=r=>Math.exp(T.decodeHalf(r));function Mr(r,e,t,n,a){e[t]=n.x,e[t+1]=n.y,e[t+2]=n.z,r[t+3]=(r[t+3]&16777215|T.encodeLodOpacity(a)<<24)>>>0}function Cr(r,e,t){r[e+3]=(r[e+3]&4278190080|T.encodeOct24(t))>>>0}function ft(r,e,t){return t.x=r[e],t.y=r[e+1],t.z=r[e+2],t}function Lr(r,e,t,n,a){Mr(r,e,n,a.center,a.opacity),t[n]=T.encodeExtRgb(a.rgb),t[n+1]=(Be(a.scales.x)|Be(a.scales.y)<<16)>>>0,t[n+2]=(t[n+2]&4294901760|Be(a.scales.z))>>>0,t[n+3]=T.encodeQuatOct32(a.quaternion)}function Br(r,e,t,n){Cr(r,t,n.normal),e[t+2]=(e[t+2]&65535|T.encodeUnorm8(n.roughness)<<16|T.encodeUnorm8(n.metallic)<<24)>>>0}function zr(r,e,t,n,a){return ft(e,n,a.center),a.opacity=T.decodeLodOpacity(r[n+3]>>>24),T.decodeExtRgb(t[n],a.rgb),a.scales.x=ze(t[n+1]&65535),a.scales.y=ze(t[n+1]>>>16),a.scales.z=ze(t[n+2]&65535),T.decodeQuatOct32(t[n+3],a.quaternion),a}function Dr(r,e,t,n){return T.decodeOct24(r[t+3]&16777215,n.normal),n.roughness=(e[t+2]>>>16&255)/255,n.metallic=(e[t+2]>>>24)/255,n}function br(r,e,t,n,a){r[n+3]=0,t[n+2]=0,Lr(r,e,t,n,a),Br(r,t,n,a)}function gr(r,e,t,n,a){return zr(r,e,t,n,a),Dr(r,t,n,a),a}function Ct(r,e,t){let n=Math.max(-1,Math.min(1,r/Math.sqrt(e*t)));return n===0||!Number.isFinite(n)?0:Math.sign(n)*Math.max(-100,Math.min(-1e-7,Math.log(Math.abs(n))))}function Lt(r){return r===0?0:-Math.sign(r)*Math.exp(-Math.abs(r))}function kr(r,e,t,n,a,o,s,i){let{xx:c,yy:l,zz:u,xy:f,xz:d,yz:y}=o;Mr(r,e,n,a,i),t[n]=T.encodeExtRgb(s),t[n+1]=(Be(c)|Be(l)<<16)>>>0,t[n+2]=(Be(u)|T.encodeHalf(Ct(f,c,l))<<16)>>>0,t[n+3]=(T.encodeHalf(Ct(d,c,u))|T.encodeHalf(Ct(y,l,u))<<16)>>>0}function xr(r,e,t,n,a){r[n+3]=0,kr(r,e,t,n,a.center,a.cov,a.rgb,a.opacity),Cr(r,n,a.normal)}function Ar(r,e,t,n,a){ft(e,n,a.center),T.decodeOct24(r[n+3]&16777215,a.normal),a.opacity=T.decodeLodOpacity(r[n+3]>>>24),T.decodeExtRgb(t[n],a.rgb);let o=ze(t[n+1]&65535),s=ze(t[n+1]>>>16),i=ze(t[n+2]&65535);return a.cov.xx=o,a.cov.yy=s,a.cov.zz=i,a.cov.xy=Lt(T.decodeHalf(t[n+2]>>>16))*Math.sqrt(o*s),a.cov.xz=Lt(T.decodeHalf(t[n+3]&65535))*Math.sqrt(o*i),a.cov.yz=Lt(T.decodeHalf(t[n+3]>>>16))*Math.sqrt(s*i),a}function lt({rgbMin:r,rgbMax:e,lnScaleMin:t,lnScaleMax:n}){let a=e-r,o=(n-t)/254,s=u=>T.encodeUnorm8((u-r)/a),i=u=>u<=0?0:Math.max(1,Math.min(255,Math.round((Math.log(u)-t)/o)+1)),c=u=>r+u/255*a,l=u=>u===0?0:Math.exp(t+(u-1)*o);return{encode(u,f,d){let y=T.encodeQuatOct24(d.quaternion);u[f]=(s(d.rgb.r)|s(d.rgb.g)<<8|s(d.rgb.b)<<16|T.encodeUnorm8(d.opacity)<<24)>>>0,u[f+1]=(T.encodeHalf(d.center.x)|T.encodeHalf(d.center.y)<<16)>>>0,u[f+2]=(T.encodeHalf(d.center.z)|(y&65535)<<16)>>>0,u[f+3]=(i(d.scales.x)|i(d.scales.y)<<8|i(d.scales.z)<<16|y>>>16<<24)>>>0},decode(u,f,d){let y=u[f],p=u[f+1],h=u[f+2],g=u[f+3];return d.rgb.r=c(y&255),d.rgb.g=c(y>>>8&255),d.rgb.b=c(y>>>16&255),d.opacity=(y>>>24)/255,d.center.x=T.decodeHalf(p&65535),d.center.y=T.decodeHalf(p>>>16),d.center.z=T.decodeHalf(h&65535),d.scales.x=l(g&255),d.scales.y=l(g>>>8&255),d.scales.z=l(g>>>16&255),T.decodeQuatOct24(h>>>16|g>>>24<<16,d.quaternion),d}}}var Le=r=>{let e=r.channels.extA.data;return{a:e,f:T.floatView(e),b:r.channels.extB.data}},qe=r=>{let e=r.channels.covA.data;return{a:e,f:T.floatView(e),b:r.channels.covB.data}},Sr=r=>Object.fromEntries(Object.entries(r.channels).map(([e,t])=>[e,t.data])),wr={center:{x:0,y:0,z:0},cov:{xx:1,yy:1,zz:1,xy:0,xz:0,yz:0},rgb:{r:1,g:1,b:1},opacity:1,normal:{x:0,y:0,z:0}},H=class r{static EXT=Er;static COV=Ur;static PACKED=vr;static LOD_TREE=zn;static LAYOUTS=je;static DEFAULT_PACKED_ENCODING=Mt;static makeSplat(){return{center:{x:0,y:0,z:0},scales:{x:1,y:1,z:1},quaternion:{x:0,y:0,z:0,w:1},rgb:{r:1,g:1,b:1},opacity:1}}static makePbr(){return{normal:{x:0,y:0,z:0},roughness:1,metallic:0}}static makeExtSplat(){return{...r.makeSplat(),...r.makePbr()}}static makeCovSplat(){return{center:{x:0,y:0,z:0},cov:{xx:1,yy:1,zz:1,xy:0,xz:0,yz:0},rgb:{r:1,g:1,b:1},opacity:1,normal:{x:0,y:0,z:0}}}static packedEncodingOf(e){return{...Mt,...e.meta.encoding}}static isExt(e){return it(e,"extSplats")}static isCov(e){return it(e,"covSplats")}static isPacked(e){return it(e,"packedSplats")}static layoutOf(e){return Object.keys(je).find(t=>it(e,t))}static findBundle(e,t){let n=t!==void 0?[t]:[...Object.keys(je),...Object.keys(e)];for(let a of n){let o=e[a],s=o&&r.layoutOf(o);if(s)return{name:a,layout:s}}}static find(e,t){let n=r.findBundle(e.bundles,t);return n&&{...n,bundle:e.bundles[n.name]}}static get(e,t){let n=r.find(e,t);if(!n)throw new Error(t!==void 0?`Bundle ${t} is not a splat bundle`:"No extSplats, covSplats or packedSplats bundle");return n}static findLodTree(e){let t=e.bundles.lodTree;return t?.channels.node?.format==="uint32x2"?t:void 0}static add(e,{layout:t="extSplats",encoding:n}={}){let a=t==="packedSplats"?{encoding:{...Mt,...n}}:{};return e.addBundle(t,je[t],{meta:a}),e.bundles[t]}static make(e,{meta:t,...n}={}){let a=new Z({count:e,meta:t});return r.add(a,n),a}static convert(e,{layout:t,encoding:n}){let a=r.get(e),o=a.layout==="packedSplats"?r.packedEncodingOf(a.bundle):void 0,s=!n||t!=="packedSplats"||o!==void 0&&Object.entries(n).every(([f,d])=>o[f]===d);if(a.layout===t&&a.name===t&&s)return e;let i=new Z({count:e.count,capacity:e.capacity,meta:{...e.meta}});for(let[f,d]of Object.entries(e.bundles))f!==a.name&&i.addBundle(f,d.def,{data:Sr(d),meta:d.meta});if(a.layout===t&&s)return i.addBundle(t,a.bundle.def,{data:Sr(a.bundle),meta:a.bundle.meta}),i;let c=r.decoder(a.bundle),l=r.encoder(r.add(i,{layout:t,encoding:{...o,...n}})),u=r.makeExtSplat();for(let f=0;f<e.count;f+=1)l(f,c(f,u));return i}static encodeExt(e,t,n){let{a,f:o,b:s}=Le(e);br(a,o,s,t*4,n)}static decodeExt(e,t,n){let{a,f:o,b:s}=Le(e);return gr(a,o,s,t*4,n)}static encodeCov(e,t,n){let{a,f:o,b:s}=qe(e);xr(a,o,s,t*4,n)}static decodeCov(e,t,n){let{a,f:o,b:s}=qe(e);return Ar(a,o,s,t*4,n)}static encodePacked(e,t,n,a=r.packedEncodingOf(e)){lt(a).encode(e.channels.packed.data,t*4,n)}static decodePacked(e,t,n,a=r.packedEncodingOf(e)){return lt(a).decode(e.channels.packed.data,t*4,n)}static load(e,t,n){if(He(e)){let{a,f:o,b:s}=Le(e);return zr(a,o,s,t*4,n)}return Qe(e)?r.fromCov(r.decodeCov(e,t,wr),n):r.decodePacked(e,t,n)}static store(e,t,n){if(He(e)){let{a,f:o,b:s}=Le(e);Lr(a,o,s,t*4,n)}else if(Qe(e)){let{a,f:o,b:s}=qe(e);kr(a,o,s,t*4,n.center,re.covFromScaleQuat(n.scales,n.quaternion,wr.cov),n.rgb,n.opacity)}else r.encodePacked(e,t,n)}static loadPbr(e,t,n){return Dr(e.channels.extA.data,e.channels.extB.data,t*4,n)}static storePbr(e,t,n){Br(e.channels.extA.data,e.channels.extB.data,t*4,n)}static loadCenter(e,t,n){if(He(e))return ft(T.floatView(e.channels.extA.data),t*4,n);if(Qe(e))return ft(T.floatView(e.channels.covA.data),t*4,n);let a=e.channels.packed.data;return n.x=T.decodeHalf(a[t*4+1]&65535),n.y=T.decodeHalf(a[t*4+1]>>>16),n.z=T.decodeHalf(a[t*4+2]&65535),n}static encoder(e){if(He(e)){let{a,f:o,b:s}=Le(e);return(i,c)=>br(a,o,s,i*4,c)}if(Qe(e)){let{a,f:o,b:s}=qe(e),i=r.makeCovSplat();return(c,l)=>{r.toCov(l,i),i.normal.x=l.normal.x,i.normal.y=l.normal.y,i.normal.z=l.normal.z,xr(a,o,s,c*4,i)}}let t=e.channels.packed.data,n=lt(r.packedEncodingOf(e));return(a,o)=>n.encode(t,a*4,o)}static decoder(e){if(He(e)){let{a:o,f:s,b:i}=Le(e);return(c,l)=>gr(o,s,i,c*4,l)}let t=(o,s)=>(o.normal.x=s?.x??0,o.normal.y=s?.y??0,o.normal.z=s?.z??0,o.roughness=1,o.metallic=0,o);if(Qe(e)){let{a:o,f:s,b:i}=qe(e),c=r.makeCovSplat();return(l,u)=>(r.fromCov(Ar(o,s,i,l*4,c),u),t(u,c.normal))}let n=e.channels.packed.data,a=lt(r.packedEncodingOf(e));return(o,s)=>t(a.decode(n,o*4,s))}static toCov(e,t){return t.center.x=e.center.x,t.center.y=e.center.y,t.center.z=e.center.z,t.rgb.r=e.rgb.r,t.rgb.g=e.rgb.g,t.rgb.b=e.rgb.b,t.opacity=e.opacity,re.covFromScaleQuat(e.scales,e.quaternion,t.cov),t}static fromCov(e,t){let{values:n,basis:a}=re.symEigens(e.cov);return t.center.x=e.center.x,t.center.y=e.center.y,t.center.z=e.center.z,t.rgb.r=e.rgb.r,t.rgb.g=e.rgb.g,t.rgb.b=e.rgb.b,t.opacity=e.opacity,t.scales.x=Math.sqrt(Math.max(n.x,0)),t.scales.y=Math.sqrt(Math.max(n.y,0)),t.scales.z=Math.sqrt(Math.max(n.z,0)),re.basisToQuat(a,t.quaternion),t}};var Pr=["LDB","RDB","LUB","RUB","LDF","RDF","LUF","RUF","LFD","RFD","LFU","RFU","LBD","RBD","LBU","RBU"],Dn={R:[1,0,0],L:[-1,0,0],U:[0,1,0],D:[0,-1,0],B:[0,0,1],F:[0,0,-1]};function Rr(r){if(!Pr.includes(r))throw new Error(`Unknown coordinate system ${String(r)}`);return[...r].map(e=>Dn[e])}var kn=Array.from({length:32},(r,e)=>{let t=1-(2*e+1)/32,n=Math.sqrt(1-t*t),a=e*2.399963229728653+.5;return{x:n*Math.cos(a),y:n*Math.sin(a),z:t}});function Rn(r,e){let t=2*e+1,n=O.COEFFICIENTS[e-1],a=new Float64Array(t*t),o=new Float64Array(t*t),s=new Float64Array(O.COEFFICIENTS[O.MAX_DEGREE]),i=new Float64Array(O.COEFFICIENTS[O.MAX_DEGREE]);for(let c of kn){O.basis(c,s),O.basis({x:r[0]*c.x+r[3]*c.y+r[6]*c.z,y:r[1]*c.x+r[4]*c.y+r[7]*c.z,z:r[2]*c.x+r[5]*c.y+r[8]*c.z},i);for(let l=0;l<t;l+=1)for(let u=0;u<t;u+=1)a[l*t+u]+=s[n+l]*s[n+u],o[l*t+u]+=s[n+l]*i[n+u]}for(let c=0;c<t;c+=1){let l=c;for(let f=c+1;f<t;f+=1)Math.abs(a[f*t+c])>Math.abs(a[l*t+c])&&(l=f);for(let f=0;f<t;f+=1)[a[c*t+f],a[l*t+f]]=[a[l*t+f],a[c*t+f]],[o[c*t+f],o[l*t+f]]=[o[l*t+f],o[c*t+f]];let u=1/a[c*t+c];for(let f=0;f<t;f+=1)if(f!==c){let d=a[f*t+c]*u;for(let y=0;y<t;y+=1)a[f*t+y]-=d*a[c*t+y],o[f*t+y]-=d*o[c*t+y]}}for(let c=0;c<t;c+=1){let l=1/a[c*t+c];for(let u=0;u<t;u+=1)o[c*t+u]*=l}return o.map(c=>Math.abs(c-Math.round(c))<1e-9?Math.round(c):c)}var Bt=class{matrix;identity;det;bands=[];scratch=new Float64Array(9);constructor(e){this.matrix=e,this.identity=e.every((f,d)=>f===(d%4===0?1:0));let[t,n,a,o,s,i,c,l,u]=e;this.det=t*(s*u-i*l)-n*(o*u-i*c)+a*(o*l-s*c)}vec(e){let t=this.matrix,{x:n,y:a,z:o}=e;return e.x=t[0]*n+t[1]*a+t[2]*o,e.y=t[3]*n+t[4]*a+t[5]*o,e.z=t[6]*n+t[7]*a+t[8]*o,e}quat(e){let t=this.matrix,n=this.det,{x:a,y:o,z:s}=e;return e.x=n*(t[0]*a+t[1]*o+t[2]*s),e.y=n*(t[3]*a+t[4]*o+t[5]*s),e.z=n*(t[6]*a+t[7]*o+t[8]*s),e}scales(e){let t=this.matrix,{x:n,y:a,z:o}=e;return e.x=Math.abs(t[0])*n+Math.abs(t[1])*a+Math.abs(t[2])*o,e.y=Math.abs(t[3])*n+Math.abs(t[4])*a+Math.abs(t[5])*o,e.z=Math.abs(t[6])*n+Math.abs(t[7])*a+Math.abs(t[8])*o,e}cov(e){let t=this.matrix,n=[e.xx,e.xy,e.xz,e.xy,e.yy,e.yz,e.xz,e.yz,e.zz],a=this.scratch;for(let s=0;s<3;s+=1)for(let i=0;i<3;i+=1)a[s*3+i]=t[s*3]*n[i]+t[s*3+1]*n[3+i]+t[s*3+2]*n[6+i];let o=(s,i)=>a[s*3]*t[i*3]+a[s*3+1]*t[i*3+1]+a[s*3+2]*t[i*3+2];return e.xx=o(0,0),e.yy=o(1,1),e.zz=o(2,2),e.xy=o(0,1),e.xz=o(0,2),e.yz=o(1,2),e}splat(e){return this.vec(e.center),this.quat(e.quaternion),this.scales(e.scales),"normal"in e&&this.vec(e.normal),e}sh(e,t){if(this.identity)return e;let n=this.scratch;for(let a=1;a<=t;a+=1){let o=this.bands[a]??=Rn(this.matrix,a),s=2*a+1,i=O.COEFFICIENTS[a-1];for(let c=0;c<3;c+=1){for(let l=0;l<s;l+=1){let u=0;for(let f=0;f<s;f+=1)u+=o[l*s+f]*e[(i+f)*3+c];n[l]=u}for(let l=0;l<s;l+=1)e[(i+l)*3+c]=n[l]}}return e}},pe=class r{static SYSTEMS=Pr;static matrix(e,t){let n=Rr(e),a=Rr(t),o=[];for(let s=0;s<3;s+=1)for(let i=0;i<3;i+=1)o.push(a[s][0]*n[i][0]+a[s][1]*n[i][1]+a[s][2]*n[i][2]);return o}static converter(e,t){return new Bt(r.matrix(e,t))}static convert(e,t,{from:n=e.meta.coordinateSystem,shPalette:a,progress:o}={}){if(!n)throw new Error("Axes.convert: the data\'s coordinate system is unknown (pass `from`)");let s=r.converter(n,t);if(!s.identity){let{bundle:i}=H.get(e),c=O.find(e.bundles),l=c&&O.decoder(e,c),u=c&&O.encoder(e,c),f=new Float32Array(O.VALUES),d=ae(o,e.count,"encoding");if(H.isCov(i)){let y=H.makeCovSplat();for(let p=0;p<e.count;p+=1)d(p),H.decodeCov(i,p,y),s.vec(y.center),s.cov(y.cov),s.vec(y.normal),H.encodeCov(i,p,y)}else{let y=H.decoder(i),p=H.encoder(i),h=H.makeExtSplat();for(let g=0;g<e.count;g+=1)d(g),p(g,s.splat(y(g,h)))}if(c)for(let y=0;y<e.count;y+=1)u(y,s.sh(l(y,f),c.degree));if(a)for(let y=0;y<a.size;y+=1)a.set(y,s.sh(a.get(y,f),a.degree))}return e.meta.coordinateSystem=t,e}};function Tr(r,e){if(r.byteLength%e!==0)throw new Error("Data length must be divisible by the byte stride");let t=new Uint8Array(r.byteLength),n=0;for(let a=0;a<e;a+=1)for(let o=a;o<r.byteLength;o+=e)t[n++]=r[o];return t}async function Ae(r,e){let t=new Blob([r]).stream().pipeThrough(e);return new Uint8Array(await new Response(t).arrayBuffer())}var De=class{position=0;chunks=[];head=0;offset=0;buffered=0;reader;done=!1;label;constructor(e,t="Data"){if(this.label=t,e instanceof ReadableStream){this.reader=e.getReader();return}let n=e instanceof ArrayBuffer?new Uint8Array(e):e;n.byteLength>0&&this.chunks.push(n),this.buffered=n.byteLength,this.done=!0}async fill(e){for(;this.buffered<e&&!this.done;){let{done:t,value:n}=await this.reader.read();t?this.done=!0:n.byteLength>0&&(this.chunks.push(n),this.buffered+=n.byteLength)}return this.buffered}take(e,t){let n=this.chunks[this.head],a;if(e===0)a=new Uint8Array(0);else if(n.byteLength-this.offset>=e)a=n.subarray(this.offset,this.offset+e);else{a=new Uint8Array(e);let o=0;for(let s=this.head,i=this.offset;o<e;s+=1,i=0){let c=this.chunks[s].subarray(i,i+e-o);a.set(c,o),o+=c.byteLength}}return t&&this.drop(e),a}drop(e){for(this.position+=e,this.buffered-=e;e>0;){let t=this.chunks[this.head].byteLength-this.offset;if(e<t){this.offset+=e;break}e-=t,this.head+=1,this.offset=0}this.head>64&&this.head*2>this.chunks.length&&(this.chunks=this.chunks.slice(this.head),this.head=0)}async read(e){if(await this.fill(e)<e)throw new Error(`${this.label} ended unexpectedly`);return this.take(e,!0)}async peek(e){return this.take(Math.min(e,await this.fill(e)),!1)}async skip(e){for(;e>0;){let t=await this.fill(1);if(t===0)throw new Error(`${this.label} ended unexpectedly`);let n=Math.min(e,t);this.drop(n),e-=n}}async rest(){return this.take(await this.fill(1/0),!0)}async atEnd(){return await this.fill(1)===0}stream(){return new ReadableStream({pull:async e=>{if(await this.fill(1)===0){e.close();return}e.enqueue(this.take(this.chunks[this.head].byteLength-this.offset,!0))},cancel:()=>this.cancel()})}cancel(){this.reader?.cancel().catch(()=>{}),this.done=!0,this.chunks=[],this.head=0,this.buffered=0,this.offset=0}},se=class{static gzip(e){return Ae(e,new CompressionStream("gzip"))}static gunzip(e){return Ae(e,new DecompressionStream("gzip"))}static async readBytes(e){return e instanceof ArrayBuffer?new Uint8Array(e):e instanceof Uint8Array?e:new Uint8Array(await new Response(e).arrayBuffer())}static async compressTransposed(e,t){let n=new Uint8Array(e.buffer,e.byteOffset,e.byteLength);return Ae(Tr(n,t),new CompressionStream("gzip"))}static async decompressTransposed(e,t){let n=await Ae(e,new DecompressionStream("gzip"));if(n.byteLength%t!==0)throw new Error("Decompressed length must be divisible by the element size");return n.byteLength===0?n:Tr(n,n.byteLength/t)}};var me=.28209479177387814,Pn=64*1024,zt=.001,Re=256,ke=["min_x","min_y","min_z","max_x","max_y","max_z","min_scale_x","min_scale_y","min_scale_z","max_scale_x","max_scale_y","max_scale_z","min_r","min_g","min_b","max_r","max_g","max_b"],Ke=["packed_position","packed_rotation","packed_scale","packed_color"],Or=12,Tn=[0,0,0,1,1,1],Rt={char:{bytes:1,scale:127},uchar:{bytes:1,scale:255},short:{bytes:2,scale:32767},ushort:{bytes:2,scale:65535},int:{bytes:4,scale:2147483647},uint:{bytes:4,scale:4294967295},float:{bytes:4,scale:1},double:{bytes:8,scale:1}};async function On(r,{progress:e,sh:t,...n}={}){let a=await se.readBytes(r),o=Nn(a),{headerLength:s,littleEndian:i,elements:c,comments:l}=o,u=c.find($=>$.name==="vertex");if(!u)throw new Error("PLY has no vertex element");let f=$=>u.properties.find(S=>S.name===$&&!S.countType),d=$=>f($)!==void 0,y=c.find($=>$.name==="chunk");if(y&&Ke.every(d))return{splats:Fn({bytes:a,header:o,vertex:u,chunk:y,target:n,sh:t,progress:e})};let p=["x","y","z","scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3","opacity","f_dc_0","f_dc_1","f_dc_2"],h=["x","y","z","red","green","blue"],g=p.every(d);if(!g&&!h.every(d))throw new Error(`PLY vertex lacks ${(p.some(d)?p:h).filter($=>!d($)).join(", ")}`);if(u.properties.some($=>$.countType))throw new Error("PLY vertex list properties are not supported");let b=0;for(;d(`f_rest_${b}`);)b+=1;let x=d("nx")&&d("ny")&&d("nz"),A=f("metallic")??f("metalness"),C=f("roughness"),B=new Z({count:u.count,meta:{format:"ply",comments:l}}),w=H.encoder(H.add(B,n)),_=_r(b),D=O.prepare(B,_,t),E=ut(a,s,c,u),R=new DataView(a.buffer,a.byteOffset,a.byteLength),m=($,S=!1)=>$&&kt(R,$,i,S),v=($,S=!1)=>m(f($),S),[M,z,k]=[v("x"),v("y"),v("z")],P=x?[v("nx"),v("ny"),v("nz")]:void 0,L=m(A,!0),Q=m(C,!0),U=g?["scale_0","scale_1","scale_2"].map($=>v($)):[],I=g?["rot_1","rot_2","rot_3","rot_0"].map($=>v($)):[],N=g?v("opacity"):m(f("alpha"),!0),K=g?["f_dc_0","f_dc_1","f_dc_2"].map($=>v($)):["red","green","blue"].map($=>v($,!0)),W=b/3,V=O.COEFFICIENTS[_]*3,j=Array.from({length:V},($,S)=>v(`f_rest_${S%3*W+Math.floor(S/3)}`)),Y=new Float32Array(O.VALUES),F=H.makeExtSplat(),G={x:0,y:0,z:0,w:1},X=ae(e,u.count,"decoding");for(let $=0;$<u.count;$+=1){X($);let S=E+$*u.recordSize;if(F.center.x=M(S),F.center.y=z(S),F.center.z=k(S),F.normal.x=P?P[0](S):0,F.normal.y=P?P[1](S):0,F.normal.z=P?P[2](S):0,F.roughness=Q?Q(S):1,F.metallic=L?L(S):0,g?(F.scales.x=Math.exp(U[0](S)),F.scales.y=Math.exp(U[1](S)),F.scales.z=Math.exp(U[2](S)),G.x=I[0](S),G.y=I[1](S),G.z=I[2](S),G.w=I[3](S),re.normalizeQuat(G,F.quaternion),F.opacity=1/(1+Math.exp(-N(S))),F.rgb.r=.5+me*K[0](S),F.rgb.g=.5+me*K[1](S),F.rgb.b=.5+me*K[2](S)):(F.scales.x=zt,F.scales.y=zt,F.scales.z=zt,F.opacity=N?N(S):1,F.rgb.r=K[0](S),F.rgb.g=K[1](S),F.rgb.b=K[2](S)),w($,F),D){for(let q=0;q<V;q+=1)Y[q]=j[q](S);D($,Y)}}return{splats:B}}function Fn({bytes:r,header:{headerLength:e,littleEndian:t,elements:n,comments:a},vertex:o,chunk:s,target:i,sh:c,progress:l}){for(let U of[s,o])if(U.properties.some(I=>I.countType))throw new Error(`PLY ${U.name} list properties are not supported`);let u=U=>s.properties.find(I=>I.name===U),f=ke.slice(0,Or).filter(U=>!u(U));if(f.length>0)throw new Error(`PLY chunk lacks ${f.join(", ")}`);let d=Math.ceil(o.count/Re);if(s.count<d)throw new Error(`PLY has ${s.count} chunks for ${o.count} splats`);let y=new DataView(r.buffer,r.byteOffset,r.byteLength),p=ke.length,h=new Float32Array(d*p),g=ut(r,e,n,s);ke.forEach((U,I)=>{let N=u(U),K=N&&kt(y,N,t);for(let W=0;W<d;W+=1)h[W*p+I]=K?K(g+W*s.recordSize):Tn[I-Or]});let b=n.find(U=>U.name==="sh"),x=0;for(;b?.properties.some(U=>U.name===`f_rest_${x}`);)x+=1;let A=new Z({count:o.count,meta:{format:"ply",compressed:!0,comments:a}}),C=H.encoder(H.add(A,i)),B=_r(x),w=O.prepare(A,b&&b.count>=o.count?B:0,c),_=O.COEFFICIENTS[B]*3,D=b&&w?ut(r,e,n,b):0,E=Uint8Array.from({length:_},(U,I)=>b.properties.find(N=>N.name===`f_rest_${I%3*(x/3)+Math.floor(I/3)}`)?.offset??0),R=new Float32Array(O.VALUES),m=ut(r,e,n,o),[v,M,z,k]=Ke.map(U=>kt(y,o.properties.find(I=>I.name===U),t)),P=H.makeExtSplat(),L={x:0,y:0,z:0,w:1},Q=ae(l,o.count,"decoding");for(let U=0;U<o.count;U+=1){Q(U);let I=m+U*o.recordSize,N=Math.floor(U/Re)*p,K=v(I);P.center.x=h[N]+(h[N+3]-h[N])*((K>>>21&2047)/2047),P.center.y=h[N+1]+(h[N+4]-h[N+1])*((K>>>11&1023)/1023),P.center.z=h[N+2]+(h[N+5]-h[N+2])*((K&2047)/2047);let W=z(I);P.scales.x=Math.exp(h[N+6]+(h[N+9]-h[N+6])*((W>>>21&2047)/2047)),P.scales.y=Math.exp(h[N+7]+(h[N+10]-h[N+7])*((W>>>11&1023)/1023)),P.scales.z=Math.exp(h[N+8]+(h[N+11]-h[N+8])*((W&2047)/2047));let V=M(I),j=((V>>>20&1023)/1023-.5)*Math.SQRT2,Y=((V>>>10&1023)/1023-.5)*Math.SQRT2,F=((V&1023)/1023-.5)*Math.SQRT2,G=Math.sqrt(Math.max(0,1-j*j-Y*Y-F*F)),X=V>>>30;L.w=X===0?G:j,L.x=X===0?j:X===1?G:Y,L.y=X<=1?Y:X===2?G:F,L.z=X<=2?F:G,re.normalizeQuat(L,P.quaternion);let $=k(I);if(P.rgb.r=h[N+12]+(h[N+15]-h[N+12])*(($>>>24&255)/255),P.rgb.g=h[N+13]+(h[N+16]-h[N+13])*(($>>>16&255)/255),P.rgb.b=h[N+14]+(h[N+17]-h[N+14])*(($>>>8&255)/255),P.opacity=($&255)/255,C(U,P),w){let S=D+U*b.recordSize;for(let q=0;q<_;q+=1)R[q]=In[r[S+E[q]]];w(U,R)}}return A}function _n(r){return((r===0?0:r===255?1:(r+.5)/256)-.5)*8}var In=Float64Array.from({length:256},(r,e)=>_n(e));function Fr(r){return Math.max(0,Math.min(255,Math.trunc((r/8+.5)*256)))}function $n(r,{pbr:e=!1,compatibility:t=!1,sh:n=!0,progress:a}={}){let o=H.decoder(H.get(r).bundle),s=n?O.find(r.bundles):void 0,i=s&&O.decoder(r,s),c=s?O.COEFFICIENTS[s.degree]:0,l=new Float32Array(O.VALUES),u=e||t,f=["x","y","z",...u?["nx","ny","nz"]:[],"scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3","opacity","f_dc_0","f_dc_1","f_dc_2",...Array.from({length:c*3},(C,B)=>`f_rest_${B}`),...e?["roughness","metallic"]:[]],d=new TextEncoder().encode(["ply","format binary_little_endian 1.0",`element vertex ${r.count}`,...f.map(C=>`property float ${C}`),"end_header",""].join(`\n`)),y=new Uint8Array(d.byteLength+r.count*f.length*4);y.set(d);let p=new DataView(y.buffer,d.byteLength),h=H.makeExtSplat(),g={x:0,y:0,z:0,w:1},b=0,x=C=>{p.setFloat32(b,C,!0),b+=4},A=ae(a,r.count,"encoding");for(let C=0;C<r.count;C+=1){A(C),o(C,h),x(h.center.x),x(h.center.y),x(h.center.z),u&&(x(e?h.normal.x:0),x(e?h.normal.y:0),x(e?h.normal.z:0)),x(Math.log(Math.max(h.scales.x,1e-12))),x(Math.log(Math.max(h.scales.y,1e-12))),x(Math.log(Math.max(h.scales.z,1e-12))),re.normalizeQuat(h.quaternion,g),x(g.w),x(g.x),x(g.y),x(g.z);let B=Math.max(1e-12,Math.min(1-1e-12,h.opacity));if(x(Math.max(-100,Math.min(100,Math.log(B/(1-B))))),x((h.rgb.r-.5)/me),x((h.rgb.g-.5)/me),x((h.rgb.b-.5)/me),i){i(C,l);for(let w=0;w<3;w+=1)for(let _=0;_<c;_+=1)x(l[_*3+w])}e&&(x(h.roughness),x(h.metallic))}return y}var he=class{static read=On;static write=$n};function Nn(r){let e=new TextDecoder().decode(r.subarray(0,Math.min(r.byteLength,Pn))),t=e.search(/end_header\\r?\\n/);if(!e.startsWith("ply")||t<0)throw new Error("Invalid PLY header");let n=new TextEncoder().encode(e.slice(0,t)).byteLength+e.slice(t).match(/end_header\\r?\\n/)[0].length,a,o=[],s=[];for(let i of e.slice(0,t).split(/\\r?\\n/).slice(1)){let c=i.trim().split(/\\s+/);if(c[0]==="format"){if(c[1]!=="binary_little_endian"&&c[1]!=="binary_big_endian")throw new Error(`Unsupported PLY format ${c[1]}`);a=c[1]==="binary_little_endian"}else if(c[0]==="comment")s.push(i.trim().slice(8));else if(c[0]==="element")o.push({name:c[1],count:Number.parseInt(c[2],10),properties:[],recordSize:0});else if(c[0]==="property"){let l=o.at(-1);if(!l)throw new Error("PLY property outside an element");if(c[1]==="list")l.properties.push({name:c[4],type:Dt(c[3]),countType:Dt(c[2]),offset:-1});else{let u=Dt(c[1]);l.properties.push({name:c[2],type:u,offset:l.recordSize}),l.recordSize+=Rt[u].bytes}}}if(a===void 0)throw new Error("PLY header has no format line");return{headerLength:n,littleEndian:a,elements:o,comments:s}}function Dt(r){let t={int8:"char",uint8:"uchar",int16:"short",uint16:"ushort",int32:"int",uint32:"uint",float32:"float",float64:"double"}[r]??r;if(!Rt[t])throw new Error(`Unsupported PLY property type ${r}`);return t}function _r(r){return r>=72?4:r>=45?3:r>=24?2:r>0?1:0}function ut(r,e,t,n){let a=e;for(let o of t){if(o===n)break;if(o.properties.some(s=>s.countType))throw new Error(`PLY element ${o.name} before ${n.name} has list properties`);a+=o.count*o.recordSize}if(a+n.count*n.recordSize>r.byteLength)throw new Error("PLY file ended unexpectedly");return a}function kt(r,{offset:e,type:t},n,a=!1){if(t==="float")return s=>r.getFloat32(s+e,n);if(t==="uint"&&!a)return s=>r.getUint32(s+e,n);let o=a?Rt[t].scale:1;return s=>Vn(r,s+e,t,n)/o}function Vn(r,e,t,n){switch(t){case"char":return r.getInt8(e);case"uchar":return r.getUint8(e);case"short":return r.getInt16(e,n);case"ushort":return r.getUint16(e,n);case"int":return r.getInt32(e,n);case"uint":return r.getUint32(e,n);case"float":return r.getFloat32(e,n);case"double":return r.getFloat64(e,n)}}var Hn=2139095040,Ir=new Float32Array(1),Qn=new Uint32Array(Ir.buffer),Pt=new Uint32Array(65536),$r=new Uint32Array(65536),Pe=new Uint32Array(0),Ye=new Uint16Array(0),Se=class r{static KEY16_LO=95<<23;static KEY16_HI=(159<<23)-1;static KEYS=ne({key:"unorm8x4"},{serialize:!1});static invalid(e){return 2**e-1}static validMax(e){return 255*2**(e-8)-1}static compute(e,t){let n=r.invalid(t);Ir[0]=e;let a=Qn[0];if(!(a<Hn))return n;let o=t===32?a:t===24?a>>>7:Math.min(Math.max(a,r.KEY16_LO),r.KEY16_HI)-r.KEY16_LO>>>13;return Math.min((n^o)>>>0,r.validMax(t))}static sort({keys:e,count:t,bits:n,ordering:a=new Uint32Array(ie.alignCapacity(t))}){if(a.length<t)throw new Error(`SortKeys.sort: ordering holds ${a.length} of ${t} indices`);Pe.length<t&&(Pe=new Uint32Array(t),Ye=new Uint16Array(t));let o=n===16?qn(e,t,a):n===24?jn(e,t,a):Kn(e,t,a);return{ordering:a,visible:o}}};function Ze(r,e){let t=0;for(let n=0;n<=e;n+=1){let a=r[n];r[n]=t,t+=a}}function qn(r,e,t){let n=Pt;n.fill(0);for(let o=0;o<e;o+=1)n[r[o]&65535]+=1;let a=e-n[65535];Ze(n,65535);for(let o=0;o<e;o+=1)t[n[r[o]&65535]++]=o;return a}function jn(r,e,t){let n=Pt,a=$r;n.fill(0,0,2048),a.fill(0,0,8192);for(let s=0;s<e;s+=1){let i=r[s];n[i&2047]+=1,a[i>>>11]+=1}let o=e-a[8191];Ze(n,2047),Ze(a,8191);for(let s=0;s<e;s+=1){let i=r[s],c=n[i&2047]++;Pe[c]=s,Ye[c]=i>>>11}for(let s=0;s<e;s+=1)t[a[Ye[s]]++]=Pe[s];return o}function Kn(r,e,t){let n=Pt,a=$r;n.fill(0),a.fill(0);for(let s=0;s<e;s+=1){let i=r[s];n[i&65535]+=1,a[i>>>16]+=1}let o=e-a[65535];Ze(n,65535),Ze(a,65535);for(let s=0;s<e;s+=1){let i=r[s],c=n[i&65535]++;Pe[c]=s,Ye[c]=i>>>16}for(let s=0;s<e;s+=1)t[a[Ye[s]]++]=Pe[s];return o}var we=14,Nr=20;function Yn(r,{sort:e=!0,sh:t=!0,progress:n}={}){let{count:a}=r,o=H.decoder(H.get(r).bundle),s=t?O.find(r.bundles):void 0,i=s&&O.decoder(r,s),c=s?O.COEFFICIENTS[Math.min(s.degree,3)]:0,l=c*3,u=ae(n,2*a,"encoding"),f=new Float32Array(a*we),d=H.makeExtSplat(),y={x:0,y:0,z:0,w:1};for(let D=0;D<a;D+=1){u(D),o(D,d),re.normalizeQuat(d.quaternion,y);let E=D*we;f[E]=d.center.x,f[E+1]=d.center.y,f[E+2]=d.center.z,f[E+3]=Tt(d.scales.x),f[E+4]=Tt(d.scales.y),f[E+5]=Tt(d.scales.z),f[E+6]=y.w,f[E+7]=y.x,f[E+8]=y.y,f[E+9]=y.z,f[E+10]=d.rgb.r,f[E+11]=d.rgb.g,f[E+12]=d.rgb.b,f[E+13]=d.opacity}let p=e?Gn(f,a):void 0,h=Math.ceil(a/Re),g=new TextEncoder().encode(["ply","format binary_little_endian 1.0","comment Generated by Radix",`element chunk ${h}`,...ke.map(D=>`property float ${D}`),`element vertex ${a}`,...Ke.map(D=>`property uint ${D}`),...l>0?[`element sh ${a}`,...Array.from({length:l},(D,E)=>`property uchar f_rest_${E}`)]:[],"end_header",""].join(`\n`)),b=ke.length,x=g.byteLength+h*b*4,A=x+a*Ke.length*4,C=new Uint8Array(A+a*l);C.set(g);let B=new DataView(C.buffer),w=new Float32Array(b),_=(D,E)=>{w[D]=Math.min(w[D],E),w[D+3]=Math.max(w[D+3],E)};for(let D=0;D<h;D+=1){let E=D*Re,R=Math.min(a,E+Re);for(let m=0;m<b;m+=6)w.fill(1/0,m,m+3),w.fill(-1/0,m+3,m+6);for(let m=E;m<R;m+=1){let v=(p?p[m]:m)*we;for(let M=0;M<3;M+=1)_(M,f[v+M]),_(6+M,f[v+3+M]),_(12+M,f[v+10+M])}for(let m=0;m<b;m+=1)B.setFloat32(g.byteLength+(D*b+m)*4,w[m],!0);for(let m=E;m<R;m+=1){u(a+m);let v=(p?p[m]:m)*we,M=x+m*16;B.setUint32(M,Vr(f,v,w,0),!0),B.setUint32(M+4,Wn(f,v+6),!0),B.setUint32(M+8,Vr(f,v+3,w,6),!0),B.setUint32(M+12,Zn(f,v+10,w),!0)}}if(i){let D=new Float32Array(O.VALUES);for(let E=0;E<a;E+=1){i(p?p[E]:E,D);let R=A+E*l;for(let m=0;m<3;m+=1)for(let v=0;v<c;v+=1)C[R+m*c+v]=Fr(D[v*3+m])}}return C}var We=class{static read=he.read;static write=Yn};function Tt(r){return Math.max(-Nr,Math.min(Nr,Math.log(r)))}function be(r,e,t,n){let a=2**n-1,o=t>e?(r-e)/(t-e):0;return Math.max(0,Math.min(a,Math.floor(o*a+.5)))}function Vr(r,e,t,n){return be(r[e],t[n],t[n+3],11)*2**21+be(r[e+1],t[n+1],t[n+4],10)*2**11+be(r[e+2],t[n+2],t[n+5],11)}function Zn(r,e,t){return be(r[e],t[12],t[15],8)*2**24+be(r[e+1],t[13],t[16],8)*2**16+be(r[e+2],t[14],t[17],8)*2**8+be(r[e+3],0,1,8)}function Wn(r,e){let t=0;for(let o=1;o<4;o+=1)Math.abs(r[e+o])>Math.abs(r[e+t])&&(t=o);let n=r[e+t]<0?-1:1,a=t;for(let o=0;o<4;o+=1)o!==t&&(a=a*1024+be(n*r[e+o]*Math.SQRT1_2+.5,0,1,10));return a}function Gn(r,e){let t=[1/0,1/0,1/0],n=[-1/0,-1/0,-1/0];for(let s=0;s<e;s+=1)for(let i=0;i<3;i+=1)t[i]=Math.min(t[i],r[s*we+i]),n[i]=Math.max(n[i],r[s*we+i]);let a=(s,i)=>n[i]>t[i]?Math.min(1023,Math.floor(1024*(s-t[i])/(n[i]-t[i]))):0,o=new Uint32Array(e);for(let s=0;s<e;s+=1){let i=s*we;o[s]=(Ot(a(r[i+2],2))<<2|Ot(a(r[i+1],1))<<1|Ot(a(r[i],0)))>>>0}return Se.sort({keys:o,count:e,bits:32}).ordering}function Ot(r){let e=(r^r<<16)&4278190335;return e=(e^e<<8)&50393103,e=(e^e<<4)&51130563,(e^e<<2)&153391689}var Te=[["sh1",9],["sh2",15],["sh3",21]],yt=809779538,Ge=1128546642,Xn=65536,Ft=T.decodeHalf,Ee=r=>r+7&-8;async function Jn(r,{progress:e,sh:t,...n}={}){let a=await se.readBytes(r),o=new DataView(a.buffer,a.byteOffset,a.byteLength),s=(B,w)=>JSON.parse(new TextDecoder().decode(a.subarray(B,B+w))),i=o.getUint32(0,!0),c=s(8,o.getUint32(4,!0)),l;if(i===yt){if(c.version!==1||c.type!=="gsplat")throw new Error(`Unsupported RAD version ${String(c.version)} or type ${String(c.type)}`);let B=8+Ee(o.getUint32(4,!0));l=c.chunks.map(w=>{if(w.filename)throw new Error("RAD external chunk files are not supported");return{at:B+w.offset,standalone:!1}})}else if(i===Ge)l=[{at:0,standalone:!0}];else throw new Error(`Invalid RAD magic 0x${i.toString(16)}`);let u=c.count,f=(c.lodTree??c.lod_tree)===!0,d=Number(c.maxSh??c.max_sh??0),y=Number(c.shCodeCount??c.sh_code_count??0),p=new Z({count:u,meta:{format:"rad"}}),h=H.encoder(H.add(p,n)),g,b;y>0&&t!==!1&&d>=1&&d<=3?(p.meta.ignoredShDegree=0,g={palette:xe.create({codec:t??"ext",degree:d,size:y}),labels:new Uint32Array(u),read:!1}):b=O.prepare(p,d,t);let x=f?p.addBundle("lodTree",H.LOD_TREE).bundles.lodTree.channels.node.data:void 0;for(let[B,{at:w,standalone:_}]of l.entries()){if(e?.(B/l.length,"decoding"),o.getUint32(w,!0)!==Ge)throw new Error("Invalid RAD chunk");let D=o.getUint32(w+4,!0),E=s(w+8,D),R={base:_?0:E.base,count:E.count,payloadBytes:E.payloadBytes??E.payload_bytes,lodTree:(E.lodTree??E.lod_tree)===!0,properties:E.properties},m=w+8+Ee(D)+8;await ea(R,a.subarray(m,m+R.payloadBytes),h,x,b&&{encode:b,degree:d},g)}if(e?.(1,"decoding"),!g)return{splats:p};let{palette:A,labels:C}=g;if(!g.read)throw new Error("RAD file with shCodeCount misses sh1_code");for(let B=0;B<u;B+=1)if(C[B]>=A.size)throw new Error(`RAD sh_label ${C[B]} past shCodeCount ${A.size}`);return A.size>65536?(A.expand(p,C),{splats:p}):(p.addBundle("shLabel",O.LABEL).bundles.shLabel.channels.label.data.set(C),{splats:p,shPalette:A})}async function ea(r,e,t,n,a,o){let s=r.count,i={},c={};for(let b of r.properties){let x=e.subarray(b.offset,b.offset+b.bytes);switch(b.compression&&(x=await aa(x)),b.property){case"center":case"alpha":case"rgb":case"scales":i[b.property]=dt(b,x,b.property==="alpha"?1:3,s);break;case"orientation":i.orientation=na(b,x,s);break;case"child_count":case"child_start":i[b.property]=Qr(b,x,s);break;case"sh1":case"sh2":case"sh3":a&&(i[b.property]=dt(b,x,Te.find(([A])=>A===b.property)[1],s));break;case"sh1_code":case"sh2_code":case"sh3_code":if(o){let A=b.property.slice(0,3);c[A]=dt(b,x,Te.find(([C])=>C===A)[1],o.palette.size)}break;case"sh_label":o&&o.labels.set(Qr(b,x,s),r.base);break}}for(let b of["center","alpha","rgb","scales","orientation"])if(s>0&&!i[b])throw new Error(`RAD chunk misses ${b}`);let{center:l,alpha:u,rgb:f,scales:d,orientation:y,child_count:p,child_start:h}=i,g=H.makeExtSplat();for(let b=0;b<s;b+=1)g.center.x=l[b*3],g.center.y=l[b*3+1],g.center.z=l[b*3+2],g.opacity=u[b],g.rgb.r=f[b*3],g.rgb.g=f[b*3+1],g.rgb.b=f[b*3+2],g.scales.x=d[b*3],g.scales.y=d[b*3+1],g.scales.z=d[b*3+2],g.quaternion.x=y[b*4],g.quaternion.y=y[b*4+1],g.quaternion.z=y[b*4+2],g.quaternion.w=y[b*4+3],t(r.base+b,g);if(a&&Hr(s,a.degree,i,(b,x)=>a.encode(r.base+b,x)),o&&c.sh1){let{palette:b}=o;Hr(b.size,b.degree,c,(x,A)=>b.set(x,A)),o.read=!0}if(n&&r.lodTree){if(!p||!h)throw new Error("RAD chunk misses child_count or child_start");for(let b=0;b<s;b+=1)n[(r.base+b)*2]=p[b],n[(r.base+b)*2+1]=h[b]}}function Hr(r,e,t,n){let a=new Float32Array(O.VALUES),o=Te.slice(0,e).map(([s,i])=>({values:i,column:t[s]}));for(let s=0;s<r;s+=1){let i=0;for(let c=0;c<o.length;c+=1){let{values:l,column:u}=o[c];for(let f=0;f<l;f+=1)a[i+f]=u?u[s*l+f]:0;i+=l}n(s,a)}}var qr=new Float32Array(1),ta=new Uint32Array(qr.buffer),ra=r=>(ta[0]=r,qr[0]);function dt(r,e,t,n){let a=new Float32Array(t*n),o=new DataView(e.buffer,e.byteOffset,e.byteLength),s=t*n,i=r.min??0,c=r.max??1,l=u=>(u<<24>>24)/127*c;for(let u=0;u<t;u+=1){let f=0;for(let d=0;d<n;d+=1){let y=u*n+d,p;switch(r.encoding){case"f32":p=o.getFloat32(y*4,!0);break;case"f16":p=Ft(o.getUint16(y*2,!0));break;case"f32_lebytes":p=ra((e[y]|e[y+s]<<8|e[y+s*2]<<16|e[y+s*3]<<24)>>>0);break;case"f16_lebytes":p=Ft(e[y]|e[y+s]<<8);break;case"r8":p=e[y]/255*(c-i)+i;break;case"r8_delta":f=f+e[y]&255,p=f/255*(c-i)+i;break;case"s8":p=l(e[y]);break;case"s8_delta":f=f+e[y]&255,p=l(f);break;case"ln_0r8":p=e[y]===0?0:Math.exp(i+(e[y]-1)*((c-i)/254));break;case"ln_f16":p=Math.exp(Ft(o.getUint16(y*2,!0)));break;default:throw new Error(`Unsupported RAD ${r.property} encoding ${r.encoding}`)}a[d*t+u]=p}}return a}function na(r,e,t){let n=new Float32Array(t*4);if(r.encoding==="oct88r8"){let o={x:0,y:0,z:0};for(let s=0;s<t;s+=1){let i=e[s*3]|e[s*3+1]<<8;i===0?Object.assign(o,{x:0,y:0,z:-1}):T.decodeOct(i,8,o);let c=e[s*3+2]/255*Math.PI,l=Math.sin(c/2);n[s*4]=o.x*l,n[s*4+1]=o.y*l,n[s*4+2]=o.z*l,n[s*4+3]=Math.cos(c/2)}return n}let a=dt(r,e,3,t);for(let o=0;o<t;o+=1){let s=a[o*3],i=a[o*3+1],c=a[o*3+2];n[o*4]=s,n[o*4+1]=i,n[o*4+2]=c,n[o*4+3]=Math.sqrt(Math.max(0,1-s*s-i*i-c*c))}return n}function Qr(r,e,t){if(r.encoding!=="u16"&&r.encoding!=="u32")throw new Error(`Unsupported RAD ${r.property} encoding ${r.encoding}`);let n=new DataView(e.buffer,e.byteOffset,e.byteLength),a=new Uint32Array(t);for(let o=0;o<t;o+=1)a[o]=r.encoding==="u16"?n.getUint16(o*2,!0):n.getUint32(o*4,!0);return a}async function aa(r){for(let e of["deflate","deflate-raw","gzip"])try{let t=new Blob([r.slice()]).stream().pipeThrough(new DecompressionStream(e));return new Uint8Array(await new Response(t).arrayBuffer())}catch{}return r}var Oe=class{static read=Jn;static write=oa},le=r=>new Uint8Array(r.buffer,r.byteOffset,r.byteLength);async function oa(r,{chunkSize:e=Xn,sh:t=!0,radSh:n="s8",shPalette:a,progress:o}={}){let s=H.decoder(H.get(r).bundle),i=H.findLodTree(r),c=t&&a?r.bundles.shLabel?.channels.label?.data:void 0,l=t&&!c?O.find(r.bundles):void 0,u=l&&O.decoder(r,l),f=Math.min(c?a.degree:l?.degree??0,3),d=[0,0,0],y=new TextEncoder,p=H.makeExtSplat(),h=(E,R,m)=>{let v=new Float32Array(O.VALUES),M=Te.slice(0,f).map(([,z])=>new Float32Array(z*E));for(let z=0;z<E;z+=1){m(z,v);let k=0;for(let P=0;P<M.length;P+=1){let L=M[P],Q=Te[P][1];for(let U=0;U<Q;U+=1)L[U*E+z]=v[k+U];k+=Q}}return M.map((z,k)=>{let P=Te[k][0]+R;if(n==="f32")return[P,"f32",le(z)];if(n==="f16"){let U=new Uint16Array(z.length);for(let I=0;I<z.length;I+=1)U[I]=T.encodeHalf(z[I]);return[P,"f16",le(U)]}let L=0;for(let U=0;U<z.length;U+=1)L=Math.max(L,Math.abs(z[U]));L||=1,d[k]=Math.max(d[k],L);let Q=new Uint8Array(z.length);for(let U=0;U<z.length;U+=1)Q[U]=Math.max(-127,Math.min(127,Math.round(z[U]/L*127)))&255;return[P,"s8",Q,{min:-L,max:L}]})},g=[],b=[],x=0,A=ae(o,r.count,"encoding");for(let E=0;E<r.count;E+=e){let R=Math.min(e,r.count-E),m=new Float32Array(R*3),v=new Float32Array(R),M=new Float32Array(R*3),z=new Float32Array(R*3),k=new Float32Array(R*3);for(let V=0;V<R;V+=1){A(E+V),s(E+V,p);let j=p.quaternion,Y=j.w<0?-1:1;m[V]=p.center.x,m[R+V]=p.center.y,m[2*R+V]=p.center.z,M[V]=p.rgb.r,M[R+V]=p.rgb.g,M[2*R+V]=p.rgb.b,z[V]=p.scales.x,z[R+V]=p.scales.y,z[2*R+V]=p.scales.z,k[V]=j.x*Y,k[R+V]=j.y*Y,k[2*R+V]=j.z*Y,v[V]=p.opacity}let P=[["center","f32",le(m)],["alpha","f32",le(v)],["rgb","f32",le(M)],["scales","f32",le(z)],["orientation","f32",le(k)]];if(u&&P.push(...h(R,"",(V,j)=>u(E+V,j))),c&&(E===0&&P.push(...h(a.size,"_code",(V,j)=>a.get(V,j))),P.push(["sh_label","u16",le(Uint16Array.from(c.subarray(E,E+R)))])),i){let V=i.channels.node.data,j=new Uint32Array(R),Y=new Uint32Array(R);for(let F=0;F<R;F+=1)j[F]=V[(E+F)*2],Y[F]=V[(E+F)*2+1];P.push(["child_count","u32",le(j)],["child_start","u32",le(Y)])}let L=await Promise.all(P.map(([,,V])=>se.gzip(V))),Q=[],U=0;P.forEach(([V,j,,Y],F)=>{Q.push({offset:U,bytes:L[F].byteLength,property:V,encoding:j,compression:"gz",...Y}),U+=Ee(L[F].byteLength)});let I=y.encode(JSON.stringify({version:1,base:E,count:R,payloadBytes:U,maxSh:f,lodTree:i!==void 0,properties:Q})),N=new Uint8Array(8+Ee(I.byteLength)+8+U),K=new DataView(N.buffer);K.setUint32(0,Ge,!0),K.setUint32(4,I.byteLength,!0),N.set(I,8);let W=8+Ee(I.byteLength);K.setUint32(W,U,!0),Q.forEach((V,j)=>N.set(L[j],W+8+V.offset)),g.push(N),b.push({offset:x,bytes:N.byteLength}),x+=N.byteLength}let C=f>0&&n==="s8"?{sh1Max:d[0]||1,sh2Max:d[1]||1,sh3Max:d[2]||1}:void 0,B=y.encode(JSON.stringify({version:1,type:"gsplat",count:r.count,maxSh:f,lodTree:i!==void 0,chunkSize:e,chunks:b,splatEncoding:C,shCodeCount:c?a.size:void 0})),w=new Uint8Array(8+Ee(B.byteLength)+x),_=new DataView(w.buffer);_.setUint32(0,yt,!0),_.setUint32(4,B.byteLength,!0),w.set(B,8);let D=8+Ee(B.byteLength);for(let E of g)w.set(E,D),D+=E.byteLength;return o?.(1,"encoding"),w}var It=1,Kr=65536,pt=1213744210,Yr=1129858130,sa=64*1024,ge=r=>Math.ceil(r/16)*16;function jr(r,e,t){let n=new TextEncoder().encode(JSON.stringify(e)),a=16+ge(n.byteLength),o=a+ge(t.length*4),s=o+t.reduce((u,f)=>u+ge(f.byteLength),0),i=new Uint8Array(s),c=new DataView(i.buffer);c.setUint32(0,r,!0),c.setUint32(4,n.byteLength,!0),c.setUint32(8,t.length,!0),i.set(n,16);let l=o;return t.forEach((u,f)=>{c.setUint32(a+f*4,u.byteLength,!0),i.set(u,l),l+=ge(u.byteLength)}),i}function Zr(r,e){let t=new DataView(r.buffer,r.byteOffset,r.byteLength);if(r.byteLength<16||t.getUint32(0,!0)!==e)throw new Error("Not an RDX piece of the expected type");let n=t.getUint32(4,!0),a=t.getUint32(8,!0),o=JSON.parse(new TextDecoder().decode(r.subarray(16,16+n))),s=16+ge(n),i=s+ge(a*4),c=Array.from({length:a},(l,u)=>{let f=t.getUint32(s+u*4,!0),d=r.subarray(i,i+f);return i+=ge(f),d});return{meta:o,payloads:c,byteLength:i}}async function $t(r,{chunkSize:e=Kr,progress:t}={}){if(e<=0||e%ie.ROW_ELEMENTS!==0)throw new Error(`Chunk size ${e} is not a positive multiple of ${ie.ROW_ELEMENTS}`);let n=Object.entries(r.bundles).filter(([,i])=>i.def.serialize),a=Math.ceil(r.count/e),o=[];for(let i=0;i<a;i+=1){t?.(i/a,"encoding");let c=i*e,l=Math.min(e,r.count-c),u=[];for(let[,f]of n)for(let d of Object.values(f.channels)){let y=ce.info(d.format);u.push(await se.compressTransposed(d.data.subarray(c*y.components,(c+l)*y.components),y.bytes))}o.push(jr(Yr,{start:c,count:l},u))}t?.(1,"encoding");let s={version:It,count:r.count,chunkSize:e,meta:r.meta,bundles:Object.fromEntries(n.map(([i,c])=>[i,{def:c.def,meta:c.meta}])),chunks:o.map(i=>i.byteLength)};return{header:jr(pt,s,[]),chunks:o}}function Nt(r,e){let t=r.search(/\\.rdx($|[?#])/);if(t<0)throw new Error(`${r} does not end in .rdx`);return`${r.slice(0,t)}-${e}${r.slice(t)}`}async function ca(r,e,t={}){let{header:n,chunks:a}=await $t(r,t),o={[e]:n};return a.forEach((s,i)=>o[Nt(e,i)]=s),o}async function ia(r,e={}){let{header:t,chunks:n}=await $t(r,e),a=new Uint8Array(t.byteLength+n.reduce((s,i)=>s+i.byteLength,0));a.set(t);let o=t.byteLength;for(let s of n)a.set(s,o),o+=s.byteLength;return a}function mt(r){let{meta:e,byteLength:t}=Zr(r,pt),n=e;if(n.version!==It)throw new Error(`RDX version ${n.version} is not ${It}`);return{header:n,byteLength:t}}function Wr(r){let e=new Z({count:r.count,meta:r.meta});for(let[t,{def:n,meta:a}]of Object.entries(r.bundles))e.addBundle(t,ne(n.channels,{packing:n.packing,serialize:n.serialize}),{meta:a});return e}async function ht(r,e,t){let{meta:n,payloads:a}=Zr(e,Yr),{start:o,count:s}=n;t.ensureCapacity(o+s);let i=0;for(let[c,{def:l}]of Object.entries(r.bundles))for(let[u,f]of Object.entries(l.channels)){let d=ce.info(f),y=await se.decompressTransposed(a[i++],d.bytes);if(y.byteLength!==s*d.bytes)throw new Error(`Chunk at ${o}: ${c}.${u} holds ${y.byteLength} bytes, expected ${s*d.bytes}`);let p=t.bundles[c]?.channels[u];if(p?.format!==f)throw new Error(`Channel ${c}.${u} missing from the target or of another format`);p.data.set(new d.array(y.buffer,y.byteOffset,s*d.components),o*d.components)}t.count=Math.max(t.count,o+s)}async function la(r,{progress:e}={}){let{header:t,byteLength:n}=mt(r),a=Wr(t),o=n;for(let[s,i]of t.chunks.entries())e?.(s/t.chunks.length,"decoding"),await ht(t,r.subarray(o,o+i),a),o+=i;return e?.(1,"decoding"),a}async function Gr(r){let e=await r(0,sa);if(e.byteLength<16)throw new Error("Not an RDX file");let t=new DataView(e.buffer,e.byteOffset,e.byteLength).getUint32(4,!0),n=16+ge(t);e.byteLength<n&&(e=await r(0,n));let{header:a,byteLength:o}=mt(e.subarray(0,n)),s=[],i=o;for(let c of a.chunks)s.push(i),i+=c;return{header:a,async readChunk(c,l){if(!(c>=0&&c<s.length))throw new Error(`No chunk ${c} (the file has ${s.length})`);await ht(a,await r(s[c],s[c]+a.chunks[c]),l)}}}async function _t(r,e){let t=await fetch(r,e);if(!t.ok)throw new Error(`Failed to load ${r}: ${t.status}`);return{status:t.status,bytes:new Uint8Array(await t.arrayBuffer())}}async function fa(r,{chunked:e=!1,init:t={}}={}){if(e){let{header:a}=mt((await _t(r,t)).bytes);return{header:a,async readChunk(o,s){await ht(a,(await _t(Nt(r,o),t)).bytes,s)}}}let n;return Gr(async(a,o)=>{if(!n){let s=new Headers(t.headers);s.set("Range",`bytes=${a}-${o-1}`);let{status:i,bytes:c}=await _t(r,{...t,headers:s});if(i===206)return c;n=c}return n.subarray(a,o)})}var Fe=class{static CHUNK_SIZE=Kr;static encode=ia;static decode=la;static encodeChunks=$t;static encodeFiles=ca;static chunkName=Nt;static decodeHeader=mt;static makeData=Wr;static decodeChunk=ht;static open=Gr;static load=fa};var ua=ArrayBuffer,J=Uint8Array,bt=Uint16Array,da=Int16Array;var gt=Int32Array,Vt=function(r,e,t){if(J.prototype.slice)return J.prototype.slice.call(r,e,t);(e==null||e<0)&&(e=0),(t==null||t>r.length)&&(t=r.length);var n=new J(t-e);return n.set(r.subarray(e,t)),n},Je=function(r,e,t,n){if(J.prototype.fill)return J.prototype.fill.call(r,e,t,n);for((t==null||t<0)&&(t=0),(n==null||n>r.length)&&(n=r.length);t<n;++t)r[t]=e;return r},ya=function(r,e,t,n){if(J.prototype.copyWithin)return J.prototype.copyWithin.call(r,e,t,n);for((t==null||t<0)&&(t=0),(n==null||n>r.length)&&(n=r.length);t<n;)r[e++]=r[t++]};var pa=["invalid zstd data","window size too large (>2046MB)","invalid block type","FSE accuracy too high","match distance too far back","unexpected EOF"],ee=function(r,e,t){var n=new Error(e||pa[r]);if(n.code=r,Error.captureStackTrace&&Error.captureStackTrace(n,ee),!t)throw n;return n},Xr=function(r,e,t){for(var n=0,a=0;n<t;++n)a|=r[e++]<<(n<<3);return a},ma=function(r,e){return(r[e]|r[e+1]<<8|r[e+2]<<16|r[e+3]<<24)>>>0},ha=function(r,e){var t=r[0]|r[1]<<8|r[2]<<16;if(t==3126568&&r[3]==253){var n=r[4],a=n>>5&1,o=n>>2&1,s=n&3,i=n>>6;n&8&&ee(0);var c=6-a,l=s==3?4:s,u=Xr(r,c,l);c+=l;var f=i?1<<i:a,d=Xr(r,c,f)+(i==1&&256),y=d;if(!a){var p=1<<10+(r[5]>>3);y=p+(p>>3)*(r[5]&7)}y>2145386496&&ee(1);var h=new J((e==1?d||y:e?0:y)+12);return h[0]=1,h[4]=4,h[8]=8,{b:c+f,y:0,l:0,d:u,w:e&&e!=1?e:h.subarray(12),e:y,o:new gt(h.buffer,0,3),u:d,c:o,m:Math.min(131072,y)}}else if((t>>4|r[3]<<20)==25481893)return ma(r,4)+8;ee(0)},Ue=function(r){for(var e=0;1<<e<=r;++e);return e-1},et=function(r,e,t){var n=(e<<3)+4,a=(r[e]&15)+5;a>t&&ee(3);for(var o=1<<a,s=o,i=-1,c=-1,l=-1,u=o,f=new ua(512+(o<<2)),d=new da(f,0,256),y=new bt(f,0,256),p=new bt(f,512,o),h=512+(o<<1),g=new J(f,h,o),b=new J(f,h+o);i<255&&s>0;){var x=Ue(s+1),A=n>>3,C=(1<<x+1)-1,B=(r[A]|r[A+1]<<8|r[A+2]<<16)>>(n&7)&C,w=(1<<x)-1,_=C-s-1,D=B&w;if(D<_?(n+=x,B=D):(n+=x+1,B>w&&(B-=_)),d[++i]=--B,B==-1?(s+=B,g[--u]=i):s-=B,!B)do{var E=n>>3;c=(r[E]|r[E+1]<<8)>>(n&7)&3,n+=2,i+=c}while(c==3)}(i>255||s)&&ee(0);for(var R=0,m=(o>>1)+(o>>3)+3,v=o-1,M=0;M<=i;++M){var z=d[M];if(z<1){y[M]=-z;continue}for(l=0;l<z;++l){g[R]=M;do R=R+m&v;while(R>=u)}}for(R&&ee(0),l=0;l<o;++l){var k=y[g[l]]++,P=b[l]=a-Ue(k);p[l]=(k<<P)-o}return[n+7>>3,{b:a,s:g,n:b,t:p}]},ba=function(r,e){var t=0,n=-1,a=new J(292),o=r[e],s=a.subarray(0,256),i=a.subarray(256,268),c=new bt(a.buffer,268);if(o<128){var l=et(r,e+1,6),u=l[0],f=l[1];e+=o;var d=u<<3,y=r[e];y||ee(0);for(var p=0,h=0,g=f.b,b=g,x=(++e<<3)-8+Ue(y);x-=g,!(x<d);){var A=x>>3;if(p+=(r[A]|r[A+1]<<8)>>(x&7)&(1<<g)-1,s[++n]=f.s[p],x-=b,x<d)break;A=x>>3,h+=(r[A]|r[A+1]<<8)>>(x&7)&(1<<b)-1,s[++n]=f.s[h],g=f.n[p],p=f.t[p],b=f.n[h],h=f.t[h]}++n>255&&ee(0)}else{for(n=o-127;t<n;t+=2){var C=r[++e];s[t]=C>>4,s[t+1]=C&15}++e}var B=0;for(t=0;t<n;++t){var w=s[t];w>11&&ee(0),B+=w&&1<<w-1}var _=Ue(B)+1,D=1<<_,E=D-B;for(E&E-1&&ee(0),s[n++]=Ue(E)+1,t=0;t<n;++t){var w=s[t];++i[s[t]=w&&_+1-w]}var R=new J(D<<1),m=R.subarray(0,D),v=R.subarray(D);for(c[_]=0,t=_;t>0;--t){var M=c[t];Je(v,t,M,c[t-1]=M+i[t]*(1<<_-t))}for(c[0]!=D&&ee(0),t=0;t<n;++t){var z=s[t];if(z){var k=c[z];Je(m,t,k,c[z]=k+(1<<_-z))}}return[e,{n:v,b:_,s:m}]},ga=et(new J([81,16,99,140,49,198,24,99,12,33,196,24,99,102,102,134,70,146,4]),0,6)[1],xa=et(new J([33,20,196,24,99,140,33,132,16,66,8,33,132,16,66,8,33,68,68,68,68,68,68,68,68,36,9]),0,6)[1],Aa=et(new J([32,132,16,66,102,70,68,68,68,68,36,73,2]),0,5)[1],Jr=function(r,e){for(var t=r.length,n=new gt(t),a=0;a<t;++a)n[a]=e,e+=1<<r[a];return n},Ht=new J(new gt([0,0,0,0,16843009,50528770,134678020,202050057,269422093]).buffer,0,36),Sa=Jr(Ht,0),Qt=new J(new gt([0,0,0,0,0,0,0,0,16843009,50528770,117769220,185207048,252579084,16]).buffer,0,53),wa=Jr(Qt,3),Xe=function(r,e,t){var n=r.length,a=e.length,o=r[n-1],s=(1<<t.b)-1,i=-t.b;o||ee(0);for(var c=0,l=t.b,u=(n<<3)-8+Ue(o)-l,f=-1;u>i&&f<a;){var d=u>>3,y=(r[d]|r[d+1]<<8|r[d+2]<<16)>>(u&7);c=(c<<l|y)&s,e[++f]=t.s[c],u-=l=t.n[c]}(u!=i||f+1!=a)&&ee(0)},Ea=function(r,e,t){var n=6,a=e.length,o=a+3>>2,s=o<<1,i=o+s;Xe(r.subarray(n,n+=r[0]|r[1]<<8),e.subarray(0,o),t),Xe(r.subarray(n,n+=r[2]|r[3]<<8),e.subarray(o,s),t),Xe(r.subarray(n,n+=r[4]|r[5]<<8),e.subarray(s,i),t),Xe(r.subarray(n),e.subarray(i),t)},Ua=function(r,e,t){var n,a=e.b,o=r[a],s=o>>1&3;e.l=o&1;var i=o>>3|r[a+1]<<5|r[a+2]<<13,c=(a+=3)+i;if(s==1)return a>=r.length?void 0:(e.b=a+1,t?(Je(t,r[a],e.y,e.y+=i),t):Je(new J(i),r[a]));if(!(c>r.length)){if(s==0)return e.b=c,t?(t.set(r.subarray(a,c),e.y),e.y+=i,t):Vt(r,a,c);if(s==2){var l=r[a],u=l&3,f=l>>2&3,d=l>>4,y=0,p=0;u<2?f&1?d|=r[++a]<<4|(f&2&&r[++a]<<12):d=l>>3:(p=f,f<2?(d|=(r[++a]&63)<<4,y=r[a]>>6|r[++a]<<2):f==2?(d|=r[++a]<<4|(r[++a]&3)<<12,y=r[a]>>2|r[++a]<<6):(d|=r[++a]<<4|(r[++a]&63)<<12,y=r[a]>>6|r[++a]<<2|r[++a]<<10)),++a;var h=t?t.subarray(e.y,e.y+e.m):new J(e.m),g=h.length-d;if(u==0)h.set(r.subarray(a,a+=d),g);else if(u==1)Je(h,r[a++],g);else{var b=e.h;if(u==2){var x=ba(r,a);y+=a-(a=x[0]),e.h=b=x[1]}else b||ee(0);(p?Ea:Xe)(r.subarray(a,a+=y),h.subarray(g),b)}var A=r[a++];if(A){A==255?A=(r[a++]|r[a++]<<8)+32512:A>127&&(A=A-128<<8|r[a++]);var C=r[a++];C&3&&ee(0);for(var B=[xa,Aa,ga],w=2;w>-1;--w){var _=C>>(w<<1)+2&3;if(_==1){var D=new J([0,0,r[a++]]);B[w]={s:D.subarray(2,3),n:D.subarray(0,1),t:new bt(D.buffer,0,1),b:0}}else _==2?(n=et(r,a,9-(w&1)),a=n[0],B[w]=n[1]):_==3&&(e.t||ee(0),B[w]=e.t[w])}var E=e.t=B,R=E[0],m=E[1],v=E[2],M=r[c-1];M||ee(0);var z=(c<<3)-8+Ue(M)-v.b,k=z>>3,P=0,L=(r[k]|r[k+1]<<8)>>(z&7)&(1<<v.b)-1;k=(z-=m.b)>>3;var Q=(r[k]|r[k+1]<<8)>>(z&7)&(1<<m.b)-1;k=(z-=R.b)>>3;var U=(r[k]|r[k+1]<<8)>>(z&7)&(1<<R.b)-1;for(++A;--A;){var I=v.s[L],N=v.n[L],K=R.s[U],W=R.n[U],V=m.s[Q],j=m.n[Q];k=(z-=V)>>3;var Y=1<<V,F=Y+((r[k]|r[k+1]<<8|r[k+2]<<16|r[k+3]<<24)>>>(z&7)&Y-1);k=(z-=Qt[K])>>3;var G=wa[K]+((r[k]|r[k+1]<<8|r[k+2]<<16)>>(z&7)&(1<<Qt[K])-1);k=(z-=Ht[I])>>3;var X=Sa[I]+((r[k]|r[k+1]<<8|r[k+2]<<16)>>(z&7)&(1<<Ht[I])-1);if(k=(z-=N)>>3,L=v.t[L]+((r[k]|r[k+1]<<8)>>(z&7)&(1<<N)-1),k=(z-=W)>>3,U=R.t[U]+((r[k]|r[k+1]<<8)>>(z&7)&(1<<W)-1),k=(z-=j)>>3,Q=m.t[Q]+((r[k]|r[k+1]<<8)>>(z&7)&(1<<j)-1),F>3)e.o[2]=e.o[1],e.o[1]=e.o[0],e.o[0]=F-=3;else{var $=F-(X!=0);$?(F=$==3?e.o[0]-1:e.o[$],$>1&&(e.o[2]=e.o[1]),e.o[1]=e.o[0],e.o[0]=F):F=e.o[0]}for(var w=0;w<X;++w)h[P+w]=h[g+w];P+=X,g+=X;var S=P-F;if(S<0){var q=-S,$e=e.e+S;q>G&&(q=G);for(var w=0;w<q;++w)h[P+w]=e.w[$e+w];P+=q,G-=q,S=0}for(var w=0;w<G;++w)h[P+w]=h[S+w];P+=G}if(P!=g)for(;g<h.length;)h[P++]=h[g++];else P=h.length;t?e.y+=P:h=Vt(h,0,P)}else if(t){if(e.y+=d,g)for(var w=0;w<d;++w)h[w]=h[g+w]}else g&&(h=Vt(h,g));return e.b=c,h}ee(2)}},va=function(r,e){if(r.length==1)return r[0];for(var t=new J(e),n=0,a=0;n<r.length;++n){var o=r[n];t.set(o,a),a+=o.length}return t};function en(r,e){for(var t=[],n=+!e,a=0,o=0;r.length;){var s=ha(r,n||e);if(typeof s=="object"){for(n?(e=null,s.w.length==s.u&&(t.push(e=s.w),o+=s.u)):(t.push(e),s.e=0);!s.l;){var i=Ua(r,s,e);i||ee(5),e?s.e=s.y:(t.push(i),o+=i.length,ya(s.w,0,i.length),s.w.set(i,s.w.length-i.length))}a=s.b+s.c*4}else a=s;r=r.subarray(a)}return va(t,o)}var Ma=12,qt;function tn(){if(qt===void 0){let e=globalThis.process?.getBuiltinModule?.("node:zlib");qt=e?.zstdCompressSync&&e.zstdDecompressSync?e:null}return qt}var xt={};function rn(r){if(xt[r]===void 0)try{r==="compress"?new CompressionStream("zstd"):new DecompressionStream("zstd"),xt[r]=!0}catch{xt[r]=!1}return xt[r]}function nn(r){return r.byteOffset===0&&r.byteLength===r.buffer.byteLength&&r.buffer instanceof ArrayBuffer?new Uint8Array(r.buffer):new Uint8Array(r)}var fe=class{static async decompress(e,t,{native:n=!0}={}){let a=n?tn():null,o;try{o=a?a.zstdDecompressSync(e):n&&rn("decompress")?await Ae(new Uint8Array(e),new DecompressionStream("zstd")):en(e)}catch(s){throw new Error(`Invalid zstd stream: ${s instanceof Error?s.message:String(s)}`)}if(o.byteLength!==t)throw new Error(`zstd stream decoded to ${o.byteLength} bytes, not ${t}`);return nn(o)}static async compress(e,{native:t=!0,level:n=Ma}={}){let a=t?tn():null;return a?nn(a.zstdCompressSync(e,{params:{[a.constants.ZSTD_c_compressionLevel]:n}})):t&&rn("compress")?Ae(new Uint8Array(e),new CompressionStream("zstd")):Ra(e)}},tt=1<<17,At=11,ve=6,Ca=64,rt=class{bytes;pos;acc=0;n=0;constructor(e,t=0){this.bytes=e,this.pos=t}add(e,t){for(this.acc|=e<<this.n,this.n+=t;this.n>=8;)this.bytes[this.pos++]=this.acc&255,this.acc>>>=8,this.n-=8}flush(){return this.n>0&&(this.bytes[this.pos++]=this.acc&255),this.acc=0,this.n=0,this.pos}close(){return this.add(1,1),this.flush()}};function La(r,e){e.fill(0);let t=[];for(let p=0;p<256;p+=1)r[p]>0&&t.push(p);t.sort((p,h)=>r[p]-r[h]||p-h);let n=t.length,a=new Float64Array(2*n-1),o=new Int32Array(2*n-1),s=new Uint8Array(2*n-1);for(let p=0;p<n;p+=1)a[p]=r[t[p]];let i=0,c=n,l=p=>i<n&&(c>=p||a[i]<=a[c])?i++:c++;for(let p=n;p<2*n-1;p+=1){let h=l(p),g=l(p);a[p]=a[h]+a[g],o[h]=p,o[g]=p}let u=new Uint32Array(257),f=0;for(let p=2*n-3;p>=0;p-=1)s[p]=s[o[p]]+1,p<n&&(u[s[p]]+=1,f=Math.max(f,s[p]));for(let p=f;p>At;p-=1)for(;u[p]>0;){let h=p-2;for(;u[h]===0;)h-=1;u[p]-=2,u[p-1]+=1,u[h+1]+=2,u[h]-=1}let d=n-1,y=0;for(let p=1;p<=Math.min(f,At);p+=1)for(let h=0;h<u[p];h+=1)e[t[d--]]=p,y=p;return y}function Ba(r,e,t){let n=0;for(let a=e;a>=1;a-=1){let o=1<<e-a;for(let s=0;s<256;s+=1)r[s]===a&&(t[s]=n>>e-a,n+=o)}}var za=r=>31-Math.clz32(r);function Da(r,e,t,n){let a=1<<ve,o=new Uint32Array(At+1);for(let m=0;m<e;m+=1)o[r[m]]+=1;let s=0,i=0;for(let m=0;m<=At;m+=1)o[m]>0&&(s=m,i+=1);if(i<2||e<=2)return;let c=new Int32Array(s+1),l=0;for(let m=0;m<=s;m+=1)o[m]>0&&(c[m]=Math.max(1,Math.floor(o[m]*a/e)),l+=c[m]);for(;l!==a;){let m=-1;for(let v=0;v<=s;v+=1)(l>a?c[v]>1&&(m<0||c[v]>c[m]):o[v]>0&&(m<0||o[v]>o[m]))&&(m=v);c[m]+=l>a?-1:1,l+=l>a?-1:1}let u=new Uint8Array(256),f=new rt(u);f.add(ve-5,4);let d=a+1,y=a,p=ve+1,h=!1;for(let m=0;m<=s&&d>1;){if(h){let z=m;for(;c[m]===0;)m+=1;for(;m>=z+3;)z+=3,f.add(3,2);f.add(m-z,2)}let v=c[m++],M=2*y-1-d;for(d-=v,v+=1,v>=y&&(v+=M),f.add(v,v<M?p-1:p),h=v===1;d<y;)p-=1,y>>=1}let g=f.flush(),b=new Uint8Array(a),x=0;for(let m=0;m<=s;m+=1)for(let v=0;v<c[m];v+=1)b[x]=m,x=x+(a>>1)+(a>>3)+3&a-1;let A=new Int32Array(s+2);for(let m=0;m<=s;m+=1)A[m+1]=A[m]+c[m];let C=new Uint16Array(a);for(let m=0;m<a;m+=1)C[A[b[m]]++]=a+m;let B=new Int32Array(s+1),w=new Int32Array(s+1),_=0;for(let m=0;m<=s;m+=1)if(c[m]===1)B[m]=(ve<<16)-a,w[m]=_-1,_+=1;else if(c[m]>1){let v=ve-za(c[m]-1);B[m]=(v<<16)-(c[m]<<v),w[m]=_-c[m],_+=c[m]}let D=new rt(u,g),E=[0,0],R=[!1,!1];for(let m=e-1;m>=0;m-=1){let v=r[m],M=m&1;if(R[M]){let z=E[M],k=z+B[v]>>16;D.add(z&(1<<k)-1,k),E[M]=C[(z>>k)+w[v]]}else{let z=B[v]+32768>>16,k=(z<<16)-B[v];E[M]=C[(k>>z)+w[v]],R[M]=!0}}if(D.add(E[1]&a-1,ve),D.add(E[0]&a-1,ve),g=D.close(),!(g>127))return t.set(u.subarray(0,g),n),g}function ka(r,e,t,n){let a=255;for(;r[a]===0;)a-=1;let o=new Uint8Array(256);for(let l=0;l<a;l+=1)o[l]=r[l]?e+1-r[l]:0;let s=new Uint8Array(128),i=Da(o,a,s,0),c=a<=128?1+(a+1>>1):1/0;if(i!==void 0&&i+1<c)return t[n]=i,t.set(s.subarray(0,i),n+1),i+1;if(c!==1/0){t[n]=127+a;for(let l=0;l<a;l+=2)t[n+1+(l>>1)]=o[l]<<4|(l+1<a?o[l+1]:0);return c}}function de(r,e,t,n){for(let a=0;a<n;a+=1)r[e+a]=t%256,t=Math.floor(t/256)}function Ra(r){let e=Math.max(1,Math.ceil(r.byteLength/tt)),t=new Uint8Array(14+r.byteLength+e*3);de(t,0,4247762216,4);let n=r.byteLength>=2**32;t[4]=(n?3:2)<<6,t[5]=56,de(t,6,r.byteLength,n?8:4);let a=n?14:10,o=new Uint32Array(256),s=new Uint8Array(256),i=new Uint16Array(256),c=new Uint8Array(256),l=new Uint16Array(256),u=!1,f=new Uint8Array(2*tt);for(let d=0;d<e;d+=1){let y=d*tt,p=Math.min(tt,r.byteLength-y),h=d===e-1?1:0,g=r.subarray(y,y+p);o.fill(0);for(let A=0;A<p;A+=1)o[g[A]]+=1;if(p>0&&o[g[0]]===p){de(t,a,h|2|p<<3,3),t[a+3]=g[0],a+=4;continue}let[b,x]=p>=Ca?Pa(g,o,s,i,c,l,u,f):[0,!1];b>0&&b<p?(de(t,a,h|4|b<<3,3),t.set(f.subarray(0,b),a+3),a+=3+b,x&&(c.set(s),l.set(i)),u=!0):(de(t,a,h|p<<3,3),t.set(g,a+3),a+=3+p)}return t.slice(0,a)}function Pa(r,e,t,n,a,o,s,i){let c=r.byteLength,l=La(e,t),u=new Uint8Array(256),f=ka(t,l,u,0),d=0,y=s?0:1/0;for(let M=0;M<256;M+=1)e[M]>0&&(d+=e[M]*t[M],y+=a[M]>0?e[M]*a[M]:1/0);let p=f===void 0?1/0:d+f*8;if(p===1/0&&y===1/0)return[0,!1];let h=y<=p;h||Ba(t,l,n);let g=h?a:t,b=h?o:n,x=5,A=x;h||(i.set(u.subarray(0,f),A),A+=f);let C=A;A+=6;let B=Math.ceil(c/4),w=[0,0,0];for(let M=0;M<4;M+=1){let z=Math.min(c,M*B),k=Math.min(c,z+B),P=new rt(i,A);for(let Q=k-1;Q>=z;Q-=1){let U=r[Q];P.add(b[U],g[U])}let L=P.close();if(M<3&&(w[M]=L-A),A=L,A>tt)return[0,!1]}de(i,C,w[0],2),de(i,C+2,w[1],2),de(i,C+4,w[2],2);let _=A-x,D=Math.max(c,_)<=1023?1:Math.max(c,_)<=16383?2:3,E=D+2,m=(h?3:2)+(D<<2)+c*16+_*2**(D===1?14:D===2?18:22),v=x-E;return de(i,v,m,E),i[A]=0,A+=1,i.copyWithin(0,v,A),[A-v,!h]}var _e=1347635022,Ta=4,jt=4,on=1,Kt=2,sn=64,cn=128,ln=2914910210,fn=2914910211,un=1381498881,dn=1381498882,Yt=6,Zt=5,yn=me/.15,nt={0:0,1:3,2:8,3:15,4:24},ue=(r,e)=>(r[e]|r[e+1]<<8|r[e+2]<<16|r[e+3]<<24)>>>0;function pn(r){let e=[],t=0;for(;t+8<=r.byteLength;){let n=ue(r,t),a=ue(r,t+4);if(t+8+a>r.byteLength)throw new Error(`SPZ extension record 0x${n.toString(16)} runs past its end`);e.push({type:n,data:r.subarray(t+8,t+8+a)}),t+=8+a}return e}async function mn(r,e,t){for(let n of r)n.type===un?t.lodTree=await fe.decompress(n.data,e*Yt):n.type===dn?t.pbr=await fe.decompress(n.data,e*Zt):t.extensions.push(n)}function hn(r,e,t){if(r<1||r>t||!(e in nt))throw new Error(`Unsupported SPZ version ${r} or SH degree ${e}`)}async function Oa(r,e){let t=await r.read(16);if(ue(t,0)!==_e)throw new Error("Invalid SPZ file");let n=ue(t,4),a=ue(t,8),[o,s,i]=[t[12],t[13],t[14]];hn(n,o,Ta);let c=a*nt[o]*3,l={container:"gzip",version:n,count:a,shDegree:o,fractionalBits:s,flags:i,centers:await r.read(a*(n===1?6:9)),alphas:await r.read(a),colors:await r.read(a*3),scales:await r.read(a*3),rotations:await r.read(a*(n>=3?4:3)),extensions:[]};return e&&c>0?l.sh=await r.read(c):await r.skip(c),i&cn&&(l.lodTree=await r.read(a*Yt)),i&sn&&(l.pbr=await r.read(a*Zt)),i&Kt?await mn(pn(await r.rest()),a,l):r.cancel(),l}async function Fa(r,e){let t=await r.read(32),n=ue(t,4),a=ue(t,8),[o,s,i,c]=[t[12],t[13],t[14],t[15]],l=ue(t,16);if(n!==jt)throw new Error(`Unsupported SPZ version ${n} in the NGSP container`);if(hn(n,o,jt),a>2147483647)throw new Error(`Invalid SPZ point count ${a}`);if(l<32)throw new Error("SPZ 4 table of contents inside the header");let u=await r.read(l-32),f=[9,1,3,3,4,nt[o]*3].map(A=>a*A),d=f.flatMap((A,C)=>A>0?[C]:[]);if(c!==d.length)throw new Error(`SPZ 4 file with ${c} streams, ${d.length} expected`);let y=await r.read(c*16),p=[],h=l+y.byteLength;for(let A=0;A<c;A+=1){let[C,B,w,_]=[0,4,8,12].map(D=>ue(y,A*16+D));if(B>=1<<21||_!==0||w!==f[d[A]])throw new Error(`SPZ 4 stream ${A} sizes don\'t match its header`);p.push(B*2**32+C),h+=p[A]}if(a*9>h*1024)throw new Error(`Invalid SPZ point count ${a} for ${h} bytes`);let g=f.map(()=>new Uint8Array(0)),b=!0;for(let A=0;A<c;A+=1){if(d[A]===5&&!e){r.cancel(),b=!1;break}g[d[A]]=await fe.decompress(await r.read(p[A]),f[d[A]])}if(b&&!await r.atEnd())throw new Error("SPZ 4 file has bytes after its last stream");let x={container:"ngsp",version:n,count:a,shDegree:o,fractionalBits:s,flags:i,centers:g[0],alphas:g[1],colors:g[2],scales:g[3],rotations:g[4],sh:e&&g[5].byteLength>0?g[5]:void 0,extensions:[]};return i&Kt&&await mn(pn(u),a,x),x}async function bn(r,{sh:e=!0}={}){let t=new De(r,"SPZ file"),n=await t.peek(4);if(n.byteLength===4&&ue(n,0)===_e)return Fa(t,e);if(n[0]!==31||n[1]!==139)throw t.cancel(),new Error("Invalid SPZ file");return Oa(new De(t.stream().pipeThrough(new DecompressionStream("gzip")),"SPZ file"),e)}async function _a(r,{progress:e,sh:t,coordinateSystem:n,...a}={}){let o=await bn(r,{sh:t!==!1}),{version:s,count:i,shDegree:c}=o,l={format:"spz",version:s,container:o.container,antialiased:(o.flags&on)!==0},u="RUB",f=[];for(let{type:L,data:Q}of o.extensions){let U=new DataView(Q.buffer,Q.byteOffset,Q.byteLength);if(L===ln&&Q.byteLength>=12)l.safeOrbitCamera={elevationMin:U.getFloat32(0,!0),elevationMax:U.getFloat32(4,!0),radiusMin:U.getFloat32(8,!0)};else if(L===fn&&Q.byteLength>=4){let I=U.getUint32(0,!0);if(I>pe.SYSTEMS.length)throw new Error(`Unknown SPZ coordinate system ${I}`);u=I===0?"RUB":pe.SYSTEMS[I-1]}else f.push(L)}f.length>0&&(l.skippedExtensions=f),l.coordinateSystem=n??u;let d=n&&n!==u?pe.converter(u,n):void 0,y=new Z({count:i,meta:l}),p=H.encoder(H.add(y,a)),h=O.prepare(y,c,t),g=nt[c]*3,b=new Float32Array(O.VALUES),{centers:x,alphas:A,colors:C,scales:B,rotations:w,sh:_,pbr:D}=o,E=new DataView(x.buffer,x.byteOffset,x.byteLength),R=new DataView(w.buffer,w.byteOffset,w.byteLength),m=1/(1<<o.fractionalBits),v=L=>(x[L]|x[L+1]<<8|x[L+2]<<16)<<8>>8,M=H.makeExtSplat(),z=L=>(L/255-.5)*yn+.5,k=L=>Math.exp(L/16-10),P=ae(e,i,"decoding");for(let L=0;L<i;L+=1){if(P(L),s===1?(M.center.x=T.decodeHalf(E.getUint16(L*6,!0)),M.center.y=T.decodeHalf(E.getUint16(L*6+2,!0)),M.center.z=T.decodeHalf(E.getUint16(L*6+4,!0))):(M.center.x=v(L*9)*m,M.center.y=v(L*9+3)*m,M.center.z=v(L*9+6)*m),M.opacity=A[L]/255,M.rgb.r=z(C[L*3]),M.rgb.g=z(C[L*3+1]),M.rgb.b=z(C[L*3+2]),M.scales.x=k(B[L*3]),M.scales.y=k(B[L*3+1]),M.scales.z=k(B[L*3+2]),s>=3)Na(R.getUint32(L*4,!0),M.quaternion);else{let Q=w[L*3]/127.5-1,U=w[L*3+1]/127.5-1,I=w[L*3+2]/127.5-1;M.quaternion.x=Q,M.quaternion.y=U,M.quaternion.z=I,M.quaternion.w=Math.sqrt(Math.max(0,1-Q*Q-U*U-I*I))}if(D&&(T.decodeOct24(D[L*3]|D[L*3+1]<<8|D[L*3+2]<<16,M.normal),M.roughness=D[i*3+L]/255,M.metallic=D[i*4+L]/255),p(L,d?d.splat(M):M),h&&_){for(let Q=0;Q<g;Q+=1)b[Q]=(_[L*g+Q]-128)/128;h(L,d?d.sh(b,c):b)}}if(o.lodTree){let L=new DataView(o.lodTree.buffer,o.lodTree.byteOffset,o.lodTree.byteLength),Q=y.addBundle("lodTree",H.LOD_TREE).bundles.lodTree.channels.node.data;for(let U=0;U<i;U+=1)Q[U*2]=L.getUint16(U*2,!0),Q[U*2+1]=L.getUint32(i*2+U*4,!0)}return{splats:y}}function St(r,e){let t=new Uint8Array(8+e.byteLength),n=new DataView(t.buffer);return n.setUint32(0,r,!0),n.setUint32(4,e.byteLength,!0),t.set(e,8),t}var an=r=>{let e=new Uint8Array(r.reduce((n,a)=>n+a.byteLength,0)),t=0;for(let n of r)e.set(n,t),t+=n.byteLength;return e};async function Ia(r,{version:e=3,fractionalBits:t=12,antialiased:n=!0,pbr:a=!1,lod:o,sh:s=!0,coordinateSystem:i,zstdLevel:c,progress:l}={}){if(e!==2&&e!==3&&e!==4)throw new Error(`SPZ version ${String(e)} cannot be written (2, 3 or 4)`);let u=H.decoder(H.get(r).bundle),f=H.findLodTree(r),d=o??f!==void 0;if(d&&!f)throw new Error("SpzFile.write with lod needs a lodTree bundle");let y=s?O.find(r.bundles):void 0,p=y&&O.decoder(r,y),h=y?nt[y.degree]*3:0,g=new Float32Array(O.VALUES),b=r.count,x=e===2?3:4,A=16+b*9,C=A+b,B=C+b*3,w=B+b*3,_=w+b*x,D=_+b*h,E=D+(d?b*Yt:0),R=E+(a?b*Zt:0),m=new Uint8Array(R),v=new DataView(m.buffer),M=n?on:0;v.setUint32(0,_e,!0),v.setUint32(4,e,!0),v.setUint32(8,b,!0),v.setUint8(12,y?.degree??0),v.setUint8(13,t),v.setUint8(14,M|(e<4?(a?sn:0)|(d?cn:0):0));let z=1<<t,k=S=>Math.round(Math.max(0,Math.min(255,S))),P=S=>k(((S-.5)/yn+.5)*255),L=S=>k((Math.log(Math.max(S,Number.MIN_VALUE))+10)*16),Q=(S,q)=>{let $e=Math.max(-8388607,Math.min(8388607,Math.round(q*z)));m[S]=$e&255,m[S+1]=$e>>8&255,m[S+2]=$e>>16&255},U=H.makeExtSplat(),I={x:0,y:0,z:0,w:1},N=ae(Ne(l,0,.8),b,"encoding");for(let S=0;S<b;S+=1){if(N(S),u(S,U),Q(16+S*9,U.center.x),Q(16+S*9+3,U.center.y),Q(16+S*9+6,U.center.z),m[C+S*3]=P(U.rgb.r),m[C+S*3+1]=P(U.rgb.g),m[C+S*3+2]=P(U.rgb.b),m[B+S*3]=L(U.scales.x),m[B+S*3+1]=L(U.scales.y),m[B+S*3+2]=L(U.scales.z),m[A+S]=k(U.opacity*255),e===2){re.normalizeQuat(U.quaternion,I);let q=I.w<0?-1:1;m[w+S*3]=k((I.x*q+1)*127.5),m[w+S*3+1]=k((I.y*q+1)*127.5),m[w+S*3+2]=k((I.z*q+1)*127.5)}else v.setUint32(w+S*4,$a(U.quaternion),!0);if(p){p(S,g);for(let q=0;q<h;q+=1)m[_+S*h+q]=k(g[q]*128+128)}if(d){let q=f.channels.node.data;v.setUint16(D+S*2,q[S*2]&65535,!0),v.setUint32(D+b*2+S*4,q[S*2+1],!0)}if(a){let q=T.encodeOct24(U.normal);m[E+S*3]=q&255,m[E+S*3+1]=q>>8&255,m[E+S*3+2]=q>>16&255,m[E+b*3+S]=T.encodeUnorm8(U.roughness),m[E+b*4+S]=T.encodeUnorm8(U.metallic)}}if(l?.(.8,"compressing"),e<4){let S=await se.gzip(m);return l?.(1,"compressing"),S}let K=[],W=r.meta.safeOrbitCamera;W&&K.push(St(ln,new Uint8Array(Float32Array.of(W.elevationMin,W.elevationMax,W.radiusMin).buffer)));let V=i??r.meta.coordinateSystem;if(V&&V!=="RUB"){let S=pe.SYSTEMS.indexOf(V)+1;if(S===0)throw new Error(`Unknown coordinate system ${V}`);K.push(St(fn,new Uint8Array(Uint32Array.of(S).buffer)))}d&&K.push(St(un,await fe.compress(m.subarray(D,E),{level:c}))),a&&K.push(St(dn,await fe.compress(m.subarray(E,R),{level:c})));let j=[],Y=[],F=[16,A,C,B,w,_,D];for(let S=0;S<6;S+=1)F[S+1]>F[S]&&(j.push(await fe.compress(m.subarray(F[S],F[S+1]),{level:c})),Y.push(F[S+1]-F[S]));let G=an(K),X=new Uint8Array(32+G.byteLength+j.length*16),$=new DataView(X.buffer);$.setUint32(0,_e,!0),$.setUint32(4,jt,!0),$.setUint32(8,b,!0),X[12]=y?.degree??0,X[13]=t,X[14]=M|(K.length>0?Kt:0),X[15]=j.length,$.setUint32(16,32+G.byteLength,!0),X.set(G,32);for(let S=0;S<j.length;S+=1){let q=32+G.byteLength+S*16;$.setUint32(q,j[S].byteLength%2**32,!0),$.setUint32(q+4,Math.floor(j[S].byteLength/2**32),!0),$.setUint32(q+8,Y[S],!0)}return l?.(1,"compressing"),an([X,...j])}var Ie=class{static read=_a;static write=Ia;static unpack=bn};function $a(r){let e=re.normalizeQuat(r,{x:0,y:0,z:0,w:1}),t=[e.x,e.y,e.z,e.w],n=0;for(let s=1;s<4;s+=1)Math.abs(t[s])>Math.abs(t[n])&&(n=s);let a=t[n]<0?1:0,o=n;for(let s=0;s<4;s+=1)if(s!==n){let i=(t[s]<0?1:0)^a,c=Math.max(0,Math.min(511,Math.round(511*Math.abs(t[s])/Math.SQRT1_2)));o=o<<10|i<<9|c}return o>>>0}function Na(r,e){let t=r>>>30,n=[0,0,0,0],a=r,o=0;for(let s=3;s>=0;s-=1)if(s!==t){let i=Math.SQRT1_2*((a&511)/511)*(a>>>9&1?-1:1);a>>>=10,n[s]=i,o+=i*i}n[t]=Math.sqrt(Math.max(1-o,0)),[e.x,e.y,e.z,e.w]=n}var Me=class r{static detectFormat(e,t=""){let n=e.byteLength>=4?new DataView(e.buffer,e.byteOffset,e.byteLength).getUint32(0,!0):0;if(n===pt)return"rdx";if(n===yt||n===Ge)return"rad";if(e[0]===112&&e[1]===108&&e[2]===121)return"ply";let a=t.toLowerCase().replace(/[?#].*$/,"").split(".").pop();if(e[0]===31&&e[1]===139||n===_e||a==="spz")return"spz";throw new Error(`Unknown splat file format${t?`: ${t}`:""}`)}static async decode(e,{name:t="",progress:n,layout:a="extSplats",encoding:o,sh:s,coordinateSystem:i}={}){let c={progress:n,layout:a,encoding:o,sh:s,coordinateSystem:i};switch(r.detectFormat(e,t)){case"rdx":return{splats:r.withSh(H.convert(await Fe.decode(e,{progress:n}),{layout:a,encoding:o}),s)};case"rad":return Oe.read(e,c);case"ply":case"compressed-ply":return he.read(e,c);case"spz":return Ie.read(e,c)}}static withSh(e,t){let n=e,a=O.find(n.bundles);return t===void 0||!a?e:t===!1?(n.removeBundle(a.name),n.meta.ignoredShDegree=a.degree,e):O.convert(n,t)}static async encode(e,t,n={}){switch(n.shPalette&&t!=="rad"&&n.sh!==!1&&(e=n.shPalette.expanded(e)),t){case"ply":return he.write(e,n);case"compressed-ply":return We.write(e,n);case"spz":return Ie.write(e,n);case"rad":return Oe.write(e,n);case"rdx":return Fe.encode(e,n)}}static async fetch(e,{init:t,progress:n,...a}={}){let o=await fetch(e,t);if(!o.ok)throw new Error(`Failed to load ${e}: ${o.status}`);let s=await Gt(o,Ne(n,0,.4));return r.decode(s,{...a,name:e,progress:Ne(n,.4,1)})}};var Va={async loadSplats({url:r,bytes:e,name:t,layout:n,encoding:a,sh:o,coordinateSystem:s,palette:i=!0,request:c},{progress:l,signal:u}){let f={progress:l,layout:n,encoding:a,sh:o,coordinateSystem:s},{splats:d,shPalette:y}=e?await Me.decode(e,{...f,name:t}):await Me.fetch(r,{...f,init:{...c,signal:u}});return y&&!i?{splats:y.expanded(d).toTransferable()}:{splats:d.toTransferable(),shPalette:y?.data.toTransferable()}},async writeSplats({data:r,shPalette:e,format:t,options:n},{progress:a}){let o=Z.fromTransferable(r),s=e&&new xe(Z.fromTransferable(e)),i=()=>({data:o.toTransferable(),shPalette:s?.data.toTransferable()});try{return{bytes:await Me.encode(o,t,{...n,shPalette:s,progress:a}),error:void 0,...i()}}catch(c){return{bytes:void 0,error:c instanceof Error?c.message:String(c),...i()}}},sortKeys({keys:r,count:e,bits:t,ordering:n}){return{...Se.sort({keys:r,count:e,bits:t,ordering:n}),keys:r}}};function Ha(r){let e=0,t,n=0;return(a,o)=>{n=Math.max(n,a);let s=performance.now();(s-e>=50||o!==t||n>=1)&&(e=s,t=o,self.postMessage({id:r,progress:[n,o]}))}}function Qa(){let r=new Map;self.onmessage=async e=>{let{id:t,name:n,args:a,cancel:o}=e.data;if(o){r.get(t)?.abort();return}let s=new AbortController;r.set(t,s);let i=Ha(t),c=(l,u)=>{s.signal.throwIfAborted(),i(l,u)};try{let l=Va[n];if(!l)throw new Error(`Unknown worker call ${n}`);let u=await l(a,{progress:c,signal:s.signal});self.postMessage({id:t,result:u},{transfer:Z.transferables(u)})}catch(l){self.postMessage({id:t,error:l instanceof Error?l.message:String(l)})}finally{r.delete(t)}}}export{Z as ArrayData,ce as ArrayFormats,pe as Axes,De as ByteReader,We as CompressedPlyFile,se as Compression,T as Encoding,he as PlyFile,Oe as RadFile,Fe as RdxFile,O as Sh,xe as ShPalette,Se as SortKeys,Me as SplatFiles,re as SplatMath,H as Splats,Ie as SpzFile,ie as TextureLayout,fe as Zstd,ct as decodeShScale,ne as defineBundle,pr as encodeShScale,Qa as serveWorker};\n';

// src/worker/WorkerPool.ts
var coreUrl;
var shimUrl;
var blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
var nextId = 1;
var PooledWorker = class {
  worker = new Worker(shimUrl ??= blobUrl(`import { serveWorker } from ${JSON.stringify(WorkerPool.coreUrl)}; serveWorker();`), { type: "module" });
  // Set once the worker failed or was terminated; calls then reject
  dead;
  pending = /* @__PURE__ */ new Map();
  constructor(onDeath) {
    this.worker.onmessage = (event) => {
      const { id, result, error, progress } = event.data;
      const entry = this.pending.get(id);
      if (progress) {
        entry?.onProgress?.(progress[0], progress[1]);
        return;
      }
      this.pending.delete(id);
      if (error !== void 0) {
        entry?.reject(new Error(error));
      } else {
        entry?.resolve(result);
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error(`Worker failed: ${event.message || "uncaught error"}`));
      onDeath(this);
    };
    this.worker.onmessageerror = () => {
      this.terminate(new Error("Worker message could not be deserialized"));
      onDeath(this);
    };
  }
  call(name, args, { onProgress, signal } = {}) {
    if (this.dead) {
      return Promise.reject(this.dead);
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        this.worker.postMessage({ id, cancel: true });
        reject(signal.reason);
      };
      const settle = (finish) => (value) => {
        signal?.removeEventListener("abort", abort);
        finish(value);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), onProgress });
      this.worker.postMessage({ id, name, args }, { transfer: ArrayData.transferables(args) });
    });
  }
  terminate(reason = new Error("Worker terminated")) {
    this.dead ??= reason;
    this.worker.terminate();
    this.pending.forEach(({ reject }) => reject(reason));
    this.pending.clear();
  }
};
var WorkerLease = class {
  worker;
  pool;
  constructor(worker, pool) {
    this.worker = worker;
    this.pool = pool;
  }
  call(name, args, options) {
    if (!this.worker) {
      throw new Error("WorkerLease already released");
    }
    return this.worker.call(name, args, options);
  }
  release() {
    if (this.worker) {
      this.pool.give(this.worker);
      this.worker = void 0;
    }
  }
};
var WorkerPool = class _WorkerPool {
  size;
  static shared;
  workers = [];
  idle = [];
  waiting = [];
  disposed = false;
  constructor({ size = 4 } = {}) {
    this.size = size;
  }
  // The shared pool, made on first use (still without workers)
  static get default() {
    return _WorkerPool.shared ??= new _WorkerPool();
  }
  // A blob URL of core/ as one ES module (made on first use), for
  // an app's own module workers to `await import(url)`: the copy the pool's
  // workers run, so no second file is needed
  static get coreUrl() {
    return coreUrl ??= blobUrl(coreModule_default);
  }
  // Whether this context can make workers (a page; not Node, not a worker)
  static get available() {
    return typeof Worker !== "undefined" && typeof window !== "undefined";
  }
  // Workers made so far (alive)
  get workerCount() {
    return this.workers.length;
  }
  async call(name, args, options) {
    const lease = await this.acquire({ signal: options?.signal });
    try {
      return await lease.call(name, args, options);
    } finally {
      lease.release();
    }
  }
  // A worker for the caller alone, once one is free; `signal` stops waiting.
  // A disposed pool makes no more workers: it rejects.
  async acquire({ signal } = {}) {
    if (this.disposed) {
      throw new Error("WorkerPool disposed");
    }
    signal?.throwIfAborted();
    const worker = this.idle.pop() ?? this.spawn() ?? await this.wait(signal);
    return new WorkerLease(worker, this);
  }
  // Back from a lease: to the longest waiting caller, else idle. A dead
  // worker is dropped; a waiter then gets a new one.
  give(worker) {
    if (this.disposed) {
      worker.terminate(new Error("WorkerPool disposed"));
      return;
    }
    if (worker.dead) {
      const replacement = this.waiting.length > 0 ? this.spawn() : void 0;
      if (replacement) {
        this.waiting.shift().resolve(replacement);
      }
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter.resolve(worker);
    } else {
      this.idle.push(worker);
    }
  }
  // Terminates the workers (their pending calls reject) and rejects the
  // queued acquire() and call() waiters
  dispose() {
    this.disposed = true;
    this.workers.forEach((worker) => worker.terminate(new Error("WorkerPool disposed")));
    this.workers = [];
    this.idle = [];
    this.waiting.splice(0).forEach(({ reject }) => reject(new Error("WorkerPool disposed")));
  }
  // In line for the next worker given back; an abort leaves the line
  wait(signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter((w) => w !== waiter);
        reject(signal.reason);
      };
      const waiter = {
        resolve: (worker) => {
          signal?.removeEventListener("abort", abort);
          resolve(worker);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiter);
    });
  }
  spawn() {
    if (this.workers.length >= this.size) {
      return void 0;
    }
    const worker = new PooledWorker((dead) => this.remove(dead));
    this.workers.push(worker);
    return worker;
  }
  // A worker died: forget it (a leased one is replaced when given back)
  remove(worker) {
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
  }
};

// src/worker/splatFiles.ts
function workerTarget(worker) {
  if (worker === false || worker === void 0 && !WorkerPool.available) {
    return void 0;
  }
  if (worker === true || worker === void 0) {
    if (!WorkerPool.available) {
      throw new Error("Workers are unavailable here");
    }
    return WorkerPool.default;
  }
  return worker;
}
async function loadSplats(source, options = {}) {
  return (await load(source, options, false)).splats;
}
async function loadSplatFile(source, options = {}) {
  return load(source, options, true);
}
async function load(source, {
  name,
  worker,
  onProgress,
  layout = "extSplats",
  encoding,
  sh,
  coordinateSystem,
  request,
  signal
}, palette) {
  signal?.throwIfAborted();
  const target = workerTarget(worker);
  let url;
  let bytes2;
  if (typeof source === "string" || source instanceof URL) {
    url = typeof location !== "undefined" ? new URL(source, location.href).href : String(source);
  } else if (source instanceof Blob) {
    bytes2 = new Uint8Array(await source.arrayBuffer());
    name ??= source.name;
  } else {
    bytes2 = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  }
  if (!target) {
    const progress = signal ? (fraction, stage) => {
      signal.throwIfAborted();
      onProgress?.(fraction, stage);
    } : onProgress;
    const into = { layout, encoding, sh, coordinateSystem, progress };
    const loaded = bytes2 ? await SplatFiles.decode(bytes2, { ...into, name }) : await SplatFiles.fetch(url, { ...into, init: { ...request, signal } });
    signal?.throwIfAborted();
    return palette || !loaded.shPalette ? loaded : { splats: loaded.shPalette.expanded(loaded.splats) };
  }
  const sent = request?.headers ? { ...request, headers: Object.fromEntries(new Headers(request.headers)) } : request;
  const result = await target.call("loadSplats", { url, bytes: bytes2, name, layout, encoding, sh, coordinateSystem, palette, request: sent }, { onProgress, signal });
  return {
    splats: ArrayData.fromTransferable(result.splats),
    shPalette: result.shPalette && new ShPalette(ArrayData.fromTransferable(result.shPalette))
  };
}
async function writeSplats(data, format, { worker, onProgress, shPalette, ...options } = {}) {
  const target = workerTarget(worker);
  if (!target) {
    return SplatFiles.encode(data, format, { ...options, shPalette, progress: onProgress });
  }
  const result = await target.call("writeSplats", { data: data.toTransferable(), shPalette: shPalette?.data.toTransferable(), format, options }, { onProgress });
  data.setFromTransferable(result.data);
  if (shPalette && result.shPalette) {
    shPalette.data.setFromTransferable(result.shPalette);
  }
  if (result.error !== void 0) {
    throw new Error(result.error);
  }
  return result.bytes;
}

// src/worker/splatSort.ts
async function sortSplatKeys(keys, { bits, ordering, worker }) {
  const count = keys.length;
  const reuse = ordering && ordering.length >= TextureLayout.alignCapacity(count) ? ordering : void 0;
  const target = workerTarget(worker);
  if (!target) {
    return { ...SortKeys.sort({ keys, count, bits, ordering: reuse }), keys };
  }
  return target.call("sortKeys", { keys, count, bits, ordering: reuse });
}

// src/render/splatDraw.ts
import * as THREE11 from "three";
import { NodeMaterial as NodeMaterial2 } from "three/webgpu";
var { Discard: Discard2, Fn: Fn7, If: If12, instanceIndex: instanceIndex2, log: log4, max: max10, min: min7, select: select15, sqrt: sqrt4, sRGBTransferEOTF: sRGBTransferEOTF2, struct: struct3, uint: uint19, varyingProperty, vec2: vec24, vec3: vec310, vec4: vec410, vertexIndex } = TSL;
var DrawVertex = struct3({
  position: "vec4",
  uv: "vec2",
  localDir: "vec3",
  localCross: "vec3",
  c2: "float",
  rgb: "vec3",
  opacity: "float",
  cutoff: "float"
}, "SplatDrawVertex");
var quadCorner = (v) => vec24(v.bitAnd(uint19(1)), v.shiftRight(uint19(1)).bitAnd(uint19(1))).mul(2).sub(1);
function quadIndices(quads) {
  const indices = new Uint16Array(quads * 6);
  for (let q = 0; q < quads; q += 1) {
    indices.set([0, 1, 2, 2, 1, 3].map((corner) => q * 4 + corner), q * 6);
  }
  return indices;
}
function makeDrawMaterial(options) {
  const material = new NodeMaterial2();
  material.name = "radix_splatDraw";
  material.transparent = true;
  material.blending = THREE11.CustomBlending;
  material.blendSrc = THREE11.OneFactor;
  material.blendDst = THREE11.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE11.OneFactor;
  material.blendDstAlpha = THREE11.OneMinusSrcAlphaFactor;
  material.depthTest = true;
  material.depthWrite = false;
  material.side = THREE11.DoubleSide;
  material.forceSinglePass = true;
  material.fog = false;
  setDrawNodes(material, options);
  return material;
}
function setDrawNodes(material, options) {
  const { vertexNode, fragmentNode } = drawNodes(options);
  material.vertexNode = vertexNode;
  material.fragmentNode = fragmentNode;
  const key = `splatDraw:${nextDrawKey++}`;
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}
var nextDrawKey = 0;
function drawNodes({ projection, eyes, projected, order, count, quads, encodeLinear }) {
  const params = SplatParams.nodes;
  const v = eyes === 1 ? uint19(0) : splatViewIndex;
  const types = { uv: "vec2", localDir: "vec3", localCross: "vec3", c2: "float" };
  const varyings = Object.fromEntries(projection.varyings.map((name) => [name, varyingProperty(types[name], `vSplat_${name}`)]));
  const rgb2 = varyingProperty("vec3", "vSplatRgb");
  const opacity = varyingProperty("float", "vSplatOpacity");
  const cutoff = varyingProperty("float", "vSplatCutoff");
  const vertex = Fn7(() => {
    const out = DrawVertex().toVar();
    out.get("position").assign(vec410(0, 0, 2, 1));
    out.get("uv").assign(vec24(0));
    out.get("localDir").assign(vec310(0));
    out.get("localCross").assign(vec310(0));
    out.get("c2").assign(0);
    out.get("rgb").assign(vec310(0));
    out.get("opacity").assign(0);
    out.get("cutoff").assign(0);
    const i = instanceIndex2.mul(uint19(quads)).add(vertexIndex.shiftRight(uint19(2))).toVar();
    const index = select15(i.lessThan(count), order(i), projected.count).toVar();
    If12(index.lessThan(projected.count), () => {
      const words = projection.loadWords(projected, eyes, index);
      const head = words.slice(0, projection.headWords);
      const eyeWords = words.slice(head.length, head.length + projection.eyeWords).map((word, k) => eyes === 1 ? word : select15(v.equal(uint19(0)), word, words[head.length + projection.eyeWords + k]).toVar());
      const look = projection.look(head, eyeWords);
      If12(look.visible, () => {
        const alpha = look.opacity.toVar();
        const bound = params.maxStdDev.toVar();
        const cut = params.maxStdDev.toVar();
        If12(alpha.greaterThan(1), () => {
          alpha.assign(min7(alpha.mul(4).sub(3), 5));
          bound.assign(params.maxStdDev.add(alpha.sub(1).mul(0.7)));
          cut.assign(bound);
        }).ElseIf(params.falloff.greaterThanEqual(1), () => {
          cut.assign(min7(cut, sqrt4(log4(max10(alpha, params.minAlpha).div(params.minAlpha)).mul(2))));
        });
        projection.vertex(head, eyeWords, SplatCamera.eye(v), quadCorner(vertexIndex), bound, cut, out);
        out.get("rgb").assign(max10(look.rgb, vec310(0)));
        out.get("opacity").assign(alpha);
        out.get("cutoff").assign(cut);
      });
    });
    for (const name of projection.varyings) {
      varyings[name].assign(out.get(name));
    }
    rgb2.assign(out.get("rgb"));
    opacity.assign(out.get("opacity"));
    cutoff.assign(out.get("cutoff"));
    return out.get("position");
  });
  const fragment = Fn7(() => {
    const z2 = projection.density(varyings).toVar();
    If12(z2.greaterThan(cutoff.mul(cutoff)), () => {
      Discard2();
    });
    const alpha = fragmentAlpha(z2, opacity, params.falloff).toVar();
    If12(alpha.lessThan(params.minAlpha), () => {
      Discard2();
    });
    const color = select15(encodeLinear.greaterThan(0.5), sRGBTransferEOTF2(rgb2), rgb2);
    return vec410(color.mul(alpha), alpha);
  });
  return { vertexNode: vertex(), fragmentNode: fragment() };
}
function outputIsLinear(renderer) {
  const target = renderer.getRenderTarget();
  if (target === null) {
    if (renderer.xr.isPresenting && renderer.backend.isWebGPUBackend) {
      const binding = renderer.xr.getWebGPUBinding?.();
      return binding?.getPreferredColorFormat().endsWith("-srgb") === true;
    }
    return renderer.needsFrameBufferTarget === true && !hdrToneMappingActive(renderer);
  }
  if (target.isPostProcessingRenderTarget && hdrToneMappingActive(renderer)) {
    return false;
  }
  const texture = target.texture;
  return texture.colorSpace === THREE11.SRGBColorSpace || texture.type !== THREE11.UnsignedByteType;
}

// src/render/SplatView.ts
import * as THREE12 from "three";
var SplatView = class {
  splats;
  key;
  // Over the renderer's, field by field
  params = {};
  objectParams = {};
  // Unset: the renderer's
  modifier;
  covModifier;
  modifierSpace;
  sortBits;
  autoSort;
  _collection;
  _order;
  // The applied order's indices (ArrayData.INDICES)
  orderArrays;
  sorts = 0;
  // In cpu mode, collections of sorts in flight and of the newest landed
  // order not yet applied (`landed`), by version
  pending = /* @__PURE__ */ new Map();
  landed = 0;
  keyArrays = [];
  disposed = false;
  autoSorting = false;
  sortRequested = false;
  sortedFrom;
  /** @internal Made by SplatRenderer.viewFor */
  constructor(splats, key) {
    this.splats = splats;
    this.key = key;
  }
  // The collection this view draws instead of its renderer's
  get collection() {
    return this._collection;
  }
  set collection(collection) {
    this._collection = collection;
    this.splats.updateLive();
  }
  // The applied order (cpu mode draws its collection)
  get order() {
    return this._order;
  }
  // Sort again at the next render, for changes autoSort can't see (a
  // generator's splats moved, a uniform of it changed), also with autoSort
  // off. With a sort in flight, the next one starts when it finishes, since
  // its sort keys may predate the change. Calls the renderer's onInvalidate
  // unless a sort in flight will.
  requestSort() {
    this.wantSort();
    if (!this.autoSorting) {
      this.splats.onInvalidate?.(this);
    }
  }
  // Sort this view's collection (as of this call) from `camera`: its keys
  // are computed on the GPU now, then read back and sorted on a worker. In
  // gpu mode only with the renderer's sortWorker, and its orders cannot be
  // applied.
  async sort(camera2) {
    this.checkDisposed();
    if (this.splats.sortMode === "gpu" && !this.splats.sortWorker) {
      throw new Error('SplatView.sort: a CPU sort needs sortMode "cpu" or a sortWorker');
    }
    const settings = this.splats.settingsOf(this);
    const { collection, sortBits: bits } = settings;
    const version = this.sorts += 1;
    if (this.splats.sortMode === "cpu") {
      this.pending.set(version, collection);
      this.splats.updateLive();
    }
    try {
      let ordering = new Uint32Array(0);
      let visible = 0;
      const timing = { keysMs: 0, sortMs: 0 };
      if (collection.count > 0) {
        const renderer = this.splats.renderer;
        const keys = this.keyArrays.pop() ?? new GpuArrays({ renderer, bundles: { sortKeys: SortKeys.KEYS }, storage: isWebGPUBackend(renderer) });
        const start = performance.now();
        let read;
        try {
          SplatCamera.set(renderer, camera2);
          projectCollection({ renderer, settings, collection, arrays: keys, pass: "keys" });
          this.checkDisposed();
          read = await readSortKeys(keys, collection.count);
        } finally {
          if (this.disposed) {
            keys.dispose();
          } else {
            this.keyArrays.push(keys);
          }
        }
        this.checkDisposed();
        const sorting = performance.now();
        ({ ordering, visible } = await this.splats.sortKeys(read, bits));
        this.checkDisposed();
        timing.keysMs = sorting - start;
        timing.sortMs = performance.now() - sorting;
      }
      this.land(version);
      return { collection, version, ordering, visible, ...timing };
    } catch (error) {
      if (this.pending.delete(version)) {
        this.splats.updateLive();
      }
      throw error;
    }
  }
  // Draw `order` from now on (cpu mode); whether it was applied. Not once
  // an order of a later sort has landed or been applied, nor in gpu mode.
  apply(order) {
    if (this.disposed || this.splats.sortMode !== "cpu" || !this.pending.has(order.version)) {
      return false;
    }
    const data = new ArrayData({ count: order.visible }).addBundle("indices", ArrayData.INDICES, { data: { index: order.ordering } });
    this.orderArrays ??= new GpuArrays({ renderer: this.splats.renderer, bundles: { indices: ArrayData.INDICES }, capacity: 1 });
    this.orderArrays.upload(data);
    this._order = order;
    for (const version of [...this.pending.keys()]) {
      if (version <= order.version) {
        this.pending.delete(version);
      }
    }
    this.landed = this.landed > order.version ? this.landed : 0;
    this.splats.updateLive();
    return true;
  }
  // Free the view's arrays and take it off its renderer (its orders no
  // longer hold their objects)
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.orderArrays?.dispose();
    this.keyArrays.forEach((keys) => keys.dispose());
    this.keyArrays = [];
    this._order = void 0;
    this.pending.clear();
    this.splats.forget(this);
  }
  /**
   * @internal SplatRenderer's, before a render in cpu mode, after
   * autoSort's step: the applied order's collection, with its indices
   */
  drawn(camera2) {
    this.autoSortStep(camera2);
    return this._order && this.orderArrays && { collection: this._order.collection, arrays: this.orderArrays, visible: this._order.visible };
  }
  /** @internal The collections this view holds live: its own, and in cpu mode its orders' */
  collections() {
    const collections = this._collection ? [this._collection] : [];
    if (this._order) {
      collections.push(this._order.collection);
    }
    this.pending.forEach((collection) => collections.push(collection));
    return collections;
  }
  /** @internal requestSort without onInvalidate (cpu mode only) */
  wantSort() {
    if (this.splats.sortMode === "cpu") {
      this.sortRequested = true;
    }
  }
  /** @internal The renderer switched to gpu: the orders go */
  dropOrders() {
    this._order = void 0;
    this.pending.clear();
    this.landed = 0;
    this.sortRequested = false;
  }
  // An order of version `version` landed: older landed ones can no longer
  // be applied, nor this one if a later one landed or was applied
  land(version) {
    if (!this.pending.has(version)) {
      return;
    }
    if (version < this.landed || this._order && version <= this._order.version) {
      this.pending.delete(version);
    } else {
      this.pending.delete(this.landed);
      this.landed = version;
    }
    this.splats.updateLive();
  }
  checkDisposed() {
    if (this.disposed) {
      throw new Error("SplatView.sort: the view is disposed");
    }
  }
  autoSortStep(camera2) {
    if (this.autoSorting) {
      return;
    }
    const settings = this.splats.settingsOf(this);
    if (settings.collection.count === 0 || !(this.sortRequested || settings.autoSort && this.needsSort(camera2, settings, settings.autoSort))) {
      return;
    }
    this.sortRequested = false;
    camera2.updateMatrixWorld();
    const position = new THREE12.Vector3();
    const quaternion = new THREE12.Quaternion();
    camera2.matrixWorld.decompose(position, quaternion, new THREE12.Vector3());
    this.sortedFrom = {
      collection: settings.collection,
      bits: settings.sortBits,
      position,
      quaternion,
      projection: [...lensOf(camera2).elements],
      matrices: matrices(settings.collection)
    };
    this.autoSorting = true;
    this.sort(camera2).then((order) => {
      this.autoSorting = false;
      if (this.apply(order)) {
        this.splats.onInvalidate?.(this);
      }
    }).catch((error) => {
      this.autoSorting = false;
      if (!this.disposed) {
        console.error("SplatView autoSort:", error);
      }
    });
  }
  needsSort(camera2, { collection, sortBits: sortBits2, objectParams }, auto) {
    const from = this.sortedFrom;
    if (!this._order || !from || from.collection !== collection || from.bits !== sortBits2) {
      return true;
    }
    camera2.updateMatrixWorld();
    const position = scratch4.position;
    const quaternion = scratch4.quaternion;
    camera2.matrixWorld.decompose(position, quaternion, scratch4.scale);
    if (position.distanceTo(from.position) > auto.distance) {
      return true;
    }
    const guarded2 = objectParams.sortGuard > 0 || collection.objects.some(({ object }) => (object.params?.sortGuard ?? 0) > 0);
    if (guarded2 && (quaternion.angleTo(from.quaternion) > auto.angle || lensOf(camera2).elements.some((value, k) => value !== from.projection[k]))) {
      return true;
    }
    return collection.objects.some(({ object }, i) => SplatCollection.matrixWorldOf(object).elements.some((value, k) => value !== from.matrices[i][k]));
  }
};
function matrices(collection) {
  return collection.objects.map(({ object }) => [...SplatCollection.matrixWorldOf(object).elements]);
}
function lensOf(camera2) {
  const array = camera2;
  return (array.isArrayCamera && array.cameras.length > 0 ? array.cameras[0] : camera2).projectionMatrix;
}
var scratch4 = { position: new THREE12.Vector3(), quaternion: new THREE12.Quaternion(), scale: new THREE12.Vector3() };

// src/render/SplatRenderer.ts
var { uniform: uniform15 } = TSL;
var QUADS = WgpuSplatSorter.QUADS_PER_INSTANCE;
var QUAD_INDEX = new THREE13.BufferAttribute(quadIndices(QUADS), 1);
QUAD_INDEX.name = "radix_splatQuadIndex";
var MANY_VIEWS = 32;
var sharedSortPool;
var SplatRenderer = class _SplatRenderer extends THREE13.Mesh {
  // Every undisposed renderer, and the objects with a release that have
  // been live in one and not released yet
  static renderers = /* @__PURE__ */ new Set();
  static watched = /* @__PURE__ */ new Set();
  static lost = new FinalizationRegistry((token) => {
    console.warn("SplatRenderer: a renderer was garbage-collected without dispose(); its objects are released now");
    _SplatRenderer.renderers.delete(token.ref);
    _SplatRenderer.sweep();
  });
  // Workers of the shared sort pool: read when the pool is made, at the
  // first CPU sort of any renderer, so set it before then
  static sortWorkers = 4;
  // The pool every renderer's CPU sorts share (all their views; renderers
  // with a sortWorker use that instead), so parallel sorts stay bounded and
  // never queue behind file loads in WorkerPool.default. Made on first use,
  // its workers as sorts need them; it lives with the page.
  static get sortPool() {
    return sharedSortPool ??= new WorkerPool({ size: _SplatRenderer.sortWorkers });
  }
  renderer;
  method;
  sortBits;
  params;
  objectParams;
  modifier;
  covModifier;
  modifierSpace;
  autoSort;
  // Where CPU sorts run: by default SplatRenderer.sortPool, shared by every
  // renderer; a given pool or lease is the app's
  sortWorker;
  // The key of the view a render from `camera` draws when `view` is unset:
  // the camera itself by default. Map cameras an app makes anew (a clone
  // per frame, say) to keys of its own, so they share views instead of
  // each making one in cpu mode.
  viewKey;
  // Something this renderer did (an autoSort order applied) or was asked
  // to do (requestSort) needs a render to show: of `view`, or of every
  // viewpoint when undefined. For on-demand rendering.
  onInvalidate;
  // The view every render draws; unset: the one of viewKey(camera)
  view;
  // Runs the "project" and "sort" steps (a GpuProfiler's phase, say)
  phase;
  _collection;
  _sortMode = "gpu";
  _views = /* @__PURE__ */ new Map();
  warnedViews = false;
  live = /* @__PURE__ */ new Set();
  token;
  disposed = false;
  projected;
  sorter;
  // renderer.info.render.calls after the latest prepare()
  preparedAt = -1;
  orderReader = new GpuArrayReader(ArrayData.INDICES);
  orderCount = uniform15(0, "uint");
  encodeLinear = uniform15(0);
  // What the material draws: the projected arrays (by their reader) and the
  // order source
  drawState;
  constructor({
    renderer,
    collection = SplatCollection.EMPTY,
    method = "ewa",
    sortBits: sortBits2 = 24,
    params,
    objectParams,
    modifier,
    covModifier,
    modifierSpace = "view",
    sortMode,
    autoSort = { distance: 0, angle: 0 },
    sortWorker,
    viewKey = (camera2) => camera2,
    onInvalidate
  }) {
    const geometry = new THREE13.InstancedBufferGeometry();
    geometry.setIndex(QUAD_INDEX);
    geometry.instanceCount = 0;
    super(geometry, new NodeMaterial3());
    this.renderer = renderer;
    this._collection = collection;
    this.method = method;
    this.sortBits = sortBits2;
    this.params = { ...SplatParams.VIEW, ...params };
    this.objectParams = { ...SplatParams.OBJECT, ...objectParams };
    this.modifier = modifier;
    this.covModifier = covModifier;
    this.modifierSpace = modifierSpace;
    this._sortMode = sortMode ?? (isWebGPUBackend(renderer) ? "gpu" : "cpu");
    this.autoSort = autoSort;
    this.sortWorker = sortWorker;
    this.viewKey = viewKey;
    this.onInvalidate = onInvalidate;
    this.frustumCulled = false;
    this.token = { ref: new WeakRef(this) };
    _SplatRenderer.renderers.add(this.token.ref);
    _SplatRenderer.lost.register(this, this.token, this);
    this.updateLive();
    this.projected = this.makeProjected(method, 1);
    this.buildMaterial(void 0);
  }
  // What every viewpoint draws unless its view sets its own collection
  get collection() {
    return this._collection;
  }
  set collection(collection) {
    this._collection = collection;
    this.updateLive();
  }
  // "gpu": the GPU sort every render (WebGPU); "cpu": each view's applied
  // order of a CPU sort. Switching to gpu drops the orders.
  get sortMode() {
    return this._sortMode;
  }
  set sortMode(mode) {
    this._sortMode = mode;
    if (mode === "gpu") {
      this._views.forEach((view) => view.dropOrders());
      this.updateLive();
    }
  }
  // The views made so far, by key
  get views() {
    return this._views;
  }
  // The view of `key` (a camera, or any value for a viewpoint of the
  // app's), made on first use; `options` are set on it
  viewFor(key, options = {}) {
    if (this.disposed) {
      throw new Error("SplatRenderer.viewFor: the renderer is disposed");
    }
    let view = this._views.get(key);
    if (!view) {
      view = new SplatView(this, key);
      this._views.set(key, view);
    }
    const { collection, params, objectParams, ...rest } = options;
    Object.assign(view.params, params);
    Object.assign(view.objectParams, objectParams);
    Object.assign(view, rest);
    if ("collection" in options) {
      view.collection = collection;
    }
    return view;
  }
  // Sort every view again at its next render (view.requestSort), and call
  // onInvalidate for all of them
  requestSort() {
    this._views.forEach((view) => view.wantSort());
    this.onInvalidate?.();
  }
  // The GPU sort's visible count of the latest render (a readback)
  async readSortedCount() {
    return this.sorter && !this.disposed ? this.sorter.readCount() : 0;
  }
  // A disposed renderer still in the scene draws nothing (projecting would
  // make GPU resources again)
  onBeforeRender(_renderer, _scene, camera2) {
    if (this.disposed) {
      this.geometry.instanceCount = 0;
      return;
    }
    if (this.renderer.info.render.calls === this.preparedAt + 1) {
      SplatCamera.set(this.renderer, camera2);
      SplatParams.setView(this.settingsOf(this.viewOf(camera2)).params);
      this.encodeLinear.value = outputIsLinear(this.renderer) ? 1 : 0;
      return;
    }
    this.update(camera2);
  }
  // Project and sort for `camera` now, outside a render (WebGL2 timer
  // queries do not nest); the next render draws that instead of projecting
  // again
  prepare(camera2) {
    if (this.disposed) {
      this.geometry.instanceCount = 0;
      return;
    }
    this.update(camera2);
    this.preparedAt = this.renderer.info.render.calls;
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    _SplatRenderer.lost.unregister(this);
    [...this._views.values()].forEach((view) => view.dispose());
    this.view = void 0;
    this.live = /* @__PURE__ */ new Set();
    _SplatRenderer.renderers.delete(this.token.ref);
    _SplatRenderer.sweep();
    this.projected.arrays.dispose();
    this.sorter?.dispose();
    this.sorter = void 0;
    this.material.dispose();
    this.geometry.setIndex(null);
    this.geometry.instanceCount = 0;
    this.geometry.dispose();
    this.visible = false;
  }
  /** @internal The settings `view` draws with: its own over this renderer's */
  settingsOf(view) {
    const own2 = {
      collection: this._collection,
      method: this.method,
      sortBits: this.sortBits,
      params: this.params,
      objectParams: this.objectParams,
      modifier: this.modifier,
      covModifier: this.covModifier,
      modifierSpace: this.modifierSpace,
      autoSort: this.autoSort
    };
    if (!view) {
      return own2;
    }
    return {
      collection: view.collection ?? own2.collection,
      method: own2.method,
      sortBits: view.sortBits ?? own2.sortBits,
      params: over(own2.params, view.params),
      objectParams: over(own2.objectParams, view.objectParams),
      modifier: view.modifier === null ? void 0 : view.modifier ?? own2.modifier,
      covModifier: view.covModifier === null ? void 0 : view.covModifier ?? own2.covModifier,
      modifierSpace: view.modifierSpace ?? own2.modifierSpace,
      autoSort: view.autoSort ?? own2.autoSort
    };
  }
  /** @internal Sort keys on the app's sortWorker, else the shared sort pool */
  async sortKeys(keys, bits) {
    if (this.disposed) {
      throw new Error("SplatRenderer.sortKeys: the renderer is disposed");
    }
    return sortSplatKeys(keys, { bits, worker: this.sortWorker ?? _SplatRenderer.sortPool });
  }
  /** @internal A view was disposed */
  forget(view) {
    if (this._views.get(view.key) === view) {
      this._views.delete(view.key);
    }
    if (this.view === view) {
      this.view = void 0;
    }
    this.updateLive();
  }
  /** @internal The live collections changed: watch new objects, release retired ones */
  updateLive() {
    if (this.disposed) {
      return;
    }
    const next = /* @__PURE__ */ new Set([this._collection]);
    this._views.forEach((view) => view.collections().forEach((collection) => next.add(collection)));
    const retired = [...this.live].some((collection) => !next.has(collection));
    for (const collection of next) {
      for (const { object } of this.live.has(collection) ? [] : collection.objects) {
        if (object.release) {
          _SplatRenderer.watched.add(object);
        }
      }
    }
    this.live = next;
    if (retired) {
      _SplatRenderer.sweep();
    }
  }
  // Release the watched objects no renderer's live collection holds any
  // longer, after the bookkeeping, so a release may change renderers and
  // views
  static sweep() {
    if (_SplatRenderer.watched.size === 0) {
      return;
    }
    const live = /* @__PURE__ */ new Set();
    for (const ref of _SplatRenderer.renderers) {
      for (const collection of ref.deref()?.live ?? []) {
        collection.objects.forEach(({ object }) => live.add(object));
      }
    }
    const done = [..._SplatRenderer.watched].filter((object) => !live.has(object));
    done.forEach((object) => _SplatRenderer.watched.delete(object));
    done.forEach((object) => object.release?.());
  }
  // The view a render from `camera` draws: `view`, else the one of its
  // view key (made in cpu mode, where each viewpoint needs its own order)
  viewOf(camera2) {
    if (this.view) {
      if (this.view.splats !== this) {
        throw new Error("SplatRenderer: its view belongs to another SplatRenderer");
      }
      return this.view;
    }
    const key = this.viewKey(camera2);
    const view = this._views.get(key);
    if (view || this._sortMode === "gpu") {
      return view;
    }
    if (this._views.size >= MANY_VIEWS && !this.warnedViews) {
      this.warnedViews = true;
      console.warn(`SplatRenderer: renders have made ${this._views.size} views, one per camera; for cameras made anew, set viewKey (or view)`);
    }
    return this.viewFor(key);
  }
  update(camera2) {
    const gpu = this._sortMode === "gpu";
    if (gpu && !isWebGPUBackend(this.renderer)) {
      throw new Error('SplatRenderer: sortMode "gpu" needs WebGPU (use "cpu")');
    }
    const view = this.viewOf(camera2);
    const settings = this.settingsOf(view);
    const drawn = gpu ? { collection: settings.collection } : view.drawn(camera2);
    SplatCamera.set(this.renderer, camera2);
    if (!drawn || drawn.collection.count === 0) {
      this.geometry.instanceCount = 0;
      return;
    }
    const phase = this.phase ?? ((_name, run) => run());
    if (this.projected.projection.method !== this.method || this.projected.eyes !== SplatCamera.eyes) {
      this.projected.arrays.dispose();
      this.projected = this.makeProjected(this.method, SplatCamera.eyes);
    }
    const arrays = this.projected.arrays;
    phase("project", () => projectCollection({ renderer: this.renderer, settings, collection: drawn.collection, arrays, pass: "full", cullKeys: gpu }));
    let sorter;
    let visible = arrays.count;
    if (gpu) {
      sorter = this.sorter ??= new WgpuSplatSorter(this.renderer);
      phase("sort", () => sorter.sort(arrays, arrays.count, settings.sortBits));
    } else {
      const order = drawn;
      this.orderReader.bind(order.arrays, "indices");
      this.orderCount.value = order.visible;
      visible = Math.min(order.visible, arrays.count);
    }
    if (this.drawState.for !== this.projected || this.drawState.sorter !== sorter) {
      this.buildMaterial(sorter);
    }
    this.drawState.projected.bind(arrays, "projected");
    this.encodeLinear.value = outputIsLinear(this.renderer) ? 1 : 0;
    this.geometry.setIndirect(sorter ? sorter.indirect.attribute : null);
    this.geometry.instanceCount = Math.ceil(visible / QUADS);
  }
  makeProjected(method, eyes) {
    const projection = SplatProjection.get(method);
    const arrays = new GpuArrays({ renderer: this.renderer, bundles: projection.outputs(eyes), capacity: 1, storage: isWebGPUBackend(this.renderer) });
    return { projection, eyes, arrays };
  }
  // The one material, built (or rebuilt in place) for the projected
  // arrays and the order source
  buildMaterial(sorter) {
    const { projection, eyes, arrays } = this.projected;
    const projected = projection.reader(eyes).bind(arrays, "projected");
    const order = sorter ? (i) => sorter.values.element(i) : (i) => this.orderReader.load("index", i);
    const count = sorter ? sorter.count : this.orderCount;
    const options = { projection, eyes, projected, order, count, quads: QUADS, encodeLinear: this.encodeLinear };
    if (this.drawState) {
      setDrawNodes(this.material, options);
    } else {
      this.material.dispose();
      this.material = makeDrawMaterial(options);
    }
    this.drawState = { for: this.projected, projected, sorter };
  }
};
function over(base, top) {
  const out = { ...base };
  for (const key of Object.keys(top)) {
    if (top[key] !== void 0) {
      out[key] = top[key];
    }
  }
  return out;
}
export {
  ArrayData,
  ArrayFormats,
  Axes,
  ByteReader,
  CameraControls,
  CompressedPlyFile,
  Compression,
  Encoding,
  GpuArrayReader,
  GpuArrayWriter,
  GpuArrays,
  GpuCovSplatReader,
  GpuEncoding,
  GpuExtSplatReader,
  GpuPackedSplatReader,
  GpuProfiler,
  GpuSh,
  GpuShPalette,
  GpuShReader,
  GpuSortKeys,
  GpuSplatMath,
  GpuSplatReader,
  GpuSplats,
  Hdr,
  PlyFile,
  RadFile,
  RdxFile,
  Sh,
  ShPalette,
  SortKeys,
  SplatCollection,
  SplatFiles,
  SplatGenerator,
  SplatMath,
  SplatProjector,
  SplatRenderer,
  SplatView,
  Splats,
  SpzFile,
  TSL,
  TextureLayout,
  WgpuArrayStore,
  WgpuArrayWriter,
  WgpuBuffer,
  WgpuCompact,
  WgpuCompute,
  WgpuComputeBatch,
  WgpuRadixSort,
  WgpuSplatSorter,
  WorkerLease,
  WorkerPool,
  Zstd,
  createRenderer,
  decodeShScale,
  defineBundle,
  encodeShScale,
  getGpuCaps,
  loadSplatFile,
  loadSplats,
  sortSplatKeys,
  writeSplats
};
//# sourceMappingURL=radix.module.js.map
