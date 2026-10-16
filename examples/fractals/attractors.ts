// Strange attractors as threads of light. Samples come in threads of
// THREAD samples: a thread starts at a random point near the attractor,
// settles for `settle` steps, and its k-th sample integrates k more steps
// (midpoint rule). Every sample of a thread repeats the same arithmetic, so
// they line up into one continuous curve; each is a splat stretched along
// the velocity to its neighbors, lit as a fiber, with light pulses running
// along the thread (the draw's pulse uses the phase k / THREAD).
import { TSL, type TslNode } from "@sparkjsdev/radix";
import { paramUniforms, type BakeUniforms, type Kind, type Param } from "./kind.js";
import { Rng, pcg, sampleWriter, storeSample } from "./sample.js";

const { Loop, exp, float, int, length, max, normalize, select, sin, uint, vec3, vec4 } = TSL;

const THREAD = 1024;

type U = Record<string, TslNode>;

interface Attractor {
  id: string;
  label: string;
  params: Record<string, Param>;
  dt: number;
  // The native point at the display origin
  center: [number, number, number];
  // Where threads start (default the center), how far apart, how long
  // they settle, and their default width
  start?: [number, number, number];
  spread?: number;
  settle?: number;
  width?: number;
  // Display units per native unit
  scale: number;
  // Native z is the display's up
  zUp: boolean;
  // Speed of a typical thread (for color)
  speed: number;
  derivative: (p: TslNode, u: U) => TslNode;
}

const p = (value: number, min: number, max: number): Param => ({ value, min, max, step: 0.001 });

export const ATTRACTORS: Attractor[] = [
  {
    id: "lorenz", label: "Lorenz attractor", dt: 0.0035, center: [0, 0, 25], start: [0, 2, 25], spread: 6, settle: 1500, scale: 1 / 21, zUp: true, speed: 60,
    params: { sigma: p(10, 1, 20), rho: p(28, 5, 60), beta: p(8 / 3, 0.5, 6) },
    derivative: (q, u) => vec3(u.sigma.mul(q.y.sub(q.x)), q.x.mul(u.rho.sub(q.z)).sub(q.y), q.x.mul(q.y).sub(u.beta.mul(q.z))),
  },
  {
    id: "aizawa", label: "Aizawa attractor", dt: 0.008, center: [0, 0, 0.7], start: [0.1, 0, 0], width: 0.0015, scale: 0.58, zUp: true, speed: 1.5,
    params: { a: p(0.95, 0.5, 1.2), b: p(0.7, 0.4, 1), c: p(0.6, 0.2, 1), d: p(3.5, 2, 5), e: p(0.25, 0, 0.6), f: p(0.1, 0, 0.3) },
    derivative: (q, u) => {
      const zb = q.z.sub(u.b);
      return vec3(
        zb.mul(q.x).sub(u.d.mul(q.y)),
        u.d.mul(q.x).add(zb.mul(q.y)),
        u.c.add(u.a.mul(q.z)).sub(q.z.mul(q.z).mul(q.z).div(3)).sub(q.x.mul(q.x).add(q.y.mul(q.y)).mul(u.e.mul(q.z).add(1))).add(u.f.mul(q.z).mul(q.x).mul(q.x).mul(q.x)),
      );
    },
  },
  {
    id: "thomas", label: "Thomas attractor", dt: 0.05, center: [0, 0, 0], scale: 0.24, zUp: false, speed: 1.2,
    params: { b: p(0.208186, 0.1, 0.33) },
    derivative: (q, u) => vec3(sin(q.y).sub(u.b.mul(q.x)), sin(q.z).sub(u.b.mul(q.y)), sin(q.x).sub(u.b.mul(q.z))),
  },
  {
    id: "halvorsen", label: "Halvorsen attractor", dt: 0.004, center: [-1.5, -1.5, -1.5], scale: 0.1, zUp: false, speed: 18,
    params: { a: p(1.89, 1.2, 2.4) },
    derivative: (q, u) => vec3(
      u.a.negate().mul(q.x).sub(q.y.mul(4)).sub(q.z.mul(4)).sub(q.y.mul(q.y)),
      u.a.negate().mul(q.y).sub(q.z.mul(4)).sub(q.x.mul(4)).sub(q.z.mul(q.z)),
      u.a.negate().mul(q.z).sub(q.x.mul(4)).sub(q.y.mul(4)).sub(q.x.mul(q.x)),
    ),
  },
  {
    id: "dadras", label: "Dadras attractor", dt: 0.004, center: [0, 0, 0], start: [1, 1, 0], scale: 0.075, zUp: true, speed: 25,
    params: { a: p(3, 1, 5), b: p(2.7, 1, 4), c: p(1.7, 0.5, 3), d: p(2, 1, 4), e: p(9, 5, 12) },
    derivative: (q, u) => vec3(
      q.y.sub(u.a.mul(q.x)).add(u.b.mul(q.y).mul(q.z)),
      u.c.mul(q.y).sub(q.x.mul(q.z)).add(q.z),
      u.d.mul(q.x).mul(q.y).sub(u.e.mul(q.z)),
    ),
  },
  {
    id: "chen", label: "Chen attractor", dt: 0.0018, center: [0, 0, 23], start: [0, 2, 22], spread: 6, settle: 1500, scale: 1 / 25, zUp: true, speed: 90,
    params: { a: p(35, 20, 45), b: p(3, 1, 6), c: p(28, 15, 35) },
    derivative: (q, u) => vec3(u.a.mul(q.y.sub(q.x)), u.c.sub(u.a).mul(q.x).sub(q.x.mul(q.z)).add(u.c.mul(q.y)), q.x.mul(q.y).sub(u.b.mul(q.z))),
  },
  {
    id: "rossler", label: "Rössler attractor", dt: 0.012, center: [0, 0, 4], scale: 0.075, zUp: true, speed: 8,
    params: { a: p(0.2, 0.05, 0.4), b: p(0.2, 0.05, 1), c: p(5.7, 3, 12) },
    derivative: (q, u) => vec3(q.y.add(q.z).negate(), q.x.add(u.a.mul(q.y)), u.b.add(q.z.mul(q.x.sub(u.c)))),
  },
];

