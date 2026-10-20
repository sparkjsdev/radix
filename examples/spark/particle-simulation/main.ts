// Spark's particle-simulation: snow falling on a snowy street. The snow is
// Spark's snowBox rewritten as a TSL generator (js/snow.js), up to a
// million particles made in the projection's shader and sorted with the
// street scan in one sort.
import * as THREE from "three";
import GUI from "lil-gui";
import { CameraControls, SplatCollection, SplatRenderer } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";
import { DEFAULT_SNOW, snowBox } from "../js/snow.js";

const page = examplePage("particle-simulation");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera });

const street = new THREE.Object3D();
street.quaternion.set(1, 0, 0, 0);
street.position.set(-8, -12, -104);
scene.add(street);

// Around the camera's path down the street; no snow below y = -4
const snow = snowBox({
  ...DEFAULT_SNOW,
  box: new THREE.Box3(new THREE.Vector3(-12, -64, -96), new THREE.Vector3(12, 16, 0.375)),
  minY: -4,
  color1: new THREE.Color(1, 1, 1),
  color2: new THREE.Color(0.91, 0.9, 0.97),
  density: 1000,
  fallVelocity: 0.04,
  maxScale: 0.01,
});

// The scan and the snow generator's object (in world space) in one sort
const file = await loadSplatFile(renderer, asset("snow-street.spz"), { onProgress: page.progress("street") });
const splats = new SplatRenderer({ renderer });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: street.matrixWorld }), snow.snow.splatObject]);
scene.add(splats);

const params = { paused: false, color1: new THREE.Color(1, 1, 1), color2: new THREE.Color(0.91, 0.9, 0.97), wind: "None" };

// The wind's east-west (x) and north-south (z) push on snow falling at y = -1
const wind = { x: 0, z: 0 };
const WINDS: Record<string, [number, number]> = {
  None: [0, 0], N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1],
};
const setWind = () => snow.fallDirection.value.set(wind.x, -1, wind.z).normalize();

const gui = new GUI({ title: "Snow" });
gui.add(snow.fallVelocity, "value", 0.01, 0.5, 0.01).name("Fall velocity");
gui.add(snow.wanderScale, "value", 0.01, 1, 0.01).name("Wander scale");
gui.add(snow.wanderVariance, "value", 1, 5, 0.1).name("Wander variance");
gui.add(snow.maxScale, "value", 0.001, 0.05, 0.001).name("Snow size");
gui.add(params, "wind", Object.keys(WINDS)).name("Wind").onChange((key: string) => {
  [wind.x, wind.z] = WINDS[key];
  setWind();
});
gui.add(wind, "x", -1, 1, 0.1).name("East-West").listen().onChange(setWind);
gui.add(wind, "z", -1, 1, 0.1).name("North-South").listen().onChange(setWind);
gui.addColor(params, "color1").name("Color 1").onChange((value: THREE.Color) => snow.color1.value.set(value.r, value.g, value.b));
gui.addColor(params, "color2").name("Color 2").onChange((value: THREE.Color) => snow.color2.value.set(value.r, value.g, value.b));
gui.add(params, "paused").name("Pause snowfall");
page.ready(renderer);

let last = 0;
let snowTime = 0;
renderer.setAnimationLoop((time) => {
  const delta = Math.min((time - last) / 1000, 0.1);
  last = time;
  controls.update();
  camera.position.z = -13.5 * Math.sin(Math.min(1, time / 90000) * Math.PI * 0.5);
  if (!params.paused) {
    snowTime += delta;
    snow.update(snowTime, delta);
  }

  // The snow moves by uniforms the CPU sort cannot see
  if (splats.sortMode === "cpu") {
    splats.requestSort();
  }
  renderer.render(scene, camera);
});
