// Walk mode: a capsule that walks on the scene's collision mesh
// (collision.ts, loaded around it by CollisionStream.ts), driven by
// CameraControls in fly mode, which keeps looking and pointer lock. Each
// frame the page takes the camera position before controls.update() and
// calls step(): the move the controls made is turned into a walk along the
// camera's heading (its sideways and forward parts, at full speed whatever
// the pitch; up and down, Q / E, dropped), then the capsule moves in
// sub-steps of at most 1/120 s:
//   1. gravity, or a jump (Space) while on the ground;
//   2. the feet move by the walk and the vertical speed;
//   3. push-out: spheres at the knee (above the step height, so steps don't
//      stop it) and the chest gather the triangles they touch and move out
//      sideways from their closest points, three times; a ceiling stops a
//      jump;
//   4. the ground: a ray down from the knee finds the floor; the feet snap
//      onto it up a step or down a slope while on the ground, or land on it
//      when falling;
// then the camera goes to the eye, above the feet. While the chunks under
// the feet are still loading, the capsule does not fall. Lengths are in the
// scene's units (meters for XGRIDS scenes); physics runs in the file's frame
// (the model's inverse), with up the world's up turned into it.
import * as THREE from "three";
import type { CameraControls } from "@sparkjsdev/radix";
import type { Vec3 } from "./collision.js";
import type { CollisionStream } from "./CollisionStream.js";

export interface WalkSettings {
  eyeHeight: number;
  radius: number;
  stepHeight: number;
  // Walk speed multiplier over the controls' move speed
  speed: number;
  gravity: number;
  jumpSpeed: number;
}

export const DEFAULT_WALK: WalkSettings = { eyeHeight: 1.6, radius: 0.25, stepHeight: 0.35, speed: 1.4, gravity: 9.8, jumpSpeed: 4 };

const SUBSTEP = 1 / 120;
const MAX_SUBSTEPS = 8;
const PUSH_ITERATIONS = 3;
const SKIN = 1e-3;
// How far down (scene units) a floor counts as there to fall onto
const FAR = 200;
// Where to look for ground around the camera when walking starts: rings of
// these radii (scene units), eight rays each
const SEARCH = [0, 0.3, 0.6, 1, 1.5, 2.5, 4];

export type WalkState = "off" | "waiting" | "grounded" | "falling";

export class Walker {
  readonly settings: WalkSettings;
  active = false;
  state: WalkState = "off";
  // In the file's frame
  readonly feet = new THREE.Vector3();
  readonly up = new THREE.Vector3(0, 0, 1);
  hit?: THREE.Vector3;
  // m/s in the file's units along `up`
  private vertical = 0;
  private jump = false;
  private readonly lastGround = new THREE.Vector3();
  // A scripted walk (checks): a world-space horizontal velocity until `until`
  private drive?: { velocity: THREE.Vector3; until: number };
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: CameraControls;
  private readonly model: THREE.Object3D;
  private collision?: CollisionStream;
  private readonly inverse = new THREE.Matrix4();
  private readonly abort = new AbortController();

  constructor({ camera, controls, model, settings }: { camera: THREE.PerspectiveCamera; controls: CameraControls; model: THREE.Object3D; settings: WalkSettings }) {
    this.camera = camera;
    this.controls = controls;
    this.model = model;
    this.settings = settings;
    addEventListener("keydown", (event) => {
      if (this.active && event.code === "Space" && !(event.target instanceof HTMLInputElement)) {
        this.jump = true;
        event.preventDefault();
      }
    }, { signal: this.abort.signal });
  }

  setCollision(collision: CollisionStream | undefined) {
    this.collision = collision;
    if (!collision) {
      this.stop();
    }
  }

  // World lengths per file unit (the model's uniform scale)
  private get scale() {
    return Math.max(1e-9, this.model.scale.x);
  }

  private frame() {
    this.model.updateMatrixWorld();
    this.inverse.copy(this.model.matrixWorld).invert();
    this.up.set(0, 1, 0).transformDirection(this.inverse);
  }

  private toFile(world: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(world).applyMatrix4(this.inverse);
  }

