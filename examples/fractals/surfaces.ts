// Distance-estimated fractals (Hvidtfeldt's "Distance Estimated 3D
// Fractals", Fragmentarium, Inigo Quilez): each formula gives vec4(distance,
// trapA, trapB, 0) at a point in its own units. The writer sphere-traces
// one ray per sample, from all around the set or from the camera, and bakes
// the hit: its normal (tetrahedral differences), orbit traps (iq's 3D orbit
// traps), ambient occlusion along the normal and a soft shadow toward the
// light (iq's k h / t penumbra). The surface detail matches the sample
// spacing: rays stop within half a spacing of the set.
import { TSL, type TslNode } from "@sparkjsdev/radix";
import { paramUniforms, type BakeUniforms, type Kind, type Param } from "./kind.js";
import { Rng, pcg, sampleWriter, storeSample } from "./sample.js";

const {
  Break, Fn, If, Loop, abs, acos, atan, clamp, cos, dot, float, fract, int, length, log, max, min, mix, normalize, pow, select, sin, sqrt, uint,
  uniform, vec3, vec4,
} = TSL;

type U = Record<string, TslNode>;

interface Formula {
  id: string;
  label: string;
  params: Record<string, Param>;
  // Bounding radius in the formula's units
  bound: (v: Record<string, number>) => number;
  de: (p: TslNode, u: U) => TslNode;
  // Distance estimates are scaled by this (below 1 where they overshoot)
  fudge?: number;
  // How much of the bound the set fills (default 0.85; 1 for sets cut by
  // a ball)
  fill?: number;
}

const iterations = (value: number, min = 2, max = 24): Param => ({ value, min, max, step: 1 });
const angle = (value = 0): Param => ({ value, min: -Math.PI, max: Math.PI, step: 0.01 });

// Loop over the `iterations` uniform
const iterate = (u: U, body: () => void) => Loop({ start: int(0), end: int(u.iterations), type: "int", condition: "<" }, body);

// Rotations in the xy and yz planes
const turnXY = (z: TslNode, a: TslNode) => {
  const c = cos(a);
  const s = sin(a);
  z.assign(vec3(z.x.mul(c).sub(z.y.mul(s)), z.x.mul(s).add(z.y.mul(c)), z.z));
};
const turnYZ = (z: TslNode, a: TslNode) => {
  const c = cos(a);
  const s = sin(a);
  z.assign(vec3(z.x, z.y.mul(c).sub(z.z.mul(s)), z.y.mul(s).add(z.z.mul(c))));
};

const sdBox = (p: TslNode, b: TslNode) => {
  const q = abs(p).sub(b);
  return length(max(q, vec3(0))).add(min(max(q.x, max(q.y, q.z)), 0));
};

const trapOf = (z: TslNode) => vec4(abs(z), dot(z, z));