export function attractorKind(attractor: Attractor, bake: BakeUniforms): Kind {
  const params: Record<string, Param> = {
    ...attractor.params,
    spread: { value: attractor.spread ?? 1, min: 0, max: 10, step: 0.01, label: "start spread" },
    step: { value: 2, min: 1, max: 8, step: 1, label: "steps per sample" },
    settle: { value: attractor.settle ?? 800, min: 0, max: 4000, step: 10, label: "settle steps" },
    width: { value: attractor.width ?? 0.0025, min: 0.0005, max: 0.02, step: 0.0001, label: "thread width" },
  };
  const u = paramUniforms(params);
  const dt = attractor.dt;
  let writer: ReturnType<typeof sampleWriter> | undefined;

  const make = () => sampleWriter((index, out) => {
    const thread = uint(index).div(uint(THREAD));
    const k = uint(index).mod(uint(THREAD));
    const rng = new Rng(thread.bitXor(pcg(bake.seed)));
    const q = vec3(...(attractor.start ?? attractor.center)).add(rng.ball().mul(u.spread)).add(vec3(0.01, 0, 0)).toVar();
    const step = () => {
      const mid = q.add(attractor.derivative(q, u).mul(dt * 0.5));
      q.addAssign(attractor.derivative(mid, u).mul(dt));
    };
    Loop({ start: int(0), end: int(u.settle), type: "int", condition: "<" }, step);
    Loop({ start: int(0), end: int(k).mul(int(u.step)), type: "int", condition: "<" }, step);
    const v = attractor.derivative(q, u).toVar();
    const speed = length(v);
    const c = q.sub(vec3(...attractor.center)).mul(attractor.scale);
    const placed = attractor.zUp ? vec3(c.x, c.z, c.y) : c;
    const tangent = normalize(attractor.zUp ? vec3(v.x, v.z, v.y) : v);
    const gap = speed.mul(dt * attractor.scale).mul(u.step);
    const ok = length(placed).lessThan(4);
    storeSample(out, {
      pos: vec4(placed, 0),
      normal: tangent,
      shape: max(gap.mul(0.7).div(u.width), 1.01),
      trapA: float(1).sub(exp(speed.div(attractor.speed).negate())),
      trapB: rng.next(),
      ao: float(0.8),
      shadow: float(1),
      motion: float(k).div(THREAD),
      lit: float(0.6),
      size: u.width,
      alpha: select(ok, float(1), float(0)),
    });
  });

  return {
    id: attractor.id,
    label: attractor.label,
    family: "threads",
    params,
    uniforms: u,
    writer: () => (writer ??= make()),
    look: { flatness: 1, sway: 0, petals: 0, twinkle: 0, pulseSpeed: 0.12, pulseCount: 4 },
  };
}
