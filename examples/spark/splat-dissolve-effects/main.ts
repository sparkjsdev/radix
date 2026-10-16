// Spark's splat-dissolve-effects: a fly scan whose splats, one by one after
// a random start time, drift off, flash white and fade (an object-space
// modifier driven by time, Spark's GLSL rewritten in TSL)
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer, TSL, type SplatNode, type TslNode } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const { clamp, dot, float, fract, mix, normalize, sin, step, uniform, vec3, vec4 } = TSL;

const page = examplePage("splat-dissolve-effects");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-splat-dissolve-effects", settings: { mode: "orbit" } });
controls.lookAt(new THREE.Vector3(0, 0, -0.5));

// Seconds since the scan loaded
const animateT = uniform(0);
const hash = (p: TslNode) => fract(sin(p.mul(123.456)).mul(123.456));

const dissolve = (s: SplatNode) => {
  const out = s.toVar();
  const t = animateT;
  const center = s.get("center");
  const h = hash(center).toVar();
  const startTime = h.x.mul(100);
  const shouldOscillate = step(startTime, t).toVar();
  const oscillation = sin(t.mul(2).add(h.y.mul(6.28))).mul(0.5).add(0.5);
  const moveDirection = normalize(vec3(1, h.y.sub(0.5).mul(0.9), h.z.sub(0.5).mul(0.9)));
  const randomSpeed = fract(sin(dot(center, vec3(12, 78, 45))).mul(43758));
  const moveAmount = t.mul(0.1).mul(randomSpeed).mul(shouldOscillate).toVar();
  out.get("center").assign(center.add(moveDirection.mul(moveAmount)));

  const rgba = vec4(s.get("rgb"), s.get("opacity"));
  const flashed = mix(rgba, mix(rgba, vec4(1), oscillation), shouldOscillate).toVar();
  out.get("rgb").assign(flashed.xyz);
  out.get("opacity").assign(flashed.w.mul(mix(float(1), float(1).sub(clamp(moveAmount.div(2), 0, 1)), shouldOscillate)));
  return out;
};

const fly = new THREE.Object3D();
fly.rotation.x = Math.PI;
fly.position.set(0, 0, -0.5);
scene.add(fly);

const file = await loadSplatFile(renderer, asset("fly.spz"), { onProgress: page.progress("fly") });
const splats = new SplatRenderer({ renderer, modifier: dissolve, modifierSpace: "object" });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: fly.matrixWorld })]);
scene.add(splats);
page.ready(renderer);

let last: number | undefined;
renderer.setAnimationLoop((time) => {
  controls.update();
  animateT.value += last === undefined ? 0 : Math.min((time - last) / 1000, 0.1);
  last = time;
  // The modifier moves splats by a uniform the CPU sort cannot see
  if (splats.sortMode === "cpu") {
    splats.requestSort();
  }
  renderer.render(scene, camera);
});