export const FORMULAS: Formula[] = [
  {
    id: "mandelbulb",
    label: "Mandelbulb",
    params: {
      power: { value: 8, min: 2, max: 16, step: 0.01 },
      iterations: iterations(8, 2, 16),
      twist: { value: 0, min: -3.2, max: 3.2, step: 0.01, label: "phase twist" },
      julia: { value: 0, min: 0, max: 1, step: 0.01, label: "julia mix" },
      cx: { value: 0.35, min: -1.5, max: 1.5, step: 0.01, label: "julia x" },
      cy: { value: -0.6, min: -1.5, max: 1.5, step: 0.01, label: "julia y" },
      cz: { value: 0.25, min: -1.5, max: 1.5, step: 0.01, label: "julia z" },
    },
    bound: () => 1.3,
    fudge: 0.9,
    de: (p, u) => {
      const z = p.toVar();
      const dr = float(1).toVar();
      const r = length(z).toVar();
      const trap = trapOf(z).toVar();
      const c = mix(p, vec3(u.cx, u.cy, u.cz), u.julia).toVar();
      iterate(u, () => {
        r.assign(length(z));
        If(r.greaterThan(2), () => {
          Break();
        });
        const theta = acos(clamp(z.y.div(max(r, 1e-6)), -1, 1)).mul(u.power).toVar();
        const phi = atan(z.z, z.x).mul(u.power).add(u.twist).toVar();
        dr.assign(pow(r, u.power.sub(1)).mul(u.power).mul(dr).add(float(1).sub(u.julia)));
        z.assign(vec3(sin(theta).mul(cos(phi)), cos(theta), sin(theta).mul(sin(phi))).mul(pow(r, u.power)).add(c));
        trap.assign(min(trap, trapOf(z)));
      });
      r.assign(length(z));
      const d = log(max(r, 1e-6)).mul(r).mul(0.5).div(dr);
      return vec4(d, clamp(sqrt(trap.w).mul(1.1), 0, 1), clamp(trap.y.mul(3), 0, 1), 0);
    },
  },
  {
    id: "mandelbox",
    label: "Mandelbox",
    params: {
      scale: { value: -1.5, min: -3, max: 3, step: 0.01 },
      minRadius: { value: 0.5, min: 0.05, max: 1, step: 0.01, label: "min radius" },
      fixedRadius: { value: 1, min: 0.5, max: 2, step: 0.01, label: "fixed radius" },
      fold: { value: 1, min: 0.5, max: 2, step: 0.01, label: "fold limit" },
      iterations: iterations(12, 4, 24),
    },
    // A cube of side 4 (s + 1) / (s - 1) for s > 1, about 4 for s < -1
    bound: (v) => (v.scale > 1 ? (2 * (v.scale + 1)) / (v.scale - 1) : 2.1) * 1.5,
    de: (p, u) => {
      const z = p.toVar();
      const dr = float(1).toVar();
      const trap = trapOf(z).toVar();
      const minR2 = u.minRadius.mul(u.minRadius);
      const fixedR2 = u.fixedRadius.mul(u.fixedRadius);
      iterate(u, () => {
        z.assign(clamp(z, u.fold.negate(), u.fold).mul(2).sub(z));
        const r2 = dot(z, z).toVar();
        const k = select(r2.lessThan(minR2), fixedR2.div(minR2), select(r2.lessThan(fixedR2), fixedR2.div(r2), float(1))).toVar();
        z.mulAssign(k);
        dr.mulAssign(k);
        z.assign(z.mul(u.scale).add(p));
        dr.assign(dr.mul(abs(u.scale)).add(1));
        trap.assign(min(trap, trapOf(z)));
      });
      return vec4(length(z).div(abs(dr)), clamp(sqrt(trap.w).mul(0.45), 0, 1), clamp(trap.x.mul(0.8), 0, 1), 0);
    },
  },
  {
    id: "menger",
    label: "Menger sponge (KIFS)",
    params: {
      scale: { value: 3, min: 1.5, max: 4, step: 0.01 },
      cx: { value: 1, min: 0, max: 2, step: 0.01, label: "offset x" },
      cy: { value: 1, min: 0, max: 2, step: 0.01, label: "offset y" },
      cz: { value: 1, min: 0, max: 2, step: 0.01, label: "offset z" },
      angleA: angle(0),
      angleB: angle(0),
      iterations: iterations(6, 2, 10),
    },
    bound: () => 1.8,
    de: (p, u) => {
      const z = p.toVar();
      const trap = trapOf(z).toVar();
      const s1 = u.scale.sub(1);
      iterate(u, () => {
        z.assign(abs(z));
        If(z.x.lessThan(z.y), () => {
          z.assign(z.yxz);
        });
        If(z.x.lessThan(z.z), () => {
          z.assign(z.zyx);
        });
        If(z.y.lessThan(z.z), () => {
          z.assign(z.xzy);
        });
        turnXY(z, u.angleA);
        z.assign(vec3(z.x.mul(u.scale).sub(u.cx.mul(s1)), z.y.mul(u.scale).sub(u.cy.mul(s1)), z.z.mul(u.scale)));
        If(z.z.greaterThan(u.cz.mul(s1).mul(0.5)), () => {
          z.z.subAssign(u.cz.mul(s1));
        });
        turnYZ(z, u.angleB);
        trap.assign(min(trap, trapOf(z)));
      });
      const d = sdBox(z, vec3(1)).mul(pow(u.scale, float(u.iterations).negate()));
      return vec4(d, clamp(sqrt(trap.w).mul(0.5), 0, 1), clamp(trap.z.mul(1.5), 0, 1), 0);
    },
  },
  {
    id: "sierpinski",
    label: "Sierpinski tetrahedron (KIFS)",
    params: {
      scale: { value: 2, min: 1.4, max: 3, step: 0.01 },
      offset: { value: 1, min: 0.3, max: 1.6, step: 0.01 },
      angleA: angle(0),
      angleB: angle(0),
      iterations: iterations(14, 4, 20),
    },
    bound: () => 1.9,
    de: (p, u) => {
      const z = p.toVar();
      const trap = trapOf(z).toVar();
      iterate(u, () => {
        If(z.x.add(z.y).lessThan(0), () => {
          z.assign(vec3(z.y.negate(), z.x.negate(), z.z));
        });
        If(z.x.add(z.z).lessThan(0), () => {
          z.assign(vec3(z.z.negate(), z.y, z.x.negate()));
        });
        If(z.y.add(z.z).lessThan(0), () => {
          z.assign(vec3(z.x, z.z.negate(), z.y.negate()));
        });
        turnXY(z, u.angleA);
        z.assign(z.mul(u.scale).sub(vec3(u.offset).mul(u.scale.sub(1))));
        turnYZ(z, u.angleB);
        trap.assign(min(trap, trapOf(z)));
      });
      const d = length(z).mul(pow(u.scale, float(u.iterations).negate()));
      return vec4(d, clamp(sqrt(trap.w).mul(0.5), 0, 1), clamp(trap.x.mul(1.2), 0, 1), 0);
    },
  },
  {
    id: "octahedral",
    label: "Octahedral crystal (KIFS)",
    params: {
      scale: { value: 2, min: 1.3, max: 3, step: 0.01 },
      ox: { value: 1, min: 0, max: 2, step: 0.01, label: "offset x" },
      oy: { value: 0.35, min: 0, max: 2, step: 0.01, label: "offset y" },
      oz: { value: 0.12, min: 0, max: 2, step: 0.01, label: "offset z" },
      angleA: angle(0.2),
      angleB: angle(0.35),
      iterations: iterations(14, 4, 20),
    },
    bound: () => 1.6,
    de: (p, u) => {
      const z = p.toVar();
      const trap = trapOf(z).toVar();
      iterate(u, () => {
        z.assign(abs(z));
        If(z.x.lessThan(z.y), () => {
          z.assign(z.yxz);
        });
        If(z.x.lessThan(z.z), () => {
          z.assign(z.zyx);
        });
        If(z.y.lessThan(z.z), () => {
          z.assign(z.xzy);
        });
        turnXY(z, u.angleA);
        z.assign(z.mul(u.scale).sub(vec3(u.ox, u.oy, u.oz).mul(u.scale.sub(1))));
        turnYZ(z, u.angleB);
        trap.assign(min(trap, trapOf(z)));
      });
      const d = length(z).mul(pow(u.scale, float(u.iterations).negate()));
      return vec4(d, clamp(sqrt(trap.w).mul(0.5), 0, 1), clamp(trap.y.mul(1.5), 0, 1), 0);
    },
  },
  {
    id: "quaternion",
    label: "Quaternion Julia",
    params: {
      cx: { value: -0.291, min: -1.2, max: 1.2, step: 0.001, label: "c.x" },
      cy: { value: -0.399, min: -1.2, max: 1.2, step: 0.001, label: "c.y" },
      cz: { value: 0.339, min: -1.2, max: 1.2, step: 0.001, label: "c.z" },
      cw: { value: 0.437, min: -1.2, max: 1.2, step: 0.001, label: "c.w" },
      slice: { value: 0, min: -1, max: 1, step: 0.01, label: "4D slice" },
      iterations: iterations(12, 4, 20),
    },
    bound: () => 1.6,
    de: (p, u) => {
      const z = vec4(p, u.slice).toVar();
      const md2 = float(1).toVar();
      const mz2 = dot(z, z).toVar();
      const trap = vec4(abs(z.xyz), mz2).toVar();
      const c = vec4(u.cx, u.cy, u.cz, u.cw);
      iterate(u, () => {
        md2.mulAssign(mz2.mul(4));
        z.assign(vec4(z.x.mul(z.x).sub(dot(z.yzw, z.yzw)), z.yzw.mul(z.x.mul(2))).add(c));
        mz2.assign(dot(z, z));
        trap.assign(min(trap, vec4(abs(z.xyz), mz2)));
        If(mz2.greaterThan(16), () => {
          Break();
        });
      });
      const d = sqrt(mz2.div(md2)).mul(log(max(mz2, 1e-6))).mul(0.25);
      return vec4(d, clamp(sqrt(trap.w).mul(1.2), 0, 1), clamp(trap.x.mul(2.5), 0, 1), 0);
    },
  },
  {
    id: "apollonian",
    label: "Apollonian packing",
    params: {
      s: { value: 1.25, min: 0.9, max: 1.7, step: 0.005, label: "inversion" },
      iterations: iterations(8, 3, 12),
      cut: { value: 2.2, min: 0.8, max: 4, step: 0.01, label: "ball radius" },
    },
    bound: (v) => v.cut,
    fill: 1,
    de: (p, u) => {
      const z = p.toVar();
      const scale = float(1).toVar();
      const trap = vec4(1000).toVar();
      iterate(u, () => {
        z.assign(fract(z.mul(0.5).add(0.5)).mul(2).sub(1));
        const r2 = dot(z, z).toVar();
        trap.assign(min(trap, trapOf(z)));
        const k = u.s.div(max(r2, 1e-6)).toVar();
        z.mulAssign(k);
        scale.mulAssign(k);
      });
      const d = max(abs(z.y).mul(0.25).div(scale), length(p).sub(u.cut));
      return vec4(d, clamp(trap.w.mul(1.2), 0, 1), clamp(trap.y.mul(2.5), 0, 1), 0);
    },
  },
  {
    id: "kleinian",
    label: "Pseudo-Kleinian",
    params: {
      sizeX: { value: 0.92436, min: 0.3, max: 1.5, step: 0.001, label: "box x" },
      sizeY: { value: 0.90756, min: 0.3, max: 1.5, step: 0.001, label: "box y" },
      sizeZ: { value: 0.92436, min: 0.3, max: 1.5, step: 0.001, label: "box z" },
      size: { value: 1, min: 0.5, max: 1.6, step: 0.001, label: "inversion" },
      iterations: iterations(10, 3, 16),
      cut: { value: 2.6, min: 1, max: 5, step: 0.01, label: "ball radius" },
    },
    bound: (v) => v.cut,
    fill: 1,
    de: (p, u) => {
      const z = p.toVar();
      const factor = float(1).toVar();
      const trap = vec4(1000).toVar();
      const box = vec3(u.sizeX, u.sizeY, u.sizeZ);
      iterate(u, () => {
        z.assign(clamp(z, box.negate(), box).mul(2).sub(z));
        const r2 = dot(z, z).toVar();
        const k = max(u.size.div(max(r2, 1e-6)), 1).toVar();
        z.mulAssign(k);
        factor.mulAssign(k);
        trap.assign(min(trap, trapOf(z)));
      });
      const rxy = length(z.xy);
      const d = max(rxy.sub(0.92784), abs(rxy.mul(z.z)).div(max(length(z), 1e-6))).div(factor);
      return vec4(max(d, length(p).sub(u.cut)), clamp(sqrt(trap.w).mul(0.8), 0, 1), clamp(trap.z.mul(3), 0, 1), 0);
    },
  },
];

