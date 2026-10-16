// Fields: a number per splat from its position (noise, distances, gradients),
// the usual source of masks.
import { TSL, type TslNode } from "@sparkjsdev/radix";
import type { NodeDef } from "../types.js";
import { IQ_DISTANCE, sdBox, sdPlane, sdSphere } from "./iq.js";

const { Loop, If, abs, clamp, dot, float, floatBitsToUint, fract, length, min, mx_fractal_noise_float, normalize, select, sin, step, vec3 } = TSL;

const THREE_MATERIALX = { name: "three.js MaterialX noise", url: "https://github.com/mrdoob/three.js/tree/dev/src/nodes/materialx", license: "MIT (MaterialX: Apache-2.0)" };
export const SPARK_EXAMPLES = { name: "Spark examples (World Labs)", url: "https://github.com/sparkjsdev/spark/tree/main/examples", license: "MIT" };

// PCG step on a uint (pcg-random.org, as in three's hash)
const pcg = (v: TslNode) => {
  const state = v.mul(747796405).add(2891336453).toVar();
  const word = state.shiftRight(state.shiftRight(28).add(4)).bitXor(state).mul(277803737).toVar();
  return word.shiftRight(22).bitXor(word);
};

export const fieldNodes: NodeDef[] = [
  {
    id: "field.noise",
    label: "Fractal noise",
    description: "Smooth random clouds in space: layered Perlin noise at a position",
    category: "field",
    inputs: {
      position: { type: "vec3", default: [0, 0, 0] },
      scale: { type: "float", default: 2, min: 0.1, max: 20 },
      offset: { type: "vec3", default: [0, 0, 0], min: -10, max: 10 },
      lacunarity: { type: "float", default: 2, min: 1, max: 4 },
      diminish: { type: "float", default: 0.5, min: 0, max: 1 },
    },
    options: { octaves: { default: 3, min: 1, max: 8 } },
    // value: fractal Perlin noise, about [-1, 1]; unit: 0.5 + 0.5 value
    outputs: { value: "float", unit: "float" },
    source: THREE_MATERIALX,
    build: ({ position, scale, offset, lacunarity, diminish }, ctx) => {
      const value = mx_fractal_noise_float(position.mul(scale).add(offset), Number(ctx.option("octaves")), lacunarity, diminish).toVar();
      return { value, unit: value.mul(0.5).add(0.5) };
    },
  },
  {
    id: "field.axisGradient",
    label: "Axis gradient",
    description: "How far along an axis a position is: a ramp through space",
    category: "field",
    inputs: {
      position: { type: "vec3", default: [0, 0, 0] },
      origin: { type: "vec3", default: [0, 0, 0], min: -2, max: 2 },
      axis: { type: "vec3", default: [0, 1, 0], min: -1, max: 1 },
      length: { type: "float", default: 1, min: 0.01, max: 10 },
    },
    // Signed distance along the axis from the origin, in units of length
    outputs: { value: "float" },
    build: ({ position, origin, axis, length }) => ({ value: dot(position.sub(origin), normalize(axis)).div(length) }),
  },
  {
    id: "field.distance",
    label: "Distance to point",
    description: "How far a position is from a point",
    category: "field",
    inputs: {
      position: { type: "vec3", default: [0, 0, 0] },
      point: { type: "vec3", default: [0, 0, 0], min: -2, max: 2 },
    },
    // direction: unit vector from the point (zero at the point)
    outputs: { value: "float", direction: "vec3" },
    build: ({ position, point }) => {
      const d = position.sub(point).toVar();
      const r = length(d).toVar();
      return { value: r, direction: select(r.greaterThan(1e-8), d.div(r), vec3(0)) };
    },
  },
  {
    id: "field.hash3",
    label: "Random per position",
    description: "Three random numbers per splat from its position (stable when the splat order changes)",
    category: "field",
    inputs: {
      position: { type: "vec3", default: [0, 0, 0] },
      seed: { type: "float", default: 0, min: 0, max: 100, step: 1 },
    },
    // value in [0, 1), signed in [-1, 1): PCG of the float bits
    outputs: { value: "vec3", signed: "vec3" },
    build: ({ position, seed }) => {
      const h1 = pcg(floatBitsToUint(position.x).bitXor(pcg(floatBitsToUint(position.y).bitXor(pcg(floatBitsToUint(position.z).bitXor(floatBitsToUint(seed))))))).toVar();
      const h2 = pcg(h1.add(0x9e3779b9)).toVar();
      const h3 = pcg(h2.add(0x9e3779b9)).toVar();
      const value = vec3(h1.toFloat(), h2.toFloat(), h3.toFloat()).mul(1 / 2 ** 32).toVar();
      return { value, signed: value.mul(2).sub(1) };
    },
  },
  {
    id: "field.sineLattice",
    label: "Sine lattice",
    description: "A 3D grid of blobs: length(sin(position * frequency + phase)), small at the blob centers",
    category: "field",
    inputs: {
      position: { type: "vec3", default: [0, 0, 0] },
      frequency: { type: "float", default: 5, min: 0, max: 40 },
      phase: { type: "float", default: 0 },
    },
    outputs: { value: "float" },
    source: SPARK_EXAMPLES,
    build: ({ position, frequency, phase }) => ({ value: length(sin(position.mul(frequency).add(phase))) }),
  },
  {
    id: "field.foldFractal",
    label: "Circuit fractal",
    description: "Glowing circuit-like lines from a folding fractal (Spark's Electronic effect), 1 on a line",
    category: "field",
    inputs: {
      position: { type: "vec3", default: [0, 0, 0] },
      scale: { type: "float", default: 0.25, min: 0.02, max: 2 },
      speed: { type: "float", default: 0.5, min: 0, max: 4 },
      width: { type: "float", default: 0.5, min: 0.05, max: 2 },
    },
    options: { iterations: { default: 8, min: 3, max: 12 } },
    outputs: { mask: "float", trap: "float" },
    time: true,
    source: SPARK_EXAMPLES,
    build: ({ position, scale, speed, width }, ctx) => {
      const p = position.mul(scale).add(vec3(0, 0.5, 0)).toVar();
      const m = float(100).toVar();
      const t = ctx.time.mul(speed).toVar();
      Loop(Number(ctx.option("iterations")), ({ i }: { i: TslNode }) => {
        p.assign(abs(p).div(clamp(abs(p.x.mul(p.y)), 0.3, 3.0)).sub(1.0));
        // p.xy *= rot(90 degrees)
        p.assign(vec3(p.y.negate(), p.x, p.z));
        If(i.greaterThan(1), () => {
          m.assign(min(m, length(p.xy).add(step(0.3, fract(p.z.mul(0.5).add(t).add(float(i).mul(0.2)))))));
        });
      });
      return { mask: step(m, width), trap: m };
    },
  },
  {
    id: "field.sdfBasic",
    label: "Shape distance",
    description: "Signed distance to a sphere, box or plane (negative inside)",
    category: "field",
    inputs: {
      position: { type: "vec3", default: [0, 0, 0] },
      center: { type: "vec3", default: [0, 0, 0], min: -2, max: 2 },
      radius: { type: "float", default: 0.5, min: 0, max: 3 },
      halfSize: { type: "vec3", default: [0.5, 0.5, 0.5], min: 0, max: 3 },
      normal: { type: "vec3", default: [0, 1, 0], min: -1, max: 1 },
    },
    // sphere uses radius, box halfSize, plane normal (through center)
    options: { shape: { default: "sphere", choices: ["sphere", "box", "plane"] } },
    // Signed distance: negative inside
    outputs: { value: "float" },
    source: IQ_DISTANCE,
    build: ({ position, center, radius, halfSize, normal }, ctx) => {
      const p = position.sub(center);
      const shape = ctx.option("shape");
      return { value: shape === "box" ? sdBox(p, halfSize) : shape === "plane" ? sdPlane(p, normalize(normal)) : sdSphere(p, radius) };
    },
  },
];
