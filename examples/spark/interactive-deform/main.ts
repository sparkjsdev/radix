// Spark's interactive-deform: drag a point of the penguin to pull the splats
// around it, release for an elastic bounce (a world-space modifier on the
// drag uniforms; the grabbed point comes from THREE.Raycaster against the
// splats, js/raycast.js). Drags elsewhere orbit the camera.
import * as THREE from "three";
import { GUI } from "lil-gui";
import { CameraControls, TSL, type SplatNode } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";

const { cos, distance, exp, float, smoothstep, uniform } = TSL;

const page = examplePage("interactive-deform");
page.legend("Drag the penguin to deform it, release to see it bounce; drag elsewhere to orbit");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 3, 5.5);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-interactive-deform", settings: { mode: "orbit" } });
controls.lookAt(new THREE.Vector3(0, 1.5, 0));

const dragPoint = uniform(new THREE.Vector3());
const dragDisplacement = uniform(new THREE.Vector3());
const bounceDisplacement = uniform(new THREE.Vector3());
const bounceTime = uniform(0);
const radius = uniform(0.5);
const intensity = uniform(5);
const bounceAmount = uniform(0.5);
const bounceSpeed = uniform(0.5);

const gui = new GUI();
gui.add(intensity, "value", 0, 10, 0.1).name("Deformation strength");
gui.add(radius, "value", 0.25, 1, 0.1).name("Drag radius");
gui.add(bounceAmount, "value", 0, 1, 0.1).name("Bounce strength");
gui.add(bounceSpeed, "value", 0, 1, 0.01).name("Bounce speed");

// The drag's displacement (zero when not dragging) plus the decaying bounce
// of the last one, both fading out with the distance from the grabbed point
const deform = (s: SplatNode) => {
  const out = s.toVar();
  const original = s.get("center");
  const influence = float(1).sub(smoothstep(0, radius.mul(2), distance(original, dragPoint)));
  const bounce = bounceDisplacement.mul(cos(bounceTime.mul(bounceSpeed.mul(8).add(1))))
    .mul(exp(bounceTime.mul(-2).mul(float(1).sub(bounceAmount.mul(0.9)))));
  out.get("center").assign(original.add(dragDisplacement.add(bounce).mul(influence).mul(intensity).mul(50)));
  return out;
};

const splats = new SplatSet({ renderer, scene, animate: true, modifier: deform, modifierSpace: "world" });
const penguin = await splats.load(asset("penguin.spz"), { onProgress: page.progress("penguin") });
penguin.quaternion.set(1, 0, 0, 0);
page.ready(renderer);

// Spark's drag scale (the view height at the grabbed point over the window
// height, per NDC unit); undefined when not dragging
let dragScale: number | undefined;
const dragStart = new THREE.Vector2();
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const right = new THREE.Vector3();
const up = new THREE.Vector3();

const toNdc = (event: PointerEvent, out: THREE.Vector2) => out.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);

// In the capture phase, so the controls never see a drag on the penguin
renderer.domElement.addEventListener("pointerdown", (event) => {
  raycaster.setFromCamera(toNdc(event, pointer), camera);
  const hit = raycaster.intersectObject(penguin, false)[0];
  if (!hit) {
    return;
  }
  controls.enabled = false;
  dragStart.copy(pointer);
  dragScale = (2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.distanceTo(hit.point)) / innerHeight;
  dragPoint.value.copy(hit.point);
  dragDisplacement.value.set(0, 0, 0);
  bounceDisplacement.value.set(0, 0, 0);
}, { capture: true });

renderer.domElement.addEventListener("pointermove", (event) => {
  if (dragScale === undefined) {
    return;
  }
  const ndc = toNdc(event, pointer).sub(dragStart).multiplyScalar(dragScale);
  right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  dragDisplacement.value.set(0, 0, 0).addScaledVector(right, ndc.x).addScaledVector(up, ndc.y);
});

addEventListener("pointerup", () => {
  if (dragScale === undefined) {
    return;
  }
  dragScale = undefined;
  controls.enabled = true;
  bounceDisplacement.value.copy(dragDisplacement.value);
  dragDisplacement.value.set(0, 0, 0);
  bounceTime.value = 0;
});

let last: number | undefined;
renderer.setAnimationLoop((time) => {
  const delta = last === undefined ? 0 : Math.min((time - last) / 1000, 0.1);
  last = time;
  controls.update();
  // Spark's 0.1 per frame at 60 fps
  bounceTime.value += delta * 6;
  renderer.render(scene, camera);
});
