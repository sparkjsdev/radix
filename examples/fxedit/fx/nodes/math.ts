// Math on numbers, plus the two vector operations masks need to drive a
// displacement (scale a direction, add offsets)
import { TSL } from "@sparkjsdev/radix";
import type { NodeDef, PortType } from "../types.js";

const { abs, clamp, cos, cross, dot, exp, float, floor, max, min, mix, normalize, pow, select, sin, smoothstep, vec3, vec4 } = TSL;

const f = (value = 0, min?: number, max?: number) => ({ type: "float" as PortType, default: value, min, max });
const v3 = (value: number[], min?: number, max?: number) => ({ type: "vec3" as PortType, default: value, min, max });

export const mathNodes: NodeDef[] = [
  {
    id: "math.add",
    label: "Add",
    description: "a + b",
    category: "math",
    inputs: { a: f(0), b: f(0) },
    outputs: { value: "float" },
    build: ({ a, b }) => ({ value: a.add(b) }),
  },
  {
    id: "math.sub",
    label: "Subtract",
    description: "a - b",
    category: "math",
    inputs: { a: f(0), b: f(0) },
    outputs: { value: "float" },
    build: ({ a, b }) => ({ value: a.sub(b) }),
  },
  {
    id: "math.mul",
    label: "Multiply",
    description: "a * b",
    category: "math",
    inputs: { a: f(1), b: f(1) },
    outputs: { value: "float" },
    build: ({ a, b }) => ({ value: a.mul(b) }),
  },
  {
    id: "math.div",
    label: "Divide",
    description: "a / b (0 where b is 0)",
    category: "math",
    inputs: { a: f(1), b: f(1) },
    outputs: { value: "float" },
    build: ({ a, b }) => ({ value: select(abs(b).greaterThan(1e-8), a.div(b), float(0)) }),
  },
  {
    id: "math.oneMinus",
    label: "One minus",
    description: "1 - x: flips a 0..1 mask",
    category: "math",
    inputs: { x: f(0, 0, 1) },
    outputs: { value: "float" },
    build: ({ x }) => ({ value: x.oneMinus() }),
  },
  {
    id: "math.clamp",
    label: "Clamp",
    description: "Keeps x between low and high",
    category: "math",
    inputs: { x: f(0), low: f(0), high: f(1) },
    outputs: { value: "float" },
    build: ({ x, low, high }) => ({ value: clamp(x, low, high) }),
  },
  {
    id: "math.remap",
    label: "Remap",
    description: "Maps x from one range to another",
    category: "math",
    inputs: {
      x: f(0),
      inLow: f(0),
      inHigh: f(1),
      outLow: f(0),
      outHigh: f(1),
      clamp: { type: "bool", default: false },
    },
    outputs: { value: "float" },
    build: ({ x, inLow, inHigh, outLow, outHigh, clamp: clamped }) => {
      const t = x.sub(inLow).div(inHigh.sub(inLow)).toVar();
      return { value: mix(outLow, outHigh, select(clamped, clamp(t, 0.0, 1.0), t)) };
    },
  },
  {
    id: "math.smoothstep",
    label: "Smoothstep",
    description: "A soft 0 to 1 step as x goes from low to high",
    category: "math",
    inputs: { x: f(0), low: f(0, 0, 1), high: f(1, 0, 1) },
    outputs: { value: "float" },
    build: ({ x, low, high }) => ({ value: smoothstep(low, high, x) }),
  },
  {
    id: "math.mix",
    label: "Mix",
    description: "Blends from a to b by t",
    category: "math",
    inputs: { a: f(0), b: f(1), t: f(0.5, 0, 1) },
    outputs: { value: "float" },
    build: ({ a, b, t }) => ({ value: mix(a, b, t) }),
  },
  {
    id: "math.minMax",
    label: "Min / max",
    description: "The smaller and the larger of a and b",
    category: "math",
    inputs: { a: f(0), b: f(0) },
    outputs: { min: "float", max: "float" },
    build: ({ a, b }) => ({ min: min(a, b), max: max(a, b) }),
  },
  {
    id: "math.pingPong",
    label: "Ping-pong",
    description: "Goes 0 to 1 and back as x grows",
    category: "math",
    inputs: { x: f(0) },
    // 0 -> 1 -> 0 over x in [0, 2], repeating
    outputs: { value: "float" },
    build: ({ x }) => ({ value: abs(x.sub(floor(x.div(2)).mul(2)).sub(1)).oneMinus() }),
  },
  {
    id: "math.sine",
    label: "Sine wave",
    description: "A wave: amplitude * sin(2 pi (frequency x + phase))",
    category: "math",
    inputs: { x: f(0), frequency: f(1, 0, 10), phase: f(0, 0, 1), amplitude: f(1, 0, 2) },
    // amplitude sin(2 pi (frequency x + phase))
    outputs: { value: "float" },
    build: ({ x, frequency, phase, amplitude }) => ({ value: sin(frequency.mul(x).add(phase).mul(2 * Math.PI)).mul(amplitude) }),
  },
  {
    id: "math.greater",
    label: "Greater than",
    description: "True where a > b",
    category: "math",
    inputs: { a: f(0), b: f(0) },
    outputs: { value: "bool" },
    build: ({ a, b }) => ({ value: a.greaterThan(b) }),
  },
  {
    id: "math.select",
    label: "Choose",
    description: "b where the condition is true, otherwise a",
    category: "math",
    inputs: { condition: { type: "bool", default: false }, a: f(0), b: f(1) },
    outputs: { value: "float" },
    build: ({ condition, a, b }) => ({ value: select(condition, b, a) }),
  },
  {
    id: "math.vec3Scale",
    label: "Scale vector",
    description: "A vector times a number",
    category: "math",
    inputs: { v: { type: "vec3", default: [0, 1, 0], min: -1, max: 1 }, s: f(1) },
    outputs: { value: "vec3" },
    build: ({ v, s }) => ({ value: v.mul(s) }),
  },
  {
    id: "math.vec3Add",
    label: "Add vectors",
    description: "a + b for vectors",
    category: "math",
    inputs: { a: { type: "vec3", default: [0, 0, 0] }, b: { type: "vec3", default: [0, 0, 0] } },
    outputs: { value: "vec3" },
    build: ({ a, b }) => ({ value: a.add(b) }),
  },
  {
    id: "math.pow",
    label: "Power",
    description: "|x| to the power e: shapes a 0..1 ramp (above 1 eases in, below 1 eases out)",
    category: "math",
    inputs: { x: f(0.5), e: f(2, 0, 8) },
    outputs: { value: "float" },
    build: ({ x, e }) => ({ value: pow(abs(x), e) }),
  },
  {
    id: "math.decay",
    label: "Decay",
    description: "exp(-rate x): 1 at x = 0, fading toward 0 (x is often time since something)",
    category: "math",
    inputs: { x: f(0), rate: f(1, 0, 10) },
    outputs: { value: "float" },
    build: ({ x, rate }) => ({ value: exp(rate.mul(x).negate()) }),
  },
  {
    id: "math.wrap",
    label: "Wrap",
    description: "Wraps x into [low, high): a sawtooth, for repeating timelines",
    category: "math",
    inputs: { x: f(0), low: f(0), high: f(1) },
    outputs: { value: "float" },
    build: ({ x, low, high }) => {
      const span = high.sub(low).toVar();
      return { value: low.add(x.sub(low).sub(floor(x.sub(low).div(span)).mul(span))) };
    },
  },
  {
    id: "math.dot",
    label: "Dot product",
    description: "a . b: how much two directions agree (1 same, 0 across, -1 opposite for unit vectors)",
    category: "math",
    inputs: { a: v3([0, 0, 1]), b: v3([0, 0, 1]) },
    outputs: { value: "float" },
    build: ({ a, b }) => ({ value: dot(a, b) }),
  },
  {
    id: "math.vec3Mix",
    label: "Mix vectors",
    description: "Blends vector a toward b by t",
    category: "math",
    inputs: { a: v3([0, 0, 0]), b: v3([0, 0, 0]), t: f(0.5, 0, 1) },
    outputs: { value: "vec3" },
    build: ({ a, b, t }) => ({ value: mix(a, b, t) }),
  },
  {
    id: "math.vec3Split",
    label: "Split vector",
    description: "A vector's x, y and z",
    category: "math",
    inputs: { v: v3([0, 0, 0]) },
    outputs: { x: "float", y: "float", z: "float" },
    build: ({ v }) => ({ x: v.x, y: v.y, z: v.z }),
  },
  {
    id: "math.vec3Combine",
    label: "Combine vector",
    description: "A vector from x, y and z",
    category: "math",
    inputs: { x: f(0), y: f(0), z: f(0) },
    outputs: { value: "vec3" },
    build: ({ x, y, z }) => ({ value: vec3(x, y, z) }),
  },
  {
    id: "math.rotate",
    label: "Rotate",
    description: "Turns a point about an axis through a pivot (right-handed, radians); also gives the rotation",
    category: "math",
    inputs: { point: v3([0, 0, 0]), axis: v3([0, 1, 0], -1, 1), angle: f(0, -6.283, 6.283), pivot: v3([0, 0, 0], -2, 2) },
    // Rodrigues: p cos a + (k x p) sin a + k (k . p)(1 - cos a)
    outputs: { value: "vec3", quaternion: "vec4" },
    build: ({ point, axis, angle, pivot }) => {
      const k = normalize(axis).toVar();
      const p = point.sub(pivot).toVar();
      const c = cos(angle).toVar();
      const s = sin(angle).toVar();
      const rotated = p.mul(c).add(cross(k, p).mul(s)).add(k.mul(dot(k, p)).mul(float(1).sub(c)));
      const half = angle.mul(0.5).toVar();
      return { value: rotated.add(pivot), quaternion: vec4(k.mul(sin(half)), cos(half)) };
    },
  },
  {
    id: "math.scaleAbout",
    label: "Scale about",
    description: "Moves a point toward or away from a pivot: pivot + (point - pivot) * factor",
    category: "math",
    inputs: { point: v3([0, 0, 0]), pivot: v3([0, 0, 0], -2, 2), factor: v3([1, 1, 1], 0, 2) },
    outputs: { value: "vec3" },
    build: ({ point, pivot, factor }) => ({ value: pivot.add(point.sub(pivot).mul(factor)) }),
  },
];
