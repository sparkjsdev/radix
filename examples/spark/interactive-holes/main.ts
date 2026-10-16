// Spark's interactive-holes: each click on the bedroom blows the splats
// within a radius up and drops them bouncing to the floor, while they
// shrink. Up to 128 clicks live in uniform arrays read by a world-space
// modifier's shader loop over the stored (original) centers; each click also
// moves the centers in its radius to the floor in the raycast's CPU copy
// only, so later clicks reach through the holes. As in Spark, the GPU keeps
// the original centers: the shader picks the splats a click hit from them.
import * as THREE from "three";
import { GUI } from "lil-gui";
import { CameraControls, TSL, type SplatNode, type TslNode } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { SplatSet, forgetPicker, pickerOf } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";

const { Loop, abs, distance, dot, exp, float, floor, fract, max, mix, pow, select, sin, step, uniform, uniformArray, vec3 } = TSL;

const page = examplePage("interactive-holes");
page.legend("Mouse to look around, click on a splat to blow a hole within a radius");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 50);
camera.position.set(0, -0.3, -3);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { antialias: true, pixelRatio: Math.min(devicePixelRatio, 2) });
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-interactive-holes" });
controls.lookAt(new THREE.Vector3(0, -0.3, 1));

const FRICTION = 0.98;
const BOUNCE_DAMPING = 0.45;
const FLOOR = -1.1;
const SHRINK_SPEED = 5;
const animationTime = uniform(0);
const strength = uniform(4);
const gravity = uniform(9.8);
const settings = { radius: 0.3 };

// Per click: center and radius; start time and active
const MAX_IMPULSES = 128;
const impulseSpheres = Array.from({ length: MAX_IMPULSES }, () => new THREE.Vector4());
const impulseTimes = Array.from({ length: MAX_IMPULSES }, () => new THREE.Vector4());
const uSpheres = uniformArray(impulseSpheres, "vec4");
const uTimes = uniformArray(impulseTimes, "vec4");

const hash = (p: TslNode, k: number) => fract(sin(dot(p.add(vec3(k)), vec3(127.1, 311.7, 74.7))).mul(43758.5453));

// Where a splat blown from `original` is `time` seconds later
function simulatePhysics(original: TslNode, time: TslNode) {
  const t = max(0, time.add(hash(original, 42).mul(0.2).sub(0.1))).toVar();
  const velocity = vec3(
    hash(original, 1).sub(0.5).mul(strength).mul(hash(original, 10).mul(0.4).add(0.3)),
    abs(hash(original, 3)).mul(strength).mul(hash(original, 20).mul(0.4).add(0.8)).add(0.5),
    hash(original, 2).sub(0.5).mul(strength).mul(hash(original, 30).mul(0.4).add(0.3)),
  ).toVar();
  const slide = float(1).sub(pow(FRICTION, t.mul(60))).div((1 - FRICTION) * 60);
  const x = original.x.add(velocity.x.mul(slide)).toVar();
  const z = original.z.add(velocity.z.mul(slide)).toVar();
  const y = original.y.add(velocity.y.mul(t)).sub(gravity.mul(0.5).mul(t).mul(t)).toVar();

  const bounceCount = floor(t.mul(3));
  const sinceBounce = t.sub(bounceCount.div(3)).toVar();
  const bounceHeight = velocity.y.mul(pow(BOUNCE_DAMPING, bounceCount)).mul(max(0, float(1).sub(sinceBounce.mul(3)))).toVar();
  const bouncing = bounceHeight.greaterThan(0.1);
  const landed = y.lessThanEqual(FLOOR);
  const settled = landed.and(bouncing.not());
  const scatter = hash(original, 50).mul(0.2);
  return vec3(
    select(settled, x.add(hash(original, 60).sub(0.5).mul(scatter)), x),
    select(landed, select(bouncing, abs(sin(sinceBounce.mul(Math.PI * 3))).mul(bounceHeight).add(FLOOR), float(FLOOR)), y),
    select(settled, z.add(hash(original, 70).sub(0.5).mul(scatter)), z),
  );
}

// The latest click whose sphere holds a splat moves and shrinks it
const holes = (s: SplatNode) => {
  const out = s.toVar();
  const original = s.get("center").toVar();
  const mask = float(0).toVar();
  const tMax = float(0).toVar();
  Loop(MAX_IMPULSES, ({ i }: { i: TslNode }) => {
    const sphere = uSpheres.element(i);
    const times = uTimes.element(i);
    const m = select(times.y.greaterThan(0.5), step(distance(original, sphere.xyz), sphere.w), float(0));
    mask.assign(max(mask, m));
    tMax.assign(max(tMax, max(0, animationTime.sub(times.x)).mul(m)));
  });
  const hit = mask.greaterThan(0);
  out.get("center").assign(select(hit, simulatePhysics(original, tMax), original));
  out.get("scales").assign(select(hit, mix(s.get("scales"), vec3(0.005), float(1).sub(exp(tMax.mul(-SHRINK_SPEED)))), s.get("scales")));
  return out;
};

const splats = new SplatSet({ renderer, scene, animate: true, modifier: holes, modifierSpace: "world" });
const bedroom = await splats.load(asset("painted-bedroom.spz"), { onProgress: page.progress("painted-bedroom") });
bedroom.rotation.x = Math.PI;
page.ready(renderer);

// The picker's centers in a sphere (in the model's space: Spark's mesh-local
// floor) moved to the floor; the click's raycast has made the picker
function bakeToFloor(worldCenter: THREE.Vector3, radius: number) {
  const local = bedroom.worldToLocal(worldCenter.clone());
  const { centers } = pickerOf(bedroom.data);
  for (let i = 0; i < centers.length; i += 3) {
    const x = centers[i] - local.x;
    const y = centers[i + 1] - local.y;
    const z = centers[i + 2] - local.z;
    if (x * x + y * y + z * z <= radius * radius) {
      centers[i + 1] = 0;
    }
  }
}

// Clicks near the previous one (in NDC) reach deeper
const DEPTH_STEP = 0.08;
const NDC_PROXIMITY = 0.1;
let next = 0;
let depth = 0;
const lastClick = new THREE.Vector2(999, 999);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener("pointerdown", (event) => {
  pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(bedroom, false)[0];
  if (!hit) {
    return;
  }
  depth = pointer.distanceTo(lastClick) < NDC_PROXIMITY ? depth + DEPTH_STEP : 0;
  lastClick.copy(pointer);
  const point = hit.point.addScaledVector(raycaster.ray.direction, depth);

  impulseSpheres[next].set(point.x, point.y, point.z, settings.radius);
  impulseTimes[next].set(animationTime.value, 1, 0, 0);
  next = (next + 1) % MAX_IMPULSES;
  bakeToFloor(point, settings.radius);
});

function reset() {
  forgetPicker(bedroom.data);
  impulseTimes.forEach((times) => times.set(0, 0, 0, 0));
  next = 0;
  depth = 0;
  lastClick.set(999, 999);
}

const gui = new GUI();
gui.add(strength, "value", 0, 10, 0.1).name("Explosion strength");
gui.add(settings, "radius", 0.1, 1, 0.05).name("Explosion radius");
gui.add(gravity, "value", 0, 20, 0.1).name("Gravity");
gui.add({ reset }, "reset").name("Reset holes");

renderer.setAnimationLoop((time) => {
  controls.update();
  animationTime.value = time / 1000;
  renderer.render(scene, camera);
});
