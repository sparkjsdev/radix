// CameraControls driven by synthetic events: targets, mode switches, keys,
// drags, the double-press slide, zoom limits and saved settings
import * as THREE from "three";
import { CameraControls } from "@sparkjsdev/radix";

type Check = (name: string, fn: () => Promise<string | undefined | "skip">) => Promise<void>;

const STORAGE_KEY = "radix-gpu-tests";
const frame = () => new Promise((resolve) => setTimeout(resolve, 16));
const near = (a: THREE.Vector3, b: THREE.Vector3, tolerance = 1e-4) => a.distanceTo(b) < tolerance;

// Controls of a fresh camera at (0, 0, 5) facing the origin: the defaults
// without inertia or inversions, whatever this browser saved (set on the
// settings directly, so nothing is saved)
function make() {
  const canvas = document.createElement("canvas");
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 5);
  const controls = new CameraControls({ canvas, object: camera });
  controls.settings = {
    ...CameraControls.DEFAULTS, invertLookX: false, invertLookY: false, inertia: { look: 0, move: 0, pointerLook: 0, pointerMove: 0 },
  };
  controls.lookAt(new THREE.Vector3());
  return { canvas, camera, controls };
}

function saved(storageKey: string) {
  return new CameraControls({ canvas: document.createElement("canvas"), object: new THREE.Object3D(), storageKey });
}

function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number, button = 0) {
  canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button, clientX: x, clientY: y, bubbles: true }));
}

