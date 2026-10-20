// Spark's interactive-ripples: a click on the valley starts a shockwave that
// pushes splats outward and lights the crests (an object-space modifier on
// time and the hit point; the hit comes from a CPU raycast against the
// splats, js/objects.js)
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer, TSL, type SplatNode } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { raycastSplats } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const { abs, exp, length, normalize, pow, sin, smoothstep, uniform } = TSL;

const page = examplePage("interactive-ripples");
page.legend("Click to generate ripples, WASD and the mouse to move");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 2000);
camera.position.set(0, 0, 3);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { antialias: true, pixelRatio: devicePixelRatio });
const controls = new CameraControls({ canvas: renderer.domElement, object: camera });
controls.lookAt(new THREE.Vector3(0, 0, 0));

const time = uniform(0);
// Far away until the first click
const hitpoint = uniform(new THREE.Vector3(0, 0, 1000));

const shockwave = (s: SplatNode) => {
  const out = s.toVar();
  const center = s.get("center").toVar();
  const direction = center.sub(hitpoint).toVar();
  const distance = length(direction).toVar();
  // Spark's smoothstep(t * 2, 0, distance), with its edges in decreasing order
  const falloff = smoothstep(0, time.mul(2), distance).oneMinus().toVar();
  const phase = sin(time.mul(4).sub(distance.mul(5))).toVar();

  out.get("center").assign(center.add(normalize(direction).mul(phase).mul(exp(time.negate())).mul(falloff).mul(0.5)));
  const wave = phase.mul(exp(time.mul(-0.7))).mul(falloff);
  out.get("rgb").assign(s.get("rgb").add(pow(abs(wave), 3).mul(10)));
  return out;
};

const valley = new THREE.Object3D();
valley.rotation.x = Math.PI;
scene.add(valley);

const file = await loadSplatFile(renderer, asset("valley.spz"), { onProgress: page.progress("valley") });
const splats = new SplatRenderer({ renderer, modifier: shockwave, modifierSpace: "object" });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: valley.matrixWorld })]);
scene.add(splats);
page.ready(renderer);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
renderer.domElement.addEventListener("pointerdown", (event) => {
  pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycastSplats(raycaster, file.data, valley.matrixWorld);
  if (hit) {
    hitpoint.value.copy(valley.worldToLocal(hit.point));
    time.value = 0;
  }
});

renderer.setAnimationLoop(() => {
  controls.update();
  time.value += 0.016;
  // The shockwave moves splats by uniforms the CPU sort cannot see
  if (splats.sortMode === "cpu") {
    splats.requestSort();
  }
  renderer.render(scene, camera);
});
