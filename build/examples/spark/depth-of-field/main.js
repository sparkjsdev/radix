// Spark's depth-of-field: the valley scan with a focal plane and aperture.
// Spark's apertureAngle is the full cone angle; Radix's apertureTan is the
// tangent of half of it, so apertureTan = 0.5 * apertureSize / focalDistance.
import GUI from "lil-gui";
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const page = examplePage("depth-of-field");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-depth-of-field" });

const splats = new SplatRenderer({ renderer });
scene.add(splats);

// The renderer's object params: every object's unless it sets its own
const settings = { focalDistance: 5, apertureSize: 0.1 };
function updateAperture() {
  splats.objectParams.focalDistance = settings.focalDistance;
  splats.objectParams.apertureTan = settings.focalDistance > 0 ? (0.5 * settings.apertureSize) / settings.focalDistance : 0;
}
updateAperture();

const gui = new GUI({ title: "DoF settings" });
gui.add(settings, "focalDistance", 0, 15, 0.01).name("Focal plane dist").onChange(updateAperture);
gui.add(settings, "apertureSize", 0, 0.4, 0.01).name("Aperture size").onChange(updateAperture);

const valley = new THREE.Object3D();
valley.rotation.x = Math.PI;
valley.scale.setScalar(0.5);
scene.add(valley);

const file = await loadSplatFile(renderer, asset("valley.spz"), { onProgress: page.progress("valley") });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: valley.matrixWorld })]);
page.ready(renderer);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});


//# sourceURL=examples/spark/depth-of-field/main.ts