// Camera shots: what the view does on its own after a transition lands,
// until the next one starts or the user takes over.
//   hold    nothing more than the idle motion
//   spin    the fractal turns once around, quickly, and settles
//   zoom    the camera closes in for a few seconds, then backs out
//   orbit   the camera circles the whole shot long
//   truck   the camera slides sideways and back, the target with it
//   crane   the camera rises over the fractal
//   push    the camera slowly closes in and stays
// Shots move the camera by increments (each frame, the change of a smooth
// curve since the last), so they never undo the user's own moves.
import * as THREE from "three";
import type { CameraControls } from "@sparkjsdev/radix";
import type { Motion } from "./motion.js";

export const SHOTS = ["hold", "spin", "zoom", "orbit", "truck", "crane", "push"] as const;
export type ShotName = (typeof SHOTS)[number];

const smoother = (x: number) => THREE.MathUtils.smootherstep(x, 0, 1);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

export class Director {
  name: ShotName = "hold";
  private time = 0;
  private running = false;
  private direction = 1;
  // The curve's value at the last frame (scale, angle or offset)
  private last = 0;
  private readonly target = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  start(name: ShotName) {
    this.name = name;
    this.time = 0;
    this.last = 0;
    this.direction = Math.random() < 0.5 ? -1 : 1;
    this.running = name !== "hold";
  }

  stop(motion?: Motion) {
    if (motion && this.running && this.name === "spin") {
      motion.spinReleased = true;
    }
    this.running = false;
  }

  // Whether the camera is the shot's (camera motions ease out)
  get holds() {
    return this.running && this.name !== "spin";
  }

  update(seconds: number, camera: THREE.PerspectiveCamera, controls: CameraControls, motion: Motion) {
    if (!this.running) {
      return;
    }
    this.time += seconds;
    const t = this.time;
    controls.getTarget(this.target);
    this.offset.copy(camera.position).sub(this.target);
    // Each shot: its curve now, applied as the change since the last frame
    const advance = (value: number) => {
      const delta = value - this.last;
      this.last = value;
      return delta;
    };

    if (this.name === "spin") {
      motion.spinReleased = false;
      const x = Math.min(t / 3.2, 1);
      motion.spin = this.direction * Math.PI * 2 * easeInOut(x);
      if (x >= 1) {
        motion.spin = 0;
        this.running = false;
      }
      return;
    }
    if (this.name === "zoom" || this.name === "push") {
      // Log of the distance scale: in, hold, out (zoom) or in to stay (push)
      const depth = this.name === "zoom" ? Math.log(0.5) : Math.log(0.72);
      const curve = this.name === "zoom" ? smoother(Math.min(t / 3, 1)) - smoother(THREE.MathUtils.clamp((t - 6.5) / 3, 0, 1)) : smoother(Math.min(t / 12, 1));
      this.offset.multiplyScalar(Math.exp(advance(depth * curve)));
      this.running = this.name === "zoom" ? t < 9.5 : t < 12;
    } else if (this.name === "orbit") {
      // Eases up to a slow circle and keeps going; a gentle rise and fall
      const angle = this.direction * 0.11 * (t - 2 + 2 * Math.exp(-t / 2));
      this.offset.applyAxisAngle(this.up, advance(angle));
      this.axis.crossVectors(this.up, this.offset).normalize();
      this.offset.applyAxisAngle(this.axis, -0.04 * 0.2 * Math.cos(t * 0.2) * seconds * Math.min(t / 2, 1));
    } else if (this.name === "truck") {
      // Out to one side and back over 16 s, turning a little toward it
      const side = this.direction * 0.22 * Math.min(this.offset.length() / 3.4, 1.4) * (1 - Math.cos((Math.PI * 2 * Math.min(t, 16)) / 16)) / 2;
      this.target.add(this.axis.crossVectors(this.offset, this.up).normalize().multiplyScalar(advance(side)));
      this.running = t < 16;
    } else if (this.name === "crane") {
      const angle = THREE.MathUtils.degToRad(28) * smoother(Math.min(t / 12, 1));
      const elevation = Math.asin(THREE.MathUtils.clamp(this.offset.y / this.offset.length(), -1, 1));
      const delta = advance(angle);
      if (elevation + delta < 1.25) {
        this.axis.crossVectors(this.up, this.offset).normalize();
        this.offset.applyAxisAngle(this.axis, -delta);
      }
      this.running = t < 12;
    }
    camera.position.copy(this.target).add(this.offset);
    controls.lookAt(this.target);
  }
}
