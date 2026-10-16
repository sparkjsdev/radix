// The draw: a generator that turns baked samples (sample.ts) into lit
// splats every frame. Palette, lights, fog, motion and the 4D turn are
// uniforms, so changing any of them compiles nothing and needs no bake;
// only the shadows are baked (for the light direction of the last bake).
// Light is done in linear color, the palette and the result are sRGB as
// splats are.
import * as THREE from "three";
import { GpuArrayReader, GpuSplats, TSL, type GpuArrays, type SplatGenerator, type TslNode } from "@sparkjsdev/radix";
import { hexToRgb, type Palette } from "./palettes.js";
import { SAMPLES } from "./sample.js";

const {
  Fn, abs, clamp, cos, dot, exp, float, fract, length, max, mix, normalize, positionWorldDirection, pow, screenUV, select, sin, smoothstep, sqrt,
  uint, uniform, unpackHalf2x16, vec3, vec4,
} = TSL;

const v3 = (x = 0, y = 0, z = 0) => uniform(new THREE.Vector3(x, y, z));

// Plain values of the look, set by styles and the panel
export const LOOK_DEFAULTS = {
  // Palette coordinate = trapA * frequency + shift + time * cycle
  frequency: 1,
  shift: 0,
  cycle: 0,
  // How far trapB moves along the palette
  accent: 0.35,
  saturation: 1,
  key: 1.6,
  ambient: 0.45,
  occlusion: 1,
  shadows: 0.85,
  specular: 0.35,
  shininess: 24,
  metal: 0,
  rim: 0.25,
  // Light of unlit (emissive) samples, and crevices that glow
  glow: 1.2,
  crevices: 0,
  fog: 0.12,
  sizeScale: 1,
  opacity: 1,
  flatness: 1,
  sway: 0,
  petals: 0,
  pulse: 0,
  pulseSpeed: 0.25,
  pulseCount: 3,
  twinkle: 0,
};
export type Look = typeof LOOK_DEFAULTS;

// Lighting styles: values of the look (the palette stays)
export const STYLES: Record<string, Partial<Look>> = {
  studio: { key: 1.6, ambient: 0.45, occlusion: 1, shadows: 0.85, specular: 0.35, shininess: 24, metal: 0, rim: 0.25, glow: 1.2, crevices: 0, fog: 0.12, saturation: 1 },
  gilded: { key: 2.1, ambient: 0.25, occlusion: 1, shadows: 0.9, specular: 1.6, shininess: 40, metal: 1, rim: 0.5, glow: 1.2, crevices: 0, fog: 0.08, saturation: 1.1 },
  neon: { key: 0.35, ambient: 0.08, occlusion: 1, shadows: 0.5, specular: 0.6, shininess: 60, metal: 0.4, rim: 1.4, glow: 2.2, crevices: 1.6, fog: 0.2, saturation: 1.3 },
  dreamy: { key: 1.1, ambient: 0.65, occlusion: 1, shadows: 0.6, specular: 0.2, shininess: 14, metal: 0, rim: 0.45, glow: 1.3, crevices: 0, fog: 0.15, saturation: 0.95 },
  dramatic: { key: 2.6, ambient: 0.1, occlusion: 1, shadows: 1, specular: 0.5, shininess: 30, metal: 0.2, rim: 0.15, glow: 1.2, crevices: 0, fog: 0.05, saturation: 1.15 },
  clay: { key: 1.3, ambient: 0.75, occlusion: 1, shadows: 0.7, specular: 0.05, shininess: 8, metal: 0, rim: 0.1, glow: 1, crevices: 0, fog: 0.08, saturation: 0.35 },
  hologram: { key: 0.2, ambient: 0.1, occlusion: 0.6, shadows: 0, specular: 0.8, shininess: 50, metal: 0, rim: 2.2, glow: 2, crevices: 0.8, fog: 0.1, saturation: 1.2 },
  bioluminescent: { key: 0.25, ambient: 0.05, occlusion: 1, shadows: 0.6, specular: 0.2, shininess: 20, metal: 0, rim: 0.3, glow: 2.4, crevices: 2.6, fog: 0.25, saturation: 1.25 },
};

// A palette as uniforms: gradient stops or cosine terms, mixed by `cosine`
function paletteUniforms() {
  return { cosine: uniform(0), stops: [0, 1, 2, 3, 4].map(() => v3()), cosA: v3(), cosB: v3(), cosC: v3(), cosD: v3() };
}
export type PaletteUniforms = ReturnType<typeof paletteUniforms>;

