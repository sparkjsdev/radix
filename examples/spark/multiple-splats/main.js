// Spark's multiple-splats: six copies of one butterfly scan (one upload, six
// objects with their own matrices) circling a bobbing cat, all in one sort
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const page = examplePage("multiple-splats");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 0, 6.5);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-multiple-splats", settings: { mode: "orbit" } });
controls.lookAt(new THREE.Vector3(0, 0, 0));

const [butterfly, cat] = await Promise.all([
  loadSplatFile(renderer, asset("butterfly-ai.spz"), { onProgress: page.progress("butterfly") }),
  loadSplatFile(renderer, asset("cat.spz"), { onProgress: page.progress("cat") }),
]);

// An Object3D places each copy: its matrixWorld is the splat object's.
// The scans are stored upside down.
const holders = Array.from({ length: 7 }, () => {
  const holder = new THREE.Object3D();
  holder.rotation.x = Math.PI;
  scene.add(holder);
  return holder;
});
const [catHolder, ...butterflies] = holders;
catHolder.scale.setScalar(0.5);

// Seven objects of two uploads in one collection, so one sort
const splats = new SplatRenderer({ renderer });
splats.collection = new SplatCollection([
  fileObject(cat, { matrixWorld: catHolder.matrixWorld }),
  ...butterflies.map((holder) => fileObject(butterfly, { matrixWorld: holder.matrixWorld })),
]);
scene.add(splats);
page.ready(renderer);

const RADIUS = 2;
renderer.setAnimationLoop((time) => {
  controls.update();
  butterflies.forEach((holder, i) => {
    const angle = -time / 10000 + (i / butterflies.length) * Math.PI * 2;
    holder.position.set(Math.cos(angle) * RADIUS, Math.sin(angle) * RADIUS - 0.2, 0);
    holder.rotation.y = i + time / 4000;
  });
  catHolder.position.y = -0.8 + Math.sin(time / 1000) * 0.1;
  renderer.render(scene, camera);
});


//# sourceURL=examples/spark/multiple-splats/main.ts