  // Drops onto the ground below the camera; false (and a reason) when there is none
  async start(): Promise<{ ok: boolean; message?: string }> {
    const collision = this.collision;
    if (!collision) {
      return { ok: false, message: "This scene has no collision mesh" };
    }
    this.frame();
    const eye = this.toFile(this.camera.position);
    this.state = "waiting";
    await collision.ready(eye, (this.settings.eyeHeight * 4) / this.scale);
    this.frame();
    this.toFile(this.camera.position, eye);
    const down = this.up.clone().negate();
    // The nearest ground below the camera, or around it (meshes have holes)
    const side = new THREE.Vector3(1, 0, 0);
    if (Math.abs(side.dot(this.up)) > 0.9) {
      side.set(0, 1, 0);
    }
    const s = side.cross(this.up).normalize();
    const t = this.up.clone().cross(s).normalize();
    const origin = new THREE.Vector3();
    let found: THREE.Vector3 | undefined;
    for (const ring of SEARCH) {
      for (let k = 0; k < (ring === 0 ? 1 : 8) && !found; k += 1) {
        const angle = (k / 8) * Math.PI * 2;
        origin.copy(eye).addScaledVector(s, (Math.cos(angle) * ring) / this.scale).addScaledVector(t, (Math.sin(angle) * ring) / this.scale);
        const hit = collision.set.raycast(origin, down, 1e4 / this.scale);
        found = hit && origin.clone().addScaledVector(down, hit.t);
      }
      if (found) {
        break;
      }
    }
    if (!found) {
      this.state = "off";
      return { ok: false, message: "No ground below the camera: fly over the floor, then walk" };
    }
    this.feet.copy(found);
    this.lastGround.copy(this.feet);
    this.vertical = 0;
    this.active = true;
    this.state = "grounded";
    this.controls.mode = "fly";
    this.place();
    return { ok: true };
  }

  stop() {
    this.active = false;
    this.state = "off";
    this.hit = undefined;
    this.drive = undefined;
  }

  // Walk at `velocity` (world, horizontal, scene units per second) for `seconds` (checks)
  driveFor(velocity: THREE.Vector3, seconds: number) {
    this.drive = { velocity: velocity.clone(), until: performance.now() + seconds * 1000 };
  }

  // After controls.update(): `before` is the camera's position before it
  step(dt: number, before: THREE.Vector3) {
    const collision = this.collision;
    if (!this.active || !collision) {
      return;
    }
    if (this.controls.mode !== "fly") {
      this.stop();
      return;
    }
    this.frame();
    const s = this.settings;
    const scale = this.scale;

    // The controls' move in the camera's own axes, walked along its heading
    const moved = this.camera.position.clone().sub(before);
    const local = moved.clone().applyQuaternion(this.camera.quaternion.clone().invert());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).setY(0);
    if (forward.lengthSq() < 1e-8) {
      forward.set(0, 1, 0).applyQuaternion(this.camera.quaternion).setY(0).negate();
    }
    forward.normalize();
    right.normalize();
    const wish = right.multiplyScalar(local.x).addScaledVector(forward, -local.z).multiplyScalar(s.speed);
    if (this.drive) {
      if (performance.now() < this.drive.until) {
        wish.addScaledVector(this.drive.velocity, dt);
      } else {
        this.drive = undefined;
      }
    }
    // In the file's frame, per second
    const distance = wish.length();
    const wishFile = distance > 0 ? wish.transformDirection(this.inverse).multiplyScalar(distance / scale / Math.max(dt, 1e-6)) : wish;