export function makeLookUniforms() {
  const values = Object.fromEntries(Object.entries(LOOK_DEFAULTS).map(([key, value]) => [key, uniform(value)])) as { [K in keyof Look]: TslNode };
  return {
    ...values,
    time: uniform(0),
    // The palette shown, and during a transition the one before
    palettes: [paletteUniforms(), paletteUniforms()],
    skyTop: v3(), skyHorizon: v3(), keyColor: v3(1, 1, 1), groundColor: v3(),
    // Object space, unit
    lightDir: v3(0.5, 0.8, 0.3),
    windDir: v3(1, 0, 0.3),
    // The camera in object space
    camera: v3(0, 0, 4),
    // The steady draw blends the second palette into the first (a change
    // of look without a bake)
    paletteMix: uniform(1),
    // The 4D turn: angles in the xw, yw and zw planes, and during a
    // transition the turn of the fractal it leaves
    turnXW: uniform(0), turnYW: uniform(0), turnZW: uniform(0),
    turnFromXW: uniform(0), turnFromYW: uniform(0), turnFromZW: uniform(0),
    background: uniform(1),
  };
}
export type LookUniforms = ReturnType<typeof makeLookUniforms>;

const setVector = (target: TslNode, rgb: number[]) => (target.value as THREE.Vector3).set(rgb[0], rgb[1], rgb[2]);

export function setPaletteSlot(p: PaletteUniforms, palette: Palette) {
  p.cosine.value = palette.cosine ? 1 : 0;
  if (palette.cosine) {
    [p.cosA, p.cosB, p.cosC, p.cosD].forEach((target, i) => setVector(target, palette.cosine![i]));
  } else {
    palette.stops!.forEach((hex, i) => setVector(p.stops[i], hexToRgb(hex)));
  }
}

export function copyPaletteSlot(to: PaletteUniforms, from: PaletteUniforms) {
  to.cosine.value = from.cosine.value;
  [...to.stops, to.cosA, to.cosB, to.cosC, to.cosD].forEach((target, i) => {
    (target.value as THREE.Vector3).copy([...from.stops, from.cosA, from.cosB, from.cosC, from.cosD][i].value);
  });
}

// The sky, key and ground colors of a palette (the ground: the horizon,
// darker, unless given)
export function skyOf(palette: Palette) {
  return {
    skyTop: hexToRgb(palette.sky[0]),
    skyHorizon: hexToRgb(palette.sky[1]),
    keyColor: hexToRgb(palette.key ?? "#ffffff"),
    groundColor: palette.ground ? hexToRgb(palette.ground) : hexToRgb(palette.sky[1]).map((c) => c * 0.5),
  };
}
export type Sky = ReturnType<typeof skyOf>;

// The sky colors between two palettes' (t = 1: b)
export function setSky(u: LookUniforms, a: Sky, b: Sky, t = 1) {
  for (const key of Object.keys(a) as (keyof Sky)[]) {
    setVector(u[key], a[key].map((value, i) => value + (b[key][i] - value) * t));
  }
}

export function setPalette(u: LookUniforms, palette: Palette) {
  setPaletteSlot(u.palettes[0], palette);
  const sky = skyOf(palette);
  setSky(u, sky, sky);
}

// The palette at t, sRGB
export function paletteNode(p: PaletteUniforms, t: TslNode) {
  const x = float(1).sub(abs(fract(t.mul(0.5)).mul(2).sub(1))).mul(4).toVar();
  const s = p.stops;
  const gradient = mix(mix(mix(mix(s[0], s[1], clamp(x, 0, 1)), s[2], clamp(x.sub(1), 0, 1)), s[3], clamp(x.sub(2), 0, 1)), s[4], clamp(x.sub(3), 0, 1));
  const cosine = p.cosA.add(p.cosB.mul(cos(p.cosC.mul(t).add(p.cosD).mul(Math.PI * 2))));
  return mix(gradient, clamp(cosine, 0, 1), p.cosine);
}

const toLinear = (c: TslNode) => pow(max(c, vec3(0)), vec3(2.2));
const toSrgb = (c: TslNode) => pow(max(c, vec3(0)), vec3(1 / 2.2));

