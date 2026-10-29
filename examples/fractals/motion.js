// How the scene moves on its own, once nobody has touched it for a while
// (it eases in over 2 s and out within half a second of any input), after
// the Spark lofi example's idle drift:
//   idle sway  the fractal drifts on three slow sines and yaws a little
//              (lofi's idle bee, scaled to the viewing distance)
//   float      the fractal turns slowly about its axis and bobs
//   turntable  the camera circles the target
//   drift      the camera circles, rises and sinks, nears and backs off
//   still      nothing moves
// The fractal's frame is `holder` (its objects' matrixWorld), eased toward
// where the motion wants it, so switching motions never snaps; `spin` (a
// yaw the page's shots drive) is applied on top, unsmoothed. Camera
// motions ease out while the camera is held (a tween or a shot moves it).
// In a view baked from the camera every motion but still becomes a slow
// look around from where the camera stands (moving the eye would show
// surfaces the bake never saw).
import * as THREE from "three";
                                                        

export const MOTIONS = ["idle sway", "float", "turntable", "drift", "still"]         ;
                                                  

const IDLE_AFTER = 4;

export class Motion {
           holder = new THREE.Object3D();
  mode             = "idle sway";
  speed = 1;
  // Extra yaw of the fractal, radians; once released, it eases to the
  // nearest whole turn
  spin = 0;
  spinReleased = false;
  // Called on any input (the page cancels camera moves of its own)
  onInput             ;
          countdown = 0.5;
          blend = 0;
          cameraBlend = 1;
          time = 0;
          turn = 0;
                   position = new THREE.Vector3();
                   rotation = new THREE.Quaternion();
                   wanted = new THREE.Quaternion();
                   euler = new THREE.Euler();
                   spun = new THREE.Quaternion();
                   target = new THREE.Vector3();
                   offset = new THREE.Vector3();
                   axis = new THREE.Vector3();
                   up = new THREE.Vector3(0, 1, 0);

  constructor(canvas             ) {
    const touch = () => {
      this.countdown = IDLE_AFTER;
      this.onInput?.();
    };
    for (const type of ["pointerdown", "wheel"]         ) {
      canvas.addEventListener(type, touch, { passive: true });
    }
    addEventListener("keydown", (event) => {
      if (!(event.target               ).closest("input, select, textarea") && ["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(event.key.toLowerCase())) {
        touch();
      }
    });
  }

  setMode(mode            ) {
    this.mode = mode;
  }

  // Whether nobody has touched the controls for a while
  get idle() {
    return this.countdown < 0;
  }

  update(seconds        , camera                         , controls                , { held = false, baked = false } = {}) {
    this.countdown -= seconds;
    this.blend = this.countdown < 0 ? Math.min(1, this.blend + seconds / 2) : Math.max(0, this.blend - seconds * 2);
    this.cameraBlend = held ? Math.max(0, this.cameraBlend - seconds * 1.5) : Math.min(1, this.cameraBlend + seconds / 2);
    const b = THREE.MathUtils.smoothstep(this.blend, 0, 1);
    const dt = seconds * this.speed * b;
    this.time += seconds * this.speed;
    const t = this.time;
    const mode = baked && this.mode !== "still" ? "look around" : this.mode;
    const reach = 0.2 * Math.min(controls.distance / 3.4, 1.5);

    this.position.set(0, 0, 0);
    this.euler.set(0, 0, 0);
    if (mode === "idle sway") {
      this.position.set(Math.sin(t * 0.3), Math.sin(t * 0.2), Math.sin(t * 0.5)).multiplyScalar(reach * b);
      this.euler.set(0, 0.1 * Math.sin(t * 0.37) * b, 0);
    } else if (mode === "float") {
      this.turn += dt * 0.18;
      this.position.set(0, Math.sin(t * 0.6) * reach * 0.35 * b, 0);
      this.euler.set(0.06 * Math.sin(t * 0.23) * b, this.turn, 0.04 * Math.sin(t * 0.31) * b);
    } else if (mode === "look around" && !held) {
      // Turns of the camera in place, on the derivatives of slow sines
      camera.rotateOnWorldAxis(this.up, 0.035 * 0.37 * Math.cos(t * 0.37) * dt);
      camera.rotateX(0.02 * 0.29 * Math.cos(t * 0.29) * dt);
    } else if ((mode === "turntable" || mode === "drift") && this.cameraBlend > 0) {
      const step = dt * this.cameraBlend;
      controls.getTarget(this.target);
      this.offset.copy(camera.position).sub(this.target).applyAxisAngle(this.up, step * (mode === "drift" ? 0.06 : 0.09));
      if (mode === "drift") {
        // Elevation and distance on slow sines (their derivatives, so the
        // user's pose stays the center)
        const elevation = Math.asin(THREE.MathUtils.clamp(this.offset.y / this.offset.length(), -1, 1));
        const rise = 0.3 * 0.11 * Math.cos(t * 0.11) * step;
        if (Math.abs(elevation + rise) < 1.2) {
          this.axis.crossVectors(this.up, this.offset).normalize();
          this.offset.applyAxisAngle(this.axis, -rise);
        }
        this.offset.multiplyScalar(Math.exp(0.12 * 0.17 * Math.cos(t * 0.17) * step));
      }
      camera.position.copy(this.target).add(this.offset);
      camera.lookAt(this.target);
    }

    // Ease toward the wanted pose, then the spin on top
    const ease = 1 - Math.exp(-seconds * 4);
    if (this.spinReleased) {
      const whole = Math.round(this.spin / (Math.PI * 2)) * Math.PI * 2;
      this.spin += (whole - this.spin) * (1 - Math.exp(-seconds * 2.5));
      if (Math.abs(whole - this.spin) < 1e-3) {
        this.spin = 0;
        this.spinReleased = false;
      }
    }
    this.holder.position.lerp(this.position, ease);
    this.rotation.slerp(this.wanted.setFromEuler(this.euler), ease);
    this.holder.quaternion.copy(this.rotation).premultiply(this.spun.setFromAxisAngle(this.up, this.spin));
    this.holder.updateMatrixWorld(true);
  }
}


//# sourceURL=examples/fractals/motion.ts