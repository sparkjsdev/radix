// Spark's mobile-joystick: the valley with CameraControls (pointer, touch,
// keys), plus an on-screen joystick on touch devices that moves the camera
// along the view
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const MOVE_SPEED = 2;
const SIZE = 140;
const KNOB = 60;
const DEAD_ZONE = 0.15;

const page = examplePage("mobile-joystick");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 1.6, 0);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { antialias: true, pixelRatio: Math.min(devicePixelRatio, 2) });
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-mobile-joystick" });

const valley = new THREE.Object3D();
valley.quaternion.set(1, 0, 0, 0);
valley.position.set(0, 0, -3);
scene.add(valley);

const file = await loadSplatFile(renderer, asset("valley.spz"), { onProgress: page.progress("valley") });
const splats = new SplatRenderer({ renderer });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: valley.matrixWorld })]);
scene.add(splats);

// Touch devices (not headsets): the stick's offset from its center, each axis
// in -1..1 (y positive backward)
const touch = navigator.maxTouchPoints > 0 && !/OculusBrowser|Quest/i.test(navigator.userAgent);
const stick = new THREE.Vector2();
if (touch) {
  const base = document.createElement("div");
  base.style.cssText = `position:fixed;left:40px;bottom:40px;width:${SIZE}px;height:${SIZE}px;box-sizing:border-box;border-radius:50%;background:rgba(255,255,255,0.2);border:2px solid rgba(255,255,255,0.4);touch-action:none;z-index:1000`;
  const knob = document.createElement("div");
  knob.style.cssText = `position:absolute;left:50%;top:50%;width:${KNOB}px;height:${KNOB}px;margin:${-KNOB / 2}px;border-radius:50%;background:rgba(255,255,255,0.5)`;
  base.append(knob);
  document.body.append(base);

  const radius = (SIZE - KNOB) / 2;
  let active                    ;
  const move = (event              ) => {
    const rect = base.getBoundingClientRect();
    const offset = new THREE.Vector2(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2).clampLength(0, radius);
    knob.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
    stick.copy(offset).divideScalar(radius);
    stick.set(Math.abs(stick.x) < DEAD_ZONE ? 0 : stick.x, Math.abs(stick.y) < DEAD_ZONE ? 0 : stick.y);
  };
  const release = (event              ) => {
    if (event.pointerId === active) {
      active = undefined;
      stick.set(0, 0);
      knob.style.transform = "";
      knob.style.background = "rgba(255,255,255,0.5)";
    }
  };

  base.addEventListener("pointerdown", (event) => {
    if (active === undefined) {
      active = event.pointerId;
      base.setPointerCapture(active);
      knob.style.background = "rgba(100,150,255,0.7)";
      move(event);
    }
  });
  base.addEventListener("pointermove", (event) => event.pointerId === active && move(event));
  base.addEventListener("pointerup", release);
  base.addEventListener("pointercancel", release);
}

page.legend(touch ? "Use the joystick to move, drag to look around" : "WASD to move, drag to look around");
page.ready(renderer);

let lastTime                    ;
renderer.setAnimationLoop((time) => {
  const delta = lastTime === undefined ? 0 : Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;
  controls.update();

  // The stick moves what the controls move, along its view
  const moved = controls.object;
  moved.position.add(new THREE.Vector3(stick.x, 0, stick.y).multiplyScalar(MOVE_SPEED * delta).applyQuaternion(moved.quaternion));
  renderer.render(scene, camera);
});


//# sourceURL=examples/spark/mobile-joystick/main.ts