// The rotation taking +z to the unit vector n (xyzw)
const quatFromZ = (n: TslNode) => normalize(vec4(n.y.negate(), n.x, 0, n.z.add(1.0001)));

export interface ShadedSplat {
  center: TslNode;
  scales: TslNode;
  quaternion: TslNode;
  // sRGB
  rgb: TslNode;
  opacity: TslNode;
}

// Which look a sample is drawn with: the steady draw's, or one side of a
// transition (its own palette and 4D turn)
export type Side = "steady" | "from" | "to";

// Sample i of a table as a lit splat
export function shadeSample(u: LookUniforms, reader: GpuArrayReader<typeof SAMPLES>, i: TslNode, side: Side): ShadedSplat {
  const [turnXW, turnYW, turnZW] = side === "from" ? [u.turnFromXW, u.turnFromYW, u.turnFromZW] : [u.turnXW, u.turnYW, u.turnZW];
  const pos = reader.load("pos", i).toVar();
  const attr = reader.load("attr", i).toVar();
  const extra = reader.load("extra", i).toVar();
  const nxy = unpackHalf2x16(attr.x);
  const nzShape = unpackHalf2x16(attr.y).toVar();
  const traps = unpackHalf2x16(attr.z).toVar();
  const occl = unpackHalf2x16(attr.w).toVar();
  const motionLit = unpackHalf2x16(extra.x).toVar();
  const sizeAlpha = unpackHalf2x16(extra.y).toVar();
  const n = normalize(vec3(nxy.x, nxy.y, nzShape.x).add(vec3(0, 1e-5, 0))).toVar();
  const shape = nzShape.y;
  const motion = motionLit.x;
  const alpha = sizeAlpha.y.mul(u.opacity).toVar();

  // The 4D turn, then w is dropped
  const x1 = pos.x.mul(cos(turnXW)).sub(pos.w.mul(sin(turnXW)));
  const w1 = pos.x.mul(sin(turnXW)).add(pos.w.mul(cos(turnXW)));
  const y1 = pos.y.mul(cos(turnYW)).sub(w1.mul(sin(turnYW)));
  const w2 = pos.y.mul(sin(turnYW)).add(w1.mul(cos(turnYW)));
  const z1 = pos.z.mul(cos(turnZW)).sub(w2.mul(sin(turnZW)));
  const p = vec3(x1, y1, z1).toVar();

  // Branches sway with their flex, petals fall and drift
  const hash = fract(sin(float(uint(i)).mul(12.9898)).mul(43758.5453)).toVar();
  const flex = max(motion, 0);
  const gust = sin(u.time.mul(1.1).add(p.x.mul(1.7)).add(p.z.mul(1.3))).add(sin(u.time.mul(2.3).add(p.y.mul(3.1))).mul(0.35));
  p.addAssign(u.windDir.mul(gust.mul(flex).mul(flex).mul(u.sway).mul(0.035)));
  const petal = motion.lessThan(0).and(u.petals.greaterThan(0));
  const fall = fract(u.time.mul(0.05).add(hash.mul(7.31))).toVar();
  const scatter = vec3(fract(hash.mul(91.7)).sub(0.5), 0, fract(hash.mul(53.3)).sub(0.5)).mul(fall.mul(1.4));
  const drift = vec3(fall.mul(0.9).add(sin(fall.mul(11).add(hash.mul(30))).mul(0.12)), fall.mul(-2.4), sin(fall.mul(7).add(hash.mul(17))).mul(0.15)).add(scatter);
  p.addAssign(select(petal, drift.mul(u.petals), vec3(0)));
  alpha.mulAssign(select(petal, smoothstep(0, 0.04, fall).mul(float(1).sub(smoothstep(0.8, 1, fall))), float(1)));

  // Palette and accent
  const t = traps.x.mul(u.frequency).add(u.shift).add(u.time.mul(u.cycle)).toVar();
  const at = t.add(traps.y.mul(u.accent)).toVar();
  const [shown, before] = u.palettes;
  const color = side === "steady" ? mix(paletteNode(before, at), paletteNode(shown, at), u.paletteMix) : paletteNode(side === "from" ? before : shown, at);
  const base = toLinear(color).toVar();

  // Lights: discs by their normal, stretched splats as fibers
  // (Kajiya-Kay), with the baked shadow and occlusion
  const fiber = shape.greaterThan(1);
  const view = normalize(u.camera.sub(p)).toVar();
  const half = normalize(u.lightDir.add(view));
  const nl = dot(n, u.lightDir);
  const nh = dot(n, half);
  const diffuse = select(fiber, sqrt(max(float(1).sub(nl.mul(nl)), 0)).mul(0.75).add(0.1), max(nl, 0));
  const highlight = pow(clamp(select(fiber, sqrt(max(float(1).sub(nh.mul(nh)), 0)), nh), 0, 1), u.shininess);
  const shadow = mix(float(1), occl.y, u.shadows);
  const occlusion = mix(float(1), occl.x, u.occlusion).toVar();
  const fresnel = select(fiber, float(0.15), pow(float(1).sub(clamp(dot(n, view), 0, 1)), 3));
  const sky = toLinear(mix(u.groundColor, u.skyTop.add(u.skyHorizon).mul(0.5), select(fiber, float(0.6), n.y.mul(0.5).add(0.5))));
  const keyColor = toLinear(u.keyColor);
  const specColor = mix(keyColor, base.mul(keyColor).mul(1.5), u.metal);
  const lit = base.mul(keyColor.mul(diffuse.mul(shadow).mul(u.key)).add(sky.mul(u.ambient).mul(occlusion)).mul(float(1).sub(u.metal.mul(0.6))))
    .add(specColor.mul(highlight.mul(shadow).mul(u.specular).mul(occlusion)))
    .add(mix(sky, base, 0.5).mul(fresnel.mul(u.rim).mul(occlusion)));
  const glowing = base.mul(u.crevices).mul(pow(float(1).sub(occl.x), 2).mul(2));
  const pulse = smoothstep(0.9, 1, fract(motion.mul(u.pulseCount).sub(u.time.mul(u.pulseSpeed)).add(traps.y.mul(13)))).mul(u.pulse);
  const rgb = mix(base.mul(u.glow), lit, motionLit.y).add(glowing).add(base.mul(pulse).mul(4)).toVar();

  // Fog toward the horizon from the near side of the fractal (a ball
  // of about 1.1 at the origin), saturation, then back to sRGB
  const depth = max(length(u.camera.sub(p)).sub(max(length(u.camera).sub(1.1), 0)), 0);
  rgb.assign(mix(rgb, toLinear(u.skyHorizon), float(1).sub(exp(u.fog.mul(depth).negate()))));
  const luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb.assign(max(mix(vec3(luma), rgb, u.saturation), vec3(0)));
  alpha.mulAssign(float(1).sub(u.twinkle.mul(sin(u.time.mul(2.7).add(hash.mul(40))).mul(0.5).add(0.5))));

  const size = sizeAlpha.x.mul(u.sizeScale);
  const along = select(fiber, shape, shape.mul(u.flatness));
  return { center: p, scales: vec3(size, size, size.mul(along)), quaternion: quatFromZ(n), rgb: toSrgb(rgb), opacity: clamp(alpha, 0, 1) };
}

