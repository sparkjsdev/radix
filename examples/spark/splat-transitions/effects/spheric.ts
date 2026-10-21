// Spark's Spherical transition: each scan gathers onto a sphere and the next unfolds from it
import type GUI from "lil-gui";
import { TSL, type TslNode } from "@sparkjsdev/radix";
import { loadGlb } from "../../js/assets.js";
import type { Effect, EffectContext } from "../main.js";

const { abs, cos, cross, float, max, mix, normalize, pow, select, sin, uniform, vec3 } = TSL;

const ramp = (t: TslNode, start: number, power: number): TslNode => pow(max(t.sub(start).mul(5), 0), power);

export async function init({ camera, group, scans }: EffectContext): Promise<Effect> {
  camera.position.set(5, 4, 7);
  camera.lookAt(0, 2, 0);

  const params = { speedMultiplier: 1, rotation: true, pause: false };
  const time = uniform(0);
  const radius = uniform(1);
  const height = uniform(2);
  const coverage = uniform(1);
  // Per object, set by bind
  const fadeInTime = uniform(0);
  const fadeOutTime = uniform(0);
  const thousands = uniform(1);

  const files = ["penguin.spz", "dessert.spz", "woobles.spz"];
  const period = files.length;
  const models = await scans(files, (s) => {
    const wrapT = time.sub(time.div(period).floor().mul(period)).toVar();
    const t = time.fract().toVar();
    const fadeIn = wrapT.greaterThan(fadeInTime).and(wrapT.lessThan(fadeInTime.add(1)));
    const fadeOut = wrapT.greaterThan(fadeOutTime).and(wrapT.lessThan(fadeOutTime.add(1)));

    const center = s.get("center").toVar();
    const heightModifier = pow(abs(float(1).sub(t.mul(2))), 0.2).mul(0.5).add(0.5);
    const target = vec3(0, heightModifier.mul(height), 0);
    const dir = normalize(center.sub(target)).toVar();
    const targetPoint = target.add(dir.mul(radius)).toVar();
    const churnT = t.sub(0.45).mul(10).toVar();
    const angle = churnT.mul(Math.PI * 2);
    const churn = targetPoint.add(cross(dir, vec3(sin(angle), 0, cos(angle))).mul(0.1).mul(sin(churnT.mul(Math.PI))));
    s.get("center").assign(select(t.lessThan(0.25).or(t.greaterThan(0.75)), center,
      select(t.lessThan(0.45), mix(center, targetPoint, ramp(t, 0.25, 4)),
        select(t.lessThan(0.55), churn, mix(targetPoint, center, ramp(t, 0.55, 4))))));

    const scales = s.get("scales").toVar();
    const targetScales = vec3(coverage.mul(radius).div(thousands));
    s.get("scales").assign(select(t.lessThan(0.25), scales,
      select(t.lessThan(0.45), mix(scales, targetScales, ramp(t, 0.25, 2)),
        select(t.lessThan(0.55), targetScales,
          select(t.lessThan(0.75), mix(targetScales, scales, ramp(t, 0.55, 2)), scales)))));

    const opacity = s.get("opacity").toVar();
    const fading = ramp(t, 0.4, 2);
    const inOpacity = select(t.lessThan(0.4), float(0), select(t.lessThan(0.6), mix(float(0), opacity, fading), opacity));
    const outOpacity = select(t.lessThan(0.4), opacity, select(t.lessThan(0.6), mix(opacity, float(0), fading), float(0)));
    s.get("opacity").assign(select(fadeIn.or(fadeOut), select(fadeIn, inOpacity, outOpacity), float(0)));
    return s;
  }, (data) => {
    fadeInTime.value = data.index;
    fadeOutTime.value = (data.index + 1) % period;
    thousands.value = data.splats.count / 1000;
  });

  const table = await loadGlb("dali-table.glb", { unlit: true });
  table.scale.setScalar(3.5);
  table.position.set(-1, 0, -0.8);
  group.add(await loadGlb("dali-env.glb", { unlit: "env" }), table);

  return {
    update(dt) {
      if (!params.pause) {
        time.value += dt * 0.5 * params.speedMultiplier;
        if (params.rotation) {
          models.forEach((model) => (model.rotation.y += dt * params.speedMultiplier));
        }
      }
    },
    gui(folder: GUI) {
      folder.add(radius, "value", 0.1, 8, 0.01).name("sphereRadius");
      folder.add(height, "value", -1, 4, 0.01).name("sphereHeight");
      folder.add(coverage, "value", 0.1, 2, 0.01).name("splatCoverage");
      folder.add(params, "speedMultiplier", 0.25, 4, 0.01);
      folder.add(params, "rotation");
      folder.add(params, "pause");
    },
  };
}
