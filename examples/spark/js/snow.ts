// Spark's generators.snowBox (src/generators/snow.ts) as a TSL
// SplatGenerator: numSplats particles drifting through a box, wrapping
// around it, each wandering on its own phase. The returned uniforms have
// Spark's names (.value to change them); call update(seconds, delta) every
// frame. snow is a SplatModel to add to the scene and a SplatSet.
import * as THREE from "three";
import { GpuSplats, TSL, type TslNode } from "@sparkjsdev/radix";
import { SplatModel } from "./objects.js";

const { float, fract, hash, max, mix, sin, uint, uniform, vec3, vec4 } = TSL;

export const DEFAULT_SNOW = {
  box: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
  density: 100,
  fallDirection: new THREE.Vector3(-1, -3, 1).normalize(),
  fallVelocity: 0.02,
  wanderScale: 0.04,
  wanderVariance: 2,
  color1: new THREE.Color(1, 1, 1),
  color2: new THREE.Color(0.5, 0.5, 1),
  minScale: 0.001,
  maxScale: 0.005,
  anisoScale: new THREE.Vector3(1, 1, 1),
};

export const DEFAULT_RAIN = {
  box: new THREE.Box3(new THREE.Vector3(-2, -1, -2), new THREE.Vector3(2, 5, 2)),
  density: 10,
  fallDirection: new THREE.Vector3(0, -1, 0),
  fallVelocity: 2,
  wanderScale: 0.1,
  wanderVariance: 1,
  color1: new THREE.Color(1, 1, 1),
  color2: new THREE.Color(0.25, 0.25, 0.5),
  minScale: 0.005,
  maxScale: 0.01,
  anisoScale: new THREE.Vector3(0.1, 1, 0.1),
};

// Four hashes in [0, 1) of a uint seed and a salt
const hashVec4 = (seed: TslNode, salt: number) => vec4(
  hash(seed.mul(uint(4)).add(uint(salt))),
  hash(seed.mul(uint(4)).add(uint(salt + 1))),
  hash(seed.mul(uint(4)).add(uint(salt + 2))),
  hash(seed.mul(uint(4)).add(uint(salt + 3))),
);

export interface SnowOptions {
  box?: THREE.Box3;
  minY?: number;
  numSplats?: number;
  density?: number;
  anisoScale?: THREE.Vector3;
  minScale?: number;
  maxScale?: number;
  fallDirection?: THREE.Vector3;
  fallVelocity?: number;
  wanderScale?: number;
  wanderVariance?: number;
  color1?: THREE.Color;
  color2?: THREE.Color;
  opacity?: number;
}

export function snowBox({
  box = DEFAULT_SNOW.box, minY, numSplats, density = 100, anisoScale, minScale = 0.001, maxScale = 0.005, fallDirection,
  fallVelocity = 0.02, wanderScale = 0.01, wanderVariance = 2, color1, color2, opacity = 1,
}: SnowOptions = {}) {
  const size = box.getSize(new THREE.Vector3());
  numSplats ??= Math.max(1, Math.min(1000000, Math.round(size.x * size.y * size.z * density)));
  const toVector = ({ r, g, b }: THREE.Color) => new THREE.Vector3(r, g, b);

  const u = {
    min: uniform(box.min.clone()),
    max: uniform(box.max.clone()),
    // Spark's -Infinity; a large finite value keeps shader math finite
    minY: uniform(minY ?? -1e30),
    color1: uniform(toVector(color1 ?? new THREE.Color(1, 1, 1))),
    color2: uniform(toVector(color2 ?? new THREE.Color(0.5, 0.5, 1))),
    opacity: uniform(opacity),
    fallVelocity: uniform(fallVelocity),
    wanderVariance: uniform(wanderVariance),
    wanderScale: uniform(wanderScale),
    fallDirection: uniform((fallDirection ?? new THREE.Vector3(0, -1, 0)).clone().normalize()),
    minScale: uniform(minScale),
    maxScale: uniform(maxScale),
    anisoScale: uniform((anisoScale?.clone() ?? new THREE.Vector3(1, 1, 1)).normalize()),
  };
  const time = uniform(0);
  const offset = uniform(new THREE.Vector3());

  const generator = {
    generateSplat(index: TslNode) {
      const random = hashVec4(index, 0).toVar();
      const w = random.w;
      const wave = sin(fract(w.mul(100)).mul(Math.PI));
      const scales = u.anisoScale.mul(u.minScale.add(wave.mul(u.maxScale.sub(u.minScale))));
      const intensity = fract(w.mul(10));
      const rgb = mix(u.color1, u.color2, fract(w)).mul(intensity);

      const random2 = hashVec4(index, 0x1ab5).toVar();
      const phase = time.add(random2.w.mul(u.wanderVariance));
      const position = u.min.add(u.max.sub(u.min).mul(fract(random.xyz.add(offset))));
      const perturb = sin(vec3(phase).add(random2.xyz)).mul(u.wanderScale);
      const center = position.add(perturb).toVar();
      const y = max(u.minY, center.y);
      return GpuSplats.Splat(vec3(center.x, y, center.z), scales, vec4(0, 0, 0, 1), rgb, float(u.opacity), uint(index));
    },
  };

  const snow = new SplatModel({ generator, count: numSplats });

  // Each frame: the time in seconds and the frame's delta
  function update(seconds: number, delta: number) {
    time.value = seconds;
    offset.value.addScaledVector(u.fallDirection.value, u.fallVelocity.value * delta);
    // Wrap so float precision holds up over long runs
    offset.value.set(offset.value.x % 1, offset.value.y % 1, offset.value.z % 1);
    snow.visible = u.opacity.value > 0;
  }

  return { snow, update, count: numSplats, ...u };
}
