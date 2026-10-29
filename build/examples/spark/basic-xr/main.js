// Spark's basic-xr: a cozy cottage on the desktop or in WebXR, rendering
// paused after 30 seconds without movement. The file holds a LoD tree;
// Radix picks no LoD nodes, so this draws its leaves (every original
// splat) through an index list where Spark draws a budget of LoD nodes.
// The controls move the camera, and in XR its parent, the local frame.
import * as THREE from "three";
import GUI from "lil-gui";
import { CameraControls, SplatCollection, SplatRenderer } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";
import { setupXr, xrBackend } from "../js/xr.js";

const RENDER_TIMEOUT_MS = 30 * 1000;

const page = examplePage("basic-xr", { note: "draws every leaf: no LoD selection" });

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 1000);
const localFrame = new THREE.Group();
localFrame.add(camera);
scene.add(localFrame);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { xr: true, backend: xrBackend() });
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-basic-xr" });

const splats = new SplatRenderer({ renderer, params: { maxStdDev: Math.sqrt(4) } });
scene.add(splats);
setupXr(renderer, [splats], controls);

const world = new THREE.Object3D();
world.position.set(0, -1, 0);
scene.add(world);

// A LoD file: its leaves through an index list (file.indices)
const file = await loadSplatFile(renderer, asset("cozy-cottage-lod.spz"), { layout: "packedSplats", onProgress: page.progress("cozy cottage") });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: world.matrixWorld })]);

let renderEnabled = true;
const gui = new GUI({ title: "Settings" });
gui.add({ disableRender: () => (renderEnabled = false) }, "disableRender").name("Disable render");
gui.add(splats.params, "maxStdDev", 1, Math.sqrt(8), 0.01);

page.ready(renderer);
if (file.indices) {
  page.status(`${file.indices.count.toLocaleString()} leaves of ${file.data.count.toLocaleString()} LoD nodes`);
  setTimeout(() => page.status(""), 4000);
}

let lastMoved = 0;
const lastPos = new THREE.Vector3().setScalar(-Infinity);
const lastDir = new THREE.Vector3();
const pos = new THREE.Vector3();
const dir = new THREE.Vector3();

renderer.setAnimationLoop((time) => {
  controls.update();
  camera.getWorldPosition(pos);
  camera.getWorldDirection(dir);
  if (pos.distanceTo(lastPos) > 0.0001 || dir.dot(lastDir) < 0.9999) {
    lastMoved = time;
    renderEnabled = true;
    lastPos.copy(pos);
    lastDir.copy(dir);
  }
  if (time - lastMoved > RENDER_TIMEOUT_MS) {
    renderEnabled = false;
  }
  if (renderEnabled || renderer.xr.isPresenting) {
    renderer.render(scene, camera);
  }
});


//# sourceURL=examples/spark/basic-xr/main.ts