export function shadeGenerator(u: LookUniforms): SplatGenerator<{ samples: GpuArrays }> {
  const reader = new GpuArrayReader(SAMPLES);
  return {
    generateSplat: (index) => {
      const i = uint(index);
      const s = shadeSample(u, reader, i, "steady");
      return GpuSplats.Splat(s.center, s.scales, s.quaternion, s.rgb, s.opacity, i);
    },
    bind: ({ samples }) => reader.bind(samples, "samples"),
  };
}

// The sky: the palette's zenith over its horizon, a glow around the light
export function skyNode(u: LookUniforms) {
  return Fn(() => {
    const d = normalize(positionWorldDirection);
    const up = clamp(d.y.mul(0.8).add(0.35), 0, 1);
    const sky = mix(toLinear(u.skyHorizon), toLinear(u.skyTop), pow(up, 0.8));
    const sun = pow(max(dot(d, u.lightDir), 0), 12).mul(0.35).add(pow(max(dot(d, u.lightDir), 0), 200).mul(0.6));
    // A studio sweep: brighter behind the subject, darker at the corners
    const vignette = float(1.25).sub(length(screenUV.sub(0.5)).mul(1.3));
    return sky.add(toLinear(u.keyColor).mul(sun).mul(length(u.skyHorizon).add(0.15))).mul(vignette).mul(u.background);
  })();
}