// A surface kind: the formula's parameters plus its display scale (the set
// in a ball of about 1.1) and the writer
export function surfaceKind(formula: Formula, bake: BakeUniforms): Kind {
  const u = paramUniforms(formula.params);
  const bound = uniform(1);
  const scale = uniform(1);
  const fudge = formula.fudge ?? 1;
  let writer: ReturnType<typeof sampleWriter> | undefined;

  const make = () => {
    const de = Fn(([p]: [TslNode]) => formula.de(p, u)).setLayout({ name: `de_${formula.id}`, type: "vec4", inputs: [{ name: "p", type: "vec3" }] });
    const distance = (p: TslNode) => de(p).x.mul(fudge);
    return sampleWriter((index, out) => {
      const rng = new Rng(uint(index).bitXor(pcg(bake.seed)));
      const R = bound;
      const fromCamera = bake.fromCamera.greaterThan(0.5);
      // Orbit rays: spacing over a surface of about 6 pi R^2; camera rays:
      // the angle between neighbors
      const orbitSpacing = R.mul(sqrt(float(6 * Math.PI).div(bake.count)));
      const angle = sqrt(bake.tanX.mul(bake.tanY).mul(5.3).div(bake.count));
      const hit = float(0).toVar();
      const o = vec3(0).toVar();
      const dir = vec3(0, 0, 1).toVar();
      const t = float(0).toVar();
      const spacing = float(0).toVar();

      Loop(3, () => {
        If(hit.lessThan(0.5), () => {
          If(fromCamera, () => {
            const sx = rng.next().mul(2.3).sub(1.15);
            const sy = rng.next().mul(2.3).sub(1.15);
            o.assign(bake.eye.div(scale));
            dir.assign(normalize(bake.forward.add(bake.right.mul(sx.mul(bake.tanX))).add(bake.up.mul(sy.mul(bake.tanY)))));
          }).Else(() => {
            o.assign(rng.direction().mul(R.mul(1.02)));
            dir.assign(normalize(rng.ball().mul(R.mul(0.85)).sub(o)));
          });
          // Clip to the bounding ball
          const b = dot(o, dir).toVar();
          const h = b.mul(b).sub(dot(o, o)).add(R.mul(R)).toVar();
          If(h.greaterThan(0), () => {
            const far = b.negate().add(sqrt(h)).toVar();
            t.assign(max(b.negate().sub(sqrt(h)), 0));
            Loop({ start: int(0), end: int(bake.maxSteps), type: "int", condition: "<" }, () => {
              spacing.assign(select(fromCamera, t.mul(angle), orbitSpacing));
              const d = distance(o.add(dir.mul(t)));
              If(d.lessThan(spacing.mul(0.5)), () => {
                hit.assign(1);
                Break();
              });
              t.addAssign(max(d, spacing.mul(0.05)));
              If(t.greaterThan(far), () => {
                Break();
              });
            });
          });
        });
      });

      const eps = spacing.mul(0.5).toVar();
      const p = o.add(dir.mul(t)).toVar();
      // Tetrahedral differences
      const k0 = vec3(1, -1, -1);
      const k1 = vec3(-1, -1, 1);
      const k2 = vec3(-1, 1, -1);
      const k3 = vec3(1, 1, 1);
      const n = normalize(k0.mul(distance(p.add(k0.mul(eps)))).add(k1.mul(distance(p.add(k1.mul(eps)))))
        .add(k2.mul(distance(p.add(k2.mul(eps))))).add(k3.mul(distance(p.add(k3.mul(eps))))).add(vec3(0, 1e-9, 0))).toVar();
      const trap = de(p).toVar();

      // Occlusion: how far the set stays from the normal, out to 7% of R
      const occ = float(0).toVar();
      const weight = float(1).toVar();
      Loop(5, ({ i }: { i: TslNode }) => {
        const h = R.mul(0.07).mul(float(i).add(1).div(5)).add(eps);
        occ.addAssign(h.sub(distance(p.add(n.mul(h)))).mul(weight).div(h));
        weight.mulAssign(0.6);
      });
      const ao = clamp(float(1).sub(occ.mul(0.45)), 0, 1);

      // Soft shadow toward the light
      const shade = float(1).toVar();
      const s = eps.mul(3).add(R.mul(0.004)).toVar();
      Loop(56, () => {
        const h = distance(p.add(n.mul(eps.mul(2))).add(bake.lightDir.mul(s)));
        shade.assign(min(shade, h.mul(9).div(s)));
        s.addAssign(clamp(h, R.mul(0.003), R.mul(0.12)));
        If(shade.lessThan(0.002).or(s.greaterThan(R.mul(2.4))), () => {
          Break();
        });
      });

      storeSample(out, {
        pos: vec4(p.mul(scale), 0),
        normal: n,
        shape: float(0.22),
        trapA: trap.y,
        trapB: trap.z,
        ao,
        shadow: clamp(shade, 0, 1).mul(clamp(shade, 0, 1)).mul(float(3).sub(clamp(shade, 0, 1).mul(2))),
        motion: rng.next(),
        lit: float(1),
        size: spacing.mul(scale).mul(0.62).mul(bake.coverage),
        alpha: hit,
      });
    });
  };

  return {
    id: formula.id,
    label: formula.label,
    family: "surface",
    params: formula.params,
    uniforms: u,
    writer: () => (writer ??= make()),
    prepare: (values) => {
      bound.value = formula.bound(values);
      scale.value = 1.1 / (bound.value * (formula.fill ?? 0.85));
    },
    look: { flatness: 1, sway: 0, petals: 0, pulse: 0, twinkle: 0 },
  };
}
