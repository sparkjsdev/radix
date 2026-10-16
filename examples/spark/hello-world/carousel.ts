// Spark's hello-world/carousel.html: three scans fading into one another
// every 5 seconds, orbited by the camera controls. The fades set each
// model's opacity (js/objects.js); only the shown scan is visible.
import * as THREE from "three";
import { CameraControls } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";

const page = examplePage("hello-world");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({
  canvas: renderer.domElement, object: camera, storageKey: "spark-hello-world", settings: { mode: "orbit", minDistance: 2, maxDistance: 3 },
});
controls.lookAt(new THREE.Vector3(0, 0, -3));

// One renderer drawing the visible models; their SH seen from the camera
const splats = new SplatSet({ renderer, scene });

const SCANS = [
  { file: "butterfly.spz", scale: 1.2 },
  { file: "furry-logo-pedestal.spz", scale: 0.45 },
  { file: "forge.spz", scale: 1 },
];
const models = await Promise.all(SCANS.map(async ({ file, scale }) => {
  const model = await splats.load(asset(file), { onProgress: page.progress(file) });
  model.rotation.x = Math.PI;
  model.position.set(0, 0, -3);
  model.scale.setScalar(scale);
  return model;
}));

let current = 0;
models.forEach((model, i) => (model.visible = i === current));
page.ready(renderer);

// Every 5 s the shown scan fades out over FADE ms, then the next fades in
const FADE = 1000;
const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
let fade: number | undefined;
setInterval(() => (fade = 0), 5000);

function step(delta: number) {
  if (fade === undefined) {
    return;
  }

  const before = fade;
  fade += delta * 1000;
  if (fade < FADE) {
    models[current].opacity = 1 - easeInOutSine(fade / FADE);
    return;
  }
  if (before < FADE) {
    models[current].visible = false;
    current = (current + 1) % models.length;
    models[current].visible = true;
  }
  models[current].opacity = easeInOutSine(Math.min((fade - FADE) / FADE, 1));
  if (fade >= 2 * FADE) {
    fade = undefined;
  }
}

let last = 0;
renderer.setAnimationLoop((time) => {
  const delta = Math.min((time - last) / 1000, 0.1);
  last = time;
  controls.update();
  models[current].rotation.y = time / 1500;
  step(delta);
  renderer.render(scene, camera);
});
