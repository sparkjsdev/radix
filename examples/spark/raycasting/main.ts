// Spark's raycasting: five swinging robot heads, a click tinting the one hit
// for a moment. Radix has no splat raycast, so js/raycast.ts tests on the CPU.
import * as THREE from "three";
import { asset } from "../js/assets.js";
import { SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { loadSplatFile } from "../js/files.js";

const page = examplePage("raycasting");
page.legend("Click to select");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 10);
camera.position.set(0, -0.25, -1.5);
camera.lookAt(0, -0.15, 0);

const renderer = await windowRenderer(camera);

const splats = new SplatSet({ renderer, scene });
const head = await loadSplatFile(renderer, asset("robot-head.spz"), { onProgress: page.progress("robot-head") });
const robots = Array.from({ length: 5 }, (_, i) => {
  const model = splats.of(head);
  model.rotation.x = Math.PI;
  model.scale.setScalar(0.2);
  model.position.z = i;
  return { model, speed: 600 + i * 10, clickedTimer: 0 };
});
page.ready(renderer);

const WHITE = new THREE.Color(1, 1, 1);
const PINK = new THREE.Color(1, 0.5, 0.5);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener("click", (event) => {
  pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(robots.map((robot) => robot.model))[0];
  const robot = robots.find((robot) => robot.model === hit?.object);
  if (robot && !robot.clickedTimer) {
    robot.model.recolor = PINK;
    robot.clickedTimer = 40;
  }
});

renderer.setAnimationLoop((time) => {
  for (const robot of robots) {
    const angle = Math.PI * 1.5 + Math.sin(time / robot.speed);
    robot.model.position.x = Math.cos(angle) * 0.6;
    robot.model.position.y = Math.sin(angle) * 0.6;
    if (robot.clickedTimer > 0 && --robot.clickedTimer === 0) {
      robot.model.recolor = WHITE;
    }
  }
  renderer.render(scene, camera);
});