export async function runControlsTests(check: Check) {
  await check("CameraControls lookAt and getTarget agree", async () => {
    const { camera, controls } = make();
    try {
      const target = new THREE.Vector3(1, 2, -3);
      controls.lookAt(target);
      const forward = camera.getWorldDirection(new THREE.Vector3());
      const expected = target.clone().sub(camera.position).normalize();
      return near(controls.getTarget(), target) && near(forward, expected) ? undefined : `target ${controls.getTarget().toArray()}`;
    } finally {
      controls.dispose();
    }
  });

  await check("CameraControls switching fly / orbit keeps the pose", async () => {
    const { camera, controls } = make();
    try {
      controls.update();
      const position = camera.position.clone();
      const quaternion = camera.quaternion.clone();
      controls.settings.mode = "orbit";
      await frame();
      controls.update();
      controls.settings.mode = "fly";
      await frame();
      controls.update();
      return near(camera.position, position) && camera.quaternion.angleTo(quaternion) < 1e-5 ? undefined : `moved to ${camera.position.toArray()}`;
    } finally {
      controls.dispose();
    }
  });

  await check("CameraControls keys move, drags turn and orbit, a double press slides", async () => {
    const { canvas, camera, controls } = make();
    try {
      controls.update();
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
      for (let i = 0; i < 5; i += 1) {
        await frame();
        controls.update();
      }
      document.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
      if (!(camera.position.z < 4.99) || Math.abs(camera.position.x) > 1e-6) {
        return `W moved to ${camera.position.toArray()}`;
      }

      const position = camera.position.clone();
      const quaternion = camera.quaternion.clone();
      pointer(canvas, "pointerdown", 100, 100);
      pointer(canvas, "pointermove", 200, 100);
      await frame();
      controls.update();
      pointer(canvas, "pointerup", 200, 100);
      const yaw = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ").y;
      if (!near(camera.position, position) || !(yaw < -0.2)) {
        return `fly drag: yaw ${yaw}, position ${camera.position.toArray()}`;
      }

      // A second press soon after the first slides forward on an upward drag
      const turned = camera.quaternion.clone();
      const before = camera.position.clone();
      pointer(canvas, "pointerdown", 100, 200);
      pointer(canvas, "pointermove", 100, 100);
      await frame();
      controls.update();
      pointer(canvas, "pointerup", 100, 100);
      const forward = camera.getWorldDirection(new THREE.Vector3());
      const step = camera.position.clone().sub(before);
      if (camera.quaternion.angleTo(turned) > 1e-6 || !(step.dot(forward) > 0.1)) {
        return `slide: step ${step.toArray()}`;
      }

      // Orbit: a drag keeps the distance to the target (after the slide's double press expires)
      await new Promise((resolve) => setTimeout(resolve, controls.settings.doublePress + 50));
      camera.quaternion.copy(quaternion);
      controls.settings.mode = "orbit";
      const target = controls.getTarget();
      const distance = controls.distance;
      pointer(canvas, "pointerdown", 100, 100);
      pointer(canvas, "pointermove", 180, 140);
      await frame();
      controls.update();
      pointer(canvas, "pointerup", 180, 140);
      const radius = camera.position.distanceTo(target);
      return near(controls.getTarget(), target) && Math.abs(radius - distance) < 1e-4 && camera.quaternion.angleTo(quaternion) > 0.1
        ? undefined : `orbit: radius ${radius} of ${distance}, target ${controls.getTarget().toArray()}`;
    } finally {
      controls.dispose();
    }
  });

  await check("CameraControls a released orbit drag glides, also after a short pause, not after a long one", async () => {
    const { canvas, camera, controls } = make();
    try {
      controls.settings = { ...controls.settings, mode: "orbit", inertia: { ...controls.settings.inertia, pointerLook: 0.15 } };
      controls.update();
      // A drag of 5 moves a frame apart, held `pause` ms, released; the
      // turn in the 150 ms after the release
      const glide = async (pause: number) => {
        pointer(canvas, "pointerdown", 100, 100);
        for (let i = 1; i <= 5; i += 1) {
          await frame();
          pointer(canvas, "pointermove", 100 + i * 20, 100);
          controls.update();
        }
        const held = performance.now();
        while (performance.now() - held < pause) {
          await frame();
          controls.update();
        }
        pointer(canvas, "pointerup", 200, 100);
        const released = camera.quaternion.clone();
        const start = performance.now();
        while (performance.now() - start < 150) {
          await frame();
          controls.update();
        }
        await new Promise((resolve) => setTimeout(resolve, controls.settings.doublePress));
        return camera.quaternion.angleTo(released);
      };
      const [quick, short, long] = [await glide(0), await glide(40), await glide(250)];
      return quick > 0.05 && short > 0.02 && long < 1e-6 ? undefined : `turned after release: ${quick.toFixed(3)} (no pause), ${short.toFixed(3)} (40 ms), ${long.toFixed(4)} (250 ms)`;
    } finally {
      controls.dispose();
    }
  });

  await check("CameraControls orbit zoom stays within the distance limits", async () => {
    const { canvas, camera, controls } = make();
    try {
      controls.settings = { ...controls.settings, mode: "orbit", minDistance: 1, maxDistance: 10 };
      const target = controls.getTarget();
      controls.update();
      const zoom = async (deltaY: number) => {
        canvas.dispatchEvent(new WheelEvent("wheel", { deltaY, cancelable: true }));
        await frame();
        controls.update();
        return camera.position.distanceTo(target);
      };
      const nearest = await zoom(-100000);
      const farthest = await zoom(100000);
      return Math.abs(nearest - 1) < 1e-4 && Math.abs(farthest - 10) < 1e-4 && near(controls.getTarget(), target) ? undefined : `distances ${nearest}, ${farthest}`;
    } finally {
      controls.dispose();
    }
  });

  await check("CameraControls saves page settings per storageKey and resets them", async () => {
    const key = `radix-controls:${STORAGE_KEY}`;
    const first = saved(STORAGE_KEY);
    try {
      first.set({ moveSpeed: 7, mode: "orbit" });
      const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      const second = saved(STORAGE_KEY);
      const loaded = second.settings.moveSpeed;
      second.dispose();
      first.reset();
      const third = saved(STORAGE_KEY);
      const reset = third.settings.moveSpeed;
      third.dispose();
      return stored.moveSpeed === 7 && stored.mode === "orbit" && loaded === 7 && reset === CameraControls.DEFAULTS.moveSpeed && localStorage.getItem(key) === null
        ? undefined : `saved ${JSON.stringify(stored)}, loaded ${loaded}, after reset ${reset}`;
    } finally {
      first.dispose();
      localStorage.removeItem(key);
    }
  });
}
