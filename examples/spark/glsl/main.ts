// Spark's glsl: a butterfly with a world-space color wave and an
// object-space radial warp, Spark's injected GLSL rewritten in TSL. The
// warp is an object modifier (part of the object's generator); the wave is
// the renderer's modifier in world space.
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer, TSL, type SplatNode } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const { cos, length, sin, uniform, vec3 } = TSL;

const page = examplePage("glsl");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-glsl" });

const animateT = uniform(0);

// vec3 waveRgb(vec3 pos), multiplied into the color (world space)
const wave = (s: SplatNode) => {
  const out = s.toVar();
  const pos = s.get("center");
  const waveRgb = vec3(sin(pos.x.mul(56)).mul(0.4).add(0.6), sin(pos.y.mul(78)).mul(0.4).add(0.6), cos(pos.z.mul(90)).mul(0.4).add(0.6));
  out.get("rgb").assign(s.get("rgb").mul(waveRgb));
  return out;
};

// vec3 warp(vec3 pos, float t): r * (1 + 0.1 sin(15 r + 3 t)) (object space)
const warp = (s: SplatNode) => {
  const out = s.toVar();
  const pos = s.get("center");
  const r = length(pos);
  const newR = r.mul(sin(r.mul(15).add(animateT.mul(3))).mul(0.1).add(1));
  out.get("center").assign(pos.mul(newR.div(r)));
  return out;
};

const butterfly = new THREE.Object3D();
butterfly.rotation.x = Math.PI;
butterfly.position.set(0, 0, -1.5);
scene.add(butterfly);

const file = await loadSplatFile(renderer, asset("butterfly.spz"), { onProgress: page.progress("butterfly") });
const splats = new SplatRenderer({ renderer, modifier: wave, modifierSpace: "world" });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: butterfly.matrixWorld, modifiers: [warp] })]);
scene.add(splats);
page.ready(renderer);

renderer.setAnimationLoop((time) => {
  controls.update();
  animateT.value = time / 1000;
  // The warp moves splats by a uniform the CPU sort cannot see
  if (splats.sortMode === "cpu") {
    splats.requestSort();
  }
  renderer.render(scene, camera);
});
