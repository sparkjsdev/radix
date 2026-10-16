// One baked fractal sample, the bundle every writer fills and the draw
// generator (shade.ts) reads: where it is (a 4th coordinate for 4D kinds),
// its normal (or tangent, for elongated splats), orbit traps, occlusion,
// shadow and how it moves. Positions are in display units (the fractal fits
// a ball of about 1.1), so a new bake can dissolve into the last one.
import { GpuArrayWriter, TSL, defineBundle, type TslNode, type WriterOutputs } from "@sparkjsdev/radix";

const { cos, float, packHalf2x16, pow, sin, sqrt, uint, uvec2, uvec4, vec2, vec3 } = TSL;

export const SAMPLES = defineBundle({
  // x, y, z, w (w: the 4th coordinate, rotated away by the draw)
  pos: "float32x4",
  // halves: [nx, ny], [nz, shape], [trapA, trapB], [ao, shadow]
  attr: "uint32x4",
  // halves: [motion, lit], [size, alpha]
  extra: "uint32x2",
});

export type SampleOutputs = WriterOutputs<{ samples: typeof SAMPLES }>;

export interface Sample {
  pos: TslNode;
  // Unit normal (shape < 1: a disc facing it) or tangent (shape > 1: a
  // splat stretched along it)
  normal: TslNode;
  shape: TslNode;
  // Palette coordinate and accent, about 0..1
  trapA: TslNode;
  trapB: TslNode;
  // 1 open / lit, 0 occluded / in shadow
  ao: TslNode;
  shadow: TslNode;
  // Per kind: a phase along a thread, a branch's flex, a petal, a sparkle
  motion: TslNode;
  // 1 shaded by the lights, 0 emissive
  lit: TslNode;
  // Standard deviation across, display units
  size: TslNode;
  alpha: TslNode;
}

export function storeSample(out: SampleOutputs, s: Sample) {
  out.samples.pos.assign(s.pos);
  out.samples.attr.assign(uvec4(
    packHalf2x16(vec2(s.normal.x, s.normal.y)),
    packHalf2x16(vec2(s.normal.z, s.shape)),
    packHalf2x16(vec2(s.trapA, s.trapB)),
    packHalf2x16(vec2(s.ao, s.shadow)),
  ));
  out.samples.extra.assign(uvec2(packHalf2x16(vec2(s.motion, s.lit)), packHalf2x16(vec2(s.size, s.alpha))));
}

// A writer of samples
export function sampleWriter(write: (index: TslNode, out: SampleOutputs) => void) {
  return new GpuArrayWriter({ outputs: { samples: SAMPLES }, write });
}

// PCG hash (O'Neill; Jarzynski and Olano's GPU variant)
export function pcg(v: TslNode) {
  const state = uint(v).mul(uint(747796405)).add(uint(2891336453)).toVar();
  const word = state.shiftRight(state.shiftRight(uint(28)).add(uint(4))).bitXor(state).mul(uint(277803737)).toVar();
  return word.shiftRight(uint(22)).bitXor(word);
}

// A random stream in a shader. Every draw is stored in a var where it is
// made, so later draws never change earlier values.
export class Rng {
  readonly state: TslNode;

  constructor(seed: TslNode) {
    this.state = pcg(seed).toVar();
  }

  // Uniform in [0, 1)
  next(): TslNode {
    this.state.assign(pcg(this.state));
    return float(this.state.shiftRight(uint(8))).mul(1 / 16777216).toVar();
  }

  // A unit vector, uniform on the sphere
  direction(): TslNode {
    const z = this.next().mul(2).sub(1);
    const phi = this.next().mul(Math.PI * 2);
    const r = sqrt(float(1).sub(z.mul(z)).max(0));
    return vec3(r.mul(cos(phi)), r.mul(sin(phi)), z).toVar();
  }

  // Uniform in the unit ball
  ball(): TslNode {
    return this.direction().mul(pow(this.next(), 1 / 3)).toVar();
  }
}

// The same hash on the CPU, for seeds
export function pcgCpu(v: number) {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
