// Spark's extsplats: the same igloo stored 1000 units from its origin, in
// packedSplats (half-float centers, about 1/1000 relative precision: the
// lower copy jitters into blocks) and extSplats (float32 centers: the upper
// copy stays sharp), both brought back in front of the camera
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const page = examplePage("extsplats");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-extsplats" });

// The group undoes the files' offset; each holder places one copy in it
const group = new THREE.Group();
group.position.set(0, 0, 1000);
scene.add(group);

const copies = await Promise.all(([[-1.5, "packedSplats"], [1.5, "extSplats"]]         ).map(async ([y, layout]) => {
  const holder = new THREE.Object3D();
  holder.position.set(0, y, 0);
  group.add(holder);
  const file = await loadSplatFile(renderer, asset("distant-igloo.spz"), { layout, onProgress: page.progress(layout) });
  return fileObject(file, { matrixWorld: holder.matrixWorld });
}));

const splats = new SplatRenderer({ renderer });
splats.collection = new SplatCollection(copies);
scene.add(splats);
page.ready(renderer);

renderer.setAnimationLoop((time) => {
  controls.update();
  group.position.y = Math.sin(time / 1000) * 1.5;
  renderer.render(scene, camera);
});


//# sourceURL=examples/spark/extsplats/main.ts