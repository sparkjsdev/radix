// Spark's envmap: a chrome rubber duck reflecting two copies of the
// fireplace scan. The reflection is a cube map of the splats rendered from
// the duck's position (js/cube.js: one projection and sort per face), with
// the duck hidden. The duck is lit only by it.
import * as THREE from "three";
import { CameraControls } from "@sparkjsdev/radix";
import { asset, loadGlb } from "../js/assets.js";
import { renderCubeMap } from "../js/cube.js";
import { SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { loadSplatFile } from "../js/files.js";

const page = examplePage("envmap");
const legend = page.legend("<label><input type=\"checkbox\" autocomplete=\"off\"> Plastic</label>");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2037);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 0.5, 0);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { directCanvas: false });
const controls = new CameraControls({ canvas: renderer.domElement, object: camera });

// Two copies of one upload
const splats = new SplatSet({ renderer, scene });
const fireplace = await loadSplatFile(renderer, asset("fireplace.spz"), { onProgress: page.progress("fireplace") });
for (const [x, z, turn] of [[0.5, -1, 0], [-0.5, 0, Math.PI]]) {
  const copy = splats.of(fireplace);
  copy.rotation.set(Math.PI, turn, 0);
  copy.position.set(x, 0, z);
  copy.scale.setScalar(0.5);
}

const duck = await loadGlb("rubberduck.glb");
duck.position.set(0, 0.45, -0.4);
scene.add(duck);

// The CPU sort (WebGL2) sorts each face before the first render, so the
// set's collection is made here
scene.updateMatrixWorld(true);
splats.update();
const envMap = (await renderCubeMap({ renderer, scene, splatRenderer: splats.renderer, worldCenter: duck.position, hideObjects: [duck] })).texture;
const materials: THREE.MeshStandardMaterial[] = [];
duck.traverse((child) => {
  if (child instanceof THREE.Mesh) {
    const material = child.material as THREE.MeshStandardMaterial;
    material.envMap = envMap;
    materials.push(material);
  }
});

const setPlastic = (plastic: boolean) => materials.forEach((material) => {
  material.metalness = plastic ? 0 : 1;
  material.roughness = plastic ? 0.2 : 0.02;
});
setPlastic(false);
legend.querySelector("input")!.addEventListener("change", (event) => setPlastic((event.target as HTMLInputElement).checked));
page.ready(renderer);

let last: number | undefined;
renderer.setAnimationLoop((time) => {
  const delta = last === undefined ? 0 : Math.min((time - last) / 1000, 0.1);
  last = time;
  controls.update();
  duck.rotation.y += delta * 0.4;
  renderer.render(scene, camera);
});
