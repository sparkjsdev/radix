// Spark's splat-transitions Explosion effect: the current scan bursts into
// bouncing, shrinking splats on the table while the next one grows out of
// the origin. Spark switches each mesh between a death and a birth
// modifier; here one generator reads each object's role, set in bind.
import type GUI from "lil-gui";
import * as THREE from "three";
import { TSL, type TslNode } from "@sparkjsdev/radix";
import { loadGlb } from "../../js/assets.js";
import { textSplats } from "../../js/construct.js";
import { SplatModel } from "../../js/objects.js";
import { fileOf } from "../../js/files.js";
import type { Effect, EffectContext } from "../main.js";

const { abs, clamp, dot, exp, float, floor, fract, max, mix, pow, select, sin, uniform, vec3 } = TSL;

const NONE = 0;
const DEATH = 1;
const BIRTH = 2;
const GRAVITY = 9.8;
const BOUNCE_DAMPING = 0.4;
const FRICTION = 0.98;
const SHRINK_SPEED = 2;
const BIRTH_SECONDS = 0.5;
const TRANSITION_SECONDS = 3;

const hash = (p: TslNode): TslNode => fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
const h = (p: TslNode, k: number) => hash(p.add(vec3(k)));

// Where a splat thrown up from `original` is `time` seconds later: sliding
// with friction, falling, and bouncing to rest on the floor (y = 0)
function explode(original: TslNode, time: TslNode, strength: TslNode): TslNode {
  const t = max(0, time.add(h(original, 42).mul(0.2).sub(0.1))).toVar();
  const velocity = vec3(
    h(original, 1).sub(0.5).mul(strength).mul(h(original, 10).mul(0.4).add(0.3)),
    abs(h(original, 3)).mul(strength).mul(h(original, 20).mul(0.4).add(0.8)).add(0.5),
    h(original, 2).sub(0.5).mul(strength).mul(h(original, 30).mul(0.4).add(0.3)),
  ).toVar();
  const slide = float(1).sub(pow(FRICTION, t.mul(60))).div((1 - FRICTION) * 60);
  const x = original.x.add(velocity.x.mul(slide)).toVar();
  const z = original.z.add(velocity.z.mul(slide)).toVar();
  const y = original.y.add(velocity.y.mul(t)).sub(t.mul(t).mul(GRAVITY / 2)).toVar();

  const bounces = floor(t.mul(3));
  const sinceBounce = t.sub(bounces.div(3)).toVar();
  const bounceHeight = velocity.y.mul(pow(BOUNCE_DAMPING, bounces)).mul(max(0, float(1).sub(sinceBounce.mul(3)))).toVar();
  const bouncing = bounceHeight.greaterThan(0.1);
  const landed = y.lessThanEqual(0);
  const settled = landed.and(bouncing.not());
  const scatter = h(original, 50).mul(0.2);
  return vec3(
    select(settled, x.add(h(original, 60).sub(0.5).mul(scatter)), x),
    select(landed, select(bouncing, abs(sin(sinceBounce.mul(Math.PI * 3))).mul(bounceHeight), float(0)), y),
    select(settled, z.add(h(original, 70).sub(0.5).mul(scatter)), z),
  );
}

export async function init({ renderer, camera, controls, group, scans }: EffectContext): Promise<Effect> {
  camera.position.set(0, 2.5, 7);
  controls.lookAt(new THREE.Vector3(0, 1, 0));
  controls.enabled = true;

  const params = { auto: true };
  const strength = uniform(4.5);
  // Seconds since the explosion, and into the transition
  const dropTime = uniform(0);
  const birthTime = uniform(0);
  // Per object, set by bind
  const role = uniform(NONE);
  const roles = [NONE, NONE, NONE];

  const models = await scans(["penguin.spz", "cat.spz", "woobles.spz"], (s) => {
    const original = s.get("center").toVar();
    const scales = s.get("scales").toVar();

    // Death: thrown up, bouncing, shrinking
    const dying = role.equal(DEATH);
    const deathScales = mix(scales, vec3(0.005), float(1).sub(exp(dropTime.mul(-SHRINK_SPEED))));

    // Birth: grown out of the origin
    const birthing = role.equal(BIRTH);
    const offset = hash(original).mul(0.1 / BIRTH_SECONDS).toVar();
    const adjusted = clamp(birthTime.div(BIRTH_SECONDS).sub(offset).div(float(1).sub(offset)), 0, 1).toVar();
    const ease = pow(adjusted.mul(adjusted).mul(adjusted.mul(-2).add(3)), 0.6).toVar();

    s.get("center").assign(select(dying, explode(original, dropTime, strength), select(birthing, original.mul(ease), original)));
    s.get("scales").assign(select(dying, deathScales, select(birthing, scales.mul(ease), scales)));
    s.get("opacity").assign(select(birthing, s.get("opacity").mul(ease), s.get("opacity")));
    return s;
  }, (data) => (role.value = roles[data.index]));
  models[2].scale.set(1.7, 2, 1.7);
  models.forEach((model, i) => (model.visible = i === 0));

  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(5, 10, 5);
  light.castShadow = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const table = await loadGlb("table.glb");
  table.position.set(0, -0.5, 0);
  table.scale.setScalar(5.5);
  table.traverse((child) => (child.castShadow = child.receiveShadow = true));

  const { data } = textSplats({ text: "WASD + mouse to move\nSPACEBAR: Explosion!", font: "Arial", fontSize: 24, textAlign: "center", lineHeight: 1.3 });
  const text = fileOf(renderer, data);
  const instructions = new SplatModel({ ...text, release: () => text.arrays.dispose() });
  instructions.scale.setScalar(0.15 / 24);
  instructions.position.set(0, 0.2, 2.5);
  group.add(new THREE.AmbientLight(0x404040, 0.6), light, table, instructions);

  let current = 0;
  let next = 1;
  let transitioning = false;
  let idleTime = 0;

  function start() {
    if (transitioning) {
      return;
    }
    next = (current + 1) % models.length;
    models.forEach((model, i) => (model.visible = i === current || i === next));
    roles[current] = DEATH;
    roles[next] = BIRTH;
    dropTime.value = 0;
    birthTime.value = 0;
    idleTime = 0;
    transitioning = true;
  }

  function complete() {
    models[current].visible = false;
    roles[current] = roles[next] = NONE;
    current = next;
    transitioning = false;
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.code === "Space") {
      event.preventDefault();
      if (transitioning) {
        complete();
      }
      start();
    }
  }
  addEventListener("keydown", onKeyDown);

  return {
    update(dt) {
      if (!transitioning && params.auto) {
        idleTime += dt;
        if (idleTime >= 1) {
          start();
        }
      }
      if (transitioning) {
        birthTime.value += dt;
        if (birthTime.value >= TRANSITION_SECONDS) {
          complete();
        }
      }
      dropTime.value += dt;
    },
    gui(folder: GUI) {
      folder.add(strength, "value", 0, 10, 0.1).name("Explosion Strength");
      folder.add(params, "auto").name("Auto Transition");
      folder.add({ explode: start }, "explode").name("Trigger Explosion");
    },
    dispose() {
      removeEventListener("keydown", onKeyDown);
      controls.enabled = false;
    },
  };
}
