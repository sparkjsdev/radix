// Spark's splat-flow: three scans take turns, each flowing out of the
// previous one's center of mass, over a GLB environment, with the camera
// flying from one to the next. Spark gives each mesh its own world modifier
// with its object index baked in; here one generator (js/worldEffect.js)
// sets each object's index and world matrices in its bind.
import { GUI } from "lil-gui";
import * as THREE from "three";
import { Splats, TSL, type TslNode } from "@sparkjsdev/radix";
import { asset, loadGlb } from "../js/assets.js";
import { SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { loadSplatFile } from "../js/files.js";
import { effectModel, worldEffectGenerator } from "../js/worldEffect.js";

const { abs, float, floor, fract, length, mix, pow, select, sin, smoothstep, uniform, uniformArray, vec3 } = TSL;

const FILES = ["woobles.spz", "dessert.spz", "robot-head.spz"];
const POSITIONS = [new THREE.Vector3(-5, -2.2, -3), new THREE.Vector3(5, -2.5, 0), new THREE.Vector3(0, 1.5, 2)];
const PAUSE_SECONDS = 2;
const CYCLE = 1 + PAUSE_SECONDS;
const TOTAL = CYCLE * FILES.length;
const params = { speedMultiplier: 1, objectRotation: true, pause: false, fixedMinScale: false, cameraRotation: true };

const page = examplePage("splat-flow");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { directCanvas: false, pixelRatio: devicePixelRatio });

const time = uniform(0);
const fixedMinScale = uniform(0);
const waves = uniform(0.5);
const centersOfMass = FILES.map(() => new THREE.Vector3());
const centers = uniformArray(centersOfMass, "vec3");
// Per object, set by bind
const nextIndex = uniform(0, "int");

const hash11 = (x: TslNode) => {
  const p = fract(x.mul(0.1031)).toVar();
  const q = p.add(p.mul(p.add(33.33)));
  return fract(q.mul(q));
};

const generator = worldEffectGenerator((s, objectIndex) => {
  const wrapT = time.sub(floor(time.div(TOTAL)).mul(TOTAL));
  const pos = wrapT.sub(floor(wrapT.div(CYCLE)).mul(CYCLE));
  const t = select(pos.greaterThan(1), float(1), pos).toVar();
  const f = abs(t.mul(2).sub(1)).toVar();

  const center = s.get("center").toVar();
  const k = pow(f, hash11(float(s.get("index"))).mul(2).add(0.5));
  const p = select(t.lessThan(0.5), mix(centers.element(nextIndex), center, k), mix(centers.element(objectIndex), center, k)).toVar();
  s.get("center").assign(p.add(length(sin(p.mul(2.5))).mul(waves).mul(f.oneMinus()).mul(smoothstep(0, 0.5, t).oneMinus()).mul(2)));

  const scales = s.get("scales").toVar();
  s.get("scales").assign(mix(select(fixedMinScale.greaterThan(0.5), vec3(0.02), scales.mul(0.2)), scales, pow(f, 3)));

  const w = time.add(PAUSE_SECONDS + 0.5).toVar();
  const current = floor(w.sub(floor(w.div(TOTAL)).mul(TOTAL)).div(CYCLE));
  s.get("opacity").assign(s.get("opacity").mul(select(current.equal(float(objectIndex)), f.add(0.1), float(0))));
  s.get("rgb").assign(s.get("rgb").mul(f.mul(0.5).add(0.5)));
  return s;
}, { perObject: (data) => (nextIndex.value = (data.index + 1) % FILES.length) });

scene.add(await loadGlb("dali-env.glb", { unlit: "env" }));
const splats = new SplatSet({ renderer, scene, animate: true });

const scans = await Promise.all(FILES.map((file) => loadSplatFile(renderer, asset(file), { onProgress: page.progress(file) })));
const models = scans.map(({ data, arrays }, i) => {
  const model = effectModel(generator, arrays, i);
  model.position.copy(POSITIONS[i]);
  model.rotateX(Math.PI);
  splats.add(model);

  // The center of its bounds, as Spark computes it (only y flipped)
  const { bundle } = Splats.get(data);
  const box = new THREE.Box3();
  const c = new THREE.Vector3();
  for (let j = 0; j < data.count; j += 1) {
    box.expandByPoint(Splats.loadCenter(bundle, j, c));
  }
  box.getCenter(c);
  centersOfMass[i].set(c.x, -c.y, c.z).add(model.position);
  return model;
});

const gui = new GUI();
gui.add(params, "speedMultiplier", 0.25, 4, 0.01);
gui.add(params, "objectRotation");
gui.add(params, "pause");
gui.add(params, "cameraRotation");
gui.add(params, "fixedMinScale").onChange((value: boolean) => (fixedMinScale.value = value ? 1 : 0));
gui.add(waves, "value", 0, 1, 0.01).name("waves");
page.ready(renderer);

// From one scan to the next, circling it
function updateCamera() {
  const w = (time.value + PAUSE_SECONDS) % TOTAL;
  const cur = Math.floor(w / CYCLE);
  const tr = w / CYCLE - cur;
  const s = tr * tr * (3 - 2 * tr);
  const target = new THREE.Vector3().lerpVectors(models[cur].position, models[(cur + 1) % models.length].position, s ** 5);
  const radius = 4 + Math.abs(s - 0.5) ** 2 * 20;
  const angle = -time.value * 0.5;
  const offset = params.cameraRotation ? new THREE.Vector3(Math.cos(angle) * radius, 2, Math.sin(angle) * radius) : new THREE.Vector3(0, 2, -radius);
  camera.position.copy(target).add(offset);
  camera.lookAt(target);
}

let last = 0;
renderer.setAnimationLoop((now) => {
  // Spark's clock runs at half speed
  const dt = last ? Math.min((now - last) / 1000, 0.1) * 0.5 : 0;
  last = now;
  updateCamera();
  if (!params.pause) {
    time.value += dt * params.speedMultiplier;
    if (params.objectRotation) {
      models.forEach((model) => (model.rotation.y += dt * params.speedMultiplier * 2));
    }
  }
  renderer.render(scene, camera);
});
