// Spark's Morph transition: scans in turn scatter into a disk and reassemble as the next
import type GUI from "lil-gui";
import { TSL, type TslNode } from "@sparkjsdev/radix";
import type { Effect, EffectContext } from "../main.js";

const { clamp, cos, float, floor, fract, max, mix, select, sin, sqrt, uniform, vec3 } = TSL;

const ease = (x: TslNode): TslNode => x.mul(x).mul(x.mul(-2).add(3));

export async function init({ camera, scans }: EffectContext): Promise<Effect> {
  camera.position.set(0, 2.2, 6.5);
  camera.lookAt(0, 1, 0);

  const params = { speedMultiplier: 1, rotation: true, pause: false };
  const time = uniform(0);
  const stay = uniform(1.5);
  const trans = uniform(2);
  const randomRadius = uniform(1.3);
  // Per object, set by bind
  const offsetY = uniform(0);

  const files = ["branzino-amarin.spz", "pad-thai.spz", "primerib-tamos.spz"];
  const offsetsY = [0, 0.3, 0];
  const n = files.length;
  const models = await scans(files, (s, objectIndex) => {
    const cycle = stay.add(trans).toVar();
    const total = cycle.mul(n);
    const w = time.sub(floor(time.div(total)).mul(total)).toVar();
    const cur = floor(w.div(cycle)).toVar();
    const nxt = cur.add(1).sub(floor(cur.add(1).div(n)).mul(n));
    const local = w.sub(cur.mul(cycle));
    const inTrans = local.greaterThan(stay);
    const phase = select(inTrans, clamp(local.sub(stay).div(trans), 0, 1), float(0)).toVar();
    const scatter = phase.lessThan(0.5);
    const e = ease(select(scatter, phase.div(0.5), phase.sub(0.5).div(0.5))).toVar();
    const idx = float(objectIndex);

    // Uniform disk sampling on xz by splat index
    const x = float(s.get("index"));
    const hashed = fract(sin(vec3(x, x.add(1), x.add(2))).mul(43758.5453123)).toVar();
    const theta = hashed.x.mul(6.28318530718);
    const r = randomRadius.mul(sqrt(hashed.y));
    const center = s.get("center").toVar();
    const rpMid = mix(center, vec3(r.mul(cos(theta)), offsetY.negate(), r.mul(sin(theta))), 0.7).toVar();
    const scales = s.get("scales").toVar();
    const small = scales.mul(0.2).toVar();

    const isCur = idx.equal(cur);
    const isNext = idx.equal(nxt);
    const alpha = select(isCur, select(inTrans.not(), float(1), select(scatter, float(1).sub(e.mul(0.5)), float(0))),
      select(isNext, select(inTrans.and(scatter.not()), max(e, 0.5), float(0)), float(0)));
    const pos = select(isCur, select(inTrans.not(), center, select(scatter, mix(center, rpMid, e), rpMid)),
      select(isNext, select(inTrans.and(scatter.not()), mix(rpMid, center, e), rpMid), center));
    const scale = select(isCur, select(inTrans.not(), scales, select(scatter, mix(scales, small, e), small)),
      select(isNext, select(inTrans.and(scatter.not()), mix(small, scales, e), small), scales));

    s.get("center").assign(pos.add(vec3(0, offsetY, 0)));
    s.get("scales").assign(scale);
    s.get("opacity").assign(s.get("opacity").mul(alpha));
    return s;
  }, (data) => (offsetY.value = offsetsY[data.index]));
  models.forEach((model) => model.scale.setScalar(1.5));

  return {
    update(dt) {
      if (!params.pause) {
        time.value += dt * params.speedMultiplier;
        if (params.rotation) {
          models.forEach((model) => (model.rotation.y += dt * params.speedMultiplier));
        }
      }
    },
    gui(folder: GUI) {
      folder.add(params, "speedMultiplier", 0.1, 3, 0.01);
      folder.add(params, "rotation");
      folder.add(params, "pause");
      folder.add(stay, "value", 0.2, 5, 0.05).name("staySeconds");
      folder.add(trans, "value", 1, 3, 0.05).name("transitionSeconds");
      folder.add(randomRadius, "value", 1, 5, 0.1).name("randomRadius");
    },
  };
}
