// Spark's dynamic-lighting: a fireplace lit by flickering colored light
// volumes. Spark's SplatEdit layers (ADD_RGBA embers and fire light, and a
// darkening ambient layer) are js/sdf.js's SdfEdits in one world-space
// modifier; the flicker changes uniforms only.
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { SdfBlend, SdfEdit, SdfSphere, sdfModifier } from "../js/sdf.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const page = examplePage("dynamic-lighting");
const legend = page.legend(`
  <label><input type="checkbox" id="debug" autocomplete="off"> Debug Light SDFs</label>
  &nbsp;&nbsp;<label><input type="checkbox" id="lighting" checked autocomplete="off"> Enable Lighting</label>`);
const debug = legend.querySelector<HTMLInputElement>("#debug")!;
const lighting = legend.querySelector<HTMLInputElement>("#lighting")!;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0.3, -2.5);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera });

const emberLayer = new SdfEdit({ rgbaBlendMode: SdfBlend.ADD_RGBA, sdfSmooth: 0.1, softEdge: 0.8, maxSdfs: 1 });
const fireLayer = new SdfEdit({ rgbaBlendMode: SdfBlend.ADD_RGBA, sdfSmooth: 0.1, softEdge: 1.4, maxSdfs: 1 });
const ambientLayer = new SdfEdit({ rgbaBlendMode: SdfBlend.DARKEN, sdfSmooth: 0.1, softEdge: 0.05, maxSdfs: 1 });
const layers = [emberLayer, fireLayer, ambientLayer];
scene.add(...layers);

const fireplace = new THREE.Object3D();
fireplace.rotation.x = Math.PI;
fireplace.position.set(0, -1, -10);
scene.add(fireplace);

// The edits are the renderer's modifier, applied in world space
const file = await loadSplatFile(renderer, asset("fireplace.spz"), { onProgress: page.progress("fireplace") });
const splats = new SplatRenderer({ renderer, modifier: sdfModifier(layers), modifierSpace: "world" });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: fireplace.matrixWorld })]);
scene.add(splats);

// A light sphere in `layer`, with a wireframe helper for "Debug Light SDFs"
const helpers: THREE.Mesh[] = [];
function light(layer: SdfEdit, position: THREE.Vector3, color: THREE.Color, radius: number, opacity: number) {
  const sphere = new SdfSphere({ color, radius, opacity });
  sphere.position.copy(position);
  layer.add(sphere);

  const helper = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 16), new THREE.MeshBasicMaterial({ wireframe: true, color }));
  helper.position.copy(position);
  helper.visible = false;
  scene.add(helper);
  helpers.push(helper);
  return sphere;
}

const fireLights = [
  light(emberLayer, new THREE.Vector3(0.5, -1, -10.5), new THREE.Color(1, 0.6, 0.4), 0.75, 1),
  light(fireLayer, new THREE.Vector3(0.3, -1.1, -10.6), new THREE.Color(1, 0.95, 0.2), 1.6, 0),
];
const ambient = light(ambientLayer, new THREE.Vector3(0, 1, -11), new THREE.Color(1, 0.8, 0.6), 6, 0.8);
debug.addEventListener("change", () => helpers.forEach((helper) => (helper.visible = debug.checked)));
page.ready(renderer);

const BASE_HUE = 0.04;
const HUE_VARIATION = 0.03;
renderer.setAnimationLoop((time) => {
  controls.update();
  const t = time * 0.0005;
  camera.position.z = -2.5 - Math.sin(t * 0.1) * 2;

  const randomFlicker = Math.sin(t * 4) * 0.5 + 0.5;
  const mediumFlicker = Math.sin(t * 13) * 0.1 + 0.1;
  const fastFlicker = Math.sin(t * 20) * 0.1 + 0.1;
  const slowFlicker = Math.sin(t * 6) * 0.04 + 0.5;
  const flicker = (slowFlicker + mediumFlicker + fastFlicker) / 3;
  for (const sphere of fireLights) {
    sphere.color.setHSL(BASE_HUE + flicker * HUE_VARIATION, 0.5 + randomFlicker * 0.3, 0.5 + flicker * 0.2);
    sphere.visible = lighting.checked;
  }
  ambient.color.setHSL(BASE_HUE, 0.5, flicker);
  ambient.visible = lighting.checked;
  layers.forEach((layer) => layer.update());

  // The edits change splats by uniforms the CPU sort cannot see
  if (splats.sortMode === "cpu") {
    splats.requestSort();
  }
  renderer.render(scene, camera);
});