    const eye = s.eyeHeight / scale;
    const radius = s.radius / scale;
    const stepHeight = s.stepHeight / scale;
    const gravity = s.gravity / scale;
    const loaded = collision.loadedAt(this.feet, eye * 2);
    this.state = loaded ? this.state === "waiting" ? "grounded" : this.state : "waiting";

    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / SUBSTEP)));
    const h = Math.min(dt, MAX_SUBSTEPS * SUBSTEP) / steps;
    const up = this.up;
    for (let i = 0; i < steps; i += 1) {
      const grounded = this.state === "grounded";
      if (loaded) {
        if (grounded && this.jump) {
          this.vertical = s.jumpSpeed / scale;
          this.state = "falling";
        } else if (!grounded) {
          this.vertical -= gravity * h;
        }
      } else {
        this.vertical = 0;
      }
      this.feet.addScaledVector(wishFile, h).addScaledVector(up, this.vertical * h);
      this.pushOut(radius, stepHeight, eye);
      if (loaded) {
        this.ground(radius, stepHeight, h);
      }
    }
    this.jump = false;

    // Fell out of the scene: back to the last ground
    if (this.state === "falling" && this.feet.clone().sub(this.lastGround).dot(up) < -1000 / scale) {
      this.feet.copy(this.lastGround);
      this.vertical = 0;
      this.state = "grounded";
    }
    this.place();
  }

  // Sideways out of the triangles the knee and chest spheres touch
  private pushOut(radius: number, stepHeight: number, eye: number) {
    const collision = this.collision!;
    const up = this.up;
    const knee = stepHeight + radius;
    const chest = Math.max(knee, eye - radius);
    const center = new THREE.Vector3();
    const push = new THREE.Vector3();
    const away = new THREE.Vector3();
    for (let iteration = 0; iteration < PUSH_ITERATIONS; iteration += 1) {
      let any = false;
      for (const height of chest > knee ? [knee, chest] : [knee]) {
        center.copy(this.feet).addScaledVector(up, height);
        push.set(0, 0, 0);
        collision.set.sphere(center, radius, (point: Vec3) => {
          away.set(center.x - point.x, center.y - point.y, center.z - point.z);
          const length = away.length();
          if (length >= radius || length < 1e-9) {
            return;
          }
          const depth = radius - length + SKIN;
          away.multiplyScalar(depth / length);
          // A ceiling over the chest stops a jump
          if (height === chest && away.dot(up) < 0 && this.vertical > 0) {
            this.vertical = 0;
          }
          away.addScaledVector(up, -away.dot(up));
          // The deepest push along each direction, not their sum
          for (const axis of ["x", "y", "z"] as const) {
            if (Math.abs(away[axis]) > Math.abs(push[axis])) {
              push[axis] = away[axis];
            }
          }
        });
        if (push.lengthSq() > 0) {
          this.feet.add(push);
          any = true;
        }
      }
      if (!any) {
        break;
      }
    }
  }

  // Snap onto the floor below the knee
  private ground(radius: number, stepHeight: number, h: number) {
    const collision = this.collision!;
    const up = this.up;
    const knee = stepHeight + radius;
    const origin = this.feet.clone().addScaledVector(up, knee);
    const down = up.clone().negate();
    const grounded = this.state === "grounded";
    const fall = Math.max(0, -this.vertical * h);
    const reach = knee + (grounded ? stepHeight : 0) + fall + SKIN;
    const hit = collision.set.raycast(origin, down, reach);
    // Floors only: slopes up to 60 degrees
    if (hit && this.vertical <= 0 && hit.normal.x * up.x + hit.normal.y * up.y + hit.normal.z * up.z > 0.5) {
      this.feet.copy(origin).addScaledVector(down, hit.t);
      this.vertical = 0;
      this.state = "grounded";
      this.lastGround.copy(this.feet);
      this.hit = this.feet.clone();
    } else if (this.vertical <= 0 && !collision.set.raycast(origin, down, FAR / this.scale)) {
      // A hole in the mesh (scanned meshes have them): hold the height
      this.vertical = 0;
      this.state = "grounded";
    } else {
      this.state = "falling";
    }
  }

  private place() {
    const eye = this.feet.clone().addScaledVector(this.up, this.settings.eyeHeight / this.scale);
    this.camera.position.copy(eye.applyMatrix4(this.model.matrixWorld));
  }

  // For the overlay: feet, up, radius and height in the file's frame
  get capsule() {
    const scale = this.scale;
    return { feet: this.feet, up: this.up, radius: this.settings.radius / scale, height: this.settings.eyeHeight / scale, hit: this.hit };
  }

  dispose() {
    this.abort.abort();
  }
}
