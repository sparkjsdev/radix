// Spark's Flow transition, the splat-flow example inside the transitions page
import type GUI from "lil-gui";
import * as THREE from "three";
import { Splats, TSL, type TslNode } from "@sparkjsdev/radix";
import { loadGlb } from "../../js/assets.js";
import type { Effect, EffectContext } from "../main.js";

const { abs, float, floor, fract, length, mix, pow, select, sin, smoothstep, uniform, uniformArray, vec3 } = TSL;

const PAUSE_SECONDS = 2;
const CYCLE = 1 + PAUSE_SECONDS;

const hash11 = (x: TslNode): TslNode => {
  const p = fract(x.mul(0.1031)).toVar();
  const q = p.add(p.mul(p.add(33.33)));
  return fract(q.mul(q));
};

export async function init({ camera, group, scans, loadScan }: EffectContext): Promise<Effect> {
  const params = { speedMultiplier: 0.5, objectRotation: true, pause: false, fixedMinScale: false, cameraRotation: true };
  const time = uniform(0);
  const fixedMinScale = uniform(0);
  const waves = uniform(0.5);
  // Per object, set by bind
  const nextIndex = uniform(0, "int");

  const files = ["woobles.spz", "dessert.spz", "robot-head.spz"];
  const total = CYCLE * files.length;
  const centersOfMass = files.map(() => new THREE.Vector3());
  const centers = uniformArray(centersOfMass, "vec3");
  const models = await scans(files, (s, objectIndex) => {
    const wrapT = time.sub(floor(time.div(total)).mul(total));
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
    const current = floor(w.sub(floor(w.div(total)).mul(total)).div(CYCLE));
    s.get("opacity").assign(s.get("opacity").mul(select(current.equal(float(objectIndex)), f.add(0.1), float(0))));
    s.get("rgb").assign(s.get("rgb").mul(f.mul(0.5).add(0.5)));
    return s;
  }, (data) => (nextIndex.value = (data.index + 1) % files.length));

  // Each scan's place and the center of its bounds there, as Spark computes it (only y flipped)
  const positions = [new THREE.Vector3(-5, -2.2, -3), new THREE.Vector3(5, -2.5, 0), new THREE.Vector3(0, 1.5, 2)];
  for (const [i, model] of models.entries()) {
    model.position.copy(positions[i]);
    const { data } = await loadScan(files[i]);
    const { bundle } = Splats.get(data);
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    for (let j = 0; j < data.count; j += 1) {
      box.expandByPoint(Splats.loadCenter(bundle, j, c));
    }
    box.getCenter(c);
    centersOfMass[i].set(c.x, -c.y, c.z).add(model.position);
  }

  group.add(await loadGlb("dali-env.glb", { unlit: "env" }));

  function updateCamera() {
    const w = (time.value + PAUSE_SECONDS) % total;
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

  return {
    update(dt) {
      if (!params.pause) {
        time.value += dt * params.speedMultiplier;
        if (params.objectRotation) {
          models.forEach((model) => (model.rotation.y += dt * params.speedMultiplier * 2));
        }
      }
      updateCamera();
    },
    gui(folder: GUI) {
      folder.add(params, "speedMultiplier", 0, 1, 0.01);
      folder.add(params, "objectRotation");
      folder.add(params, "pause");
      folder.add(params, "cameraRotation");
      folder.add(params, "fixedMinScale").onChange((value: boolean) => (fixedMinScale.value = value ? 1 : 0));
      folder.add(waves, "value", 0, 1, 0.01).name("waves");
    },
  };
}
