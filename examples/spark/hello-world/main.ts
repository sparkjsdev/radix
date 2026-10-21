// Spark's hello-world: a butterfly scan turning in front of the camera
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const page = examplePage("hello-world");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera });

// Most captures are stored upside down
const butterfly = new THREE.Object3D();
butterfly.rotation.x = Math.PI;
butterfly.position.set(0, 0, -3);
scene.add(butterfly);

// The collection reads the object's matrixWorld every render
const file = await loadSplatFile(renderer, asset("butterfly.spz"), { onProgress: page.progress("butterfly") });
const splats = new SplatRenderer({ renderer });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: butterfly.matrixWorld })]);
scene.add(splats);
page.ready(renderer);

renderer.setAnimationLoop((time) => {
  controls.update();
  butterfly.rotation.y = time / 2500;
  renderer.render(scene, camera);
});
