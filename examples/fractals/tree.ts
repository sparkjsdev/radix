// A fractal tree with blossoms. Each sample walks from the root down a
// random path of branches (every branch splits into `branches` children,
// turned by the spread about an axis that twists from level to level, the
// first child leading when there are three or more), so the tree is never
// stored: a branch's jitter comes from a hash of its path, the same for
// every sample on it. Wood samples pick their depth from a table weighting
// each level by its branches' length over their width (thin twigs need as
// many splats as thick ones of the same length); blossoms walk to a tip.
// The draw sways each sample by its flex and lets some petals fall.
import { TSL, type TslNode } from "@sparkjsdev/radix";
import { paramUniforms, type BakeUniforms, type Kind } from "./kind.js";
import { Rng, pcg, sampleWriter, storeSample } from "./sample.js";

const { Loop, clamp, cos, cross, dot, float, floor, int, max, min, mix, normalize, select, sin, uint, uniformArray, vec3, vec4 } = TSL;

const MAX_DEPTH = 13;
const TRUNK = { base: -1.1, length: 0.5, radius: 0.05 };

// v turned about the unit axis k by angle a (Rodrigues)
const rotate = (v: TslNode, k: TslNode, a: TslNode) => v.mul(cos(a)).add(cross(k, v).mul(sin(a))).add(k.mul(dot(k, v).mul(float(1).sub(cos(a)))));

export function treeKind(bake: BakeUniforms): Kind {
  const params = {
    depth: { value: 10, min: 4, max: MAX_DEPTH - 1, step: 1 },
    branches: { value: 3, min: 2, max: 4, step: 1 },
    spread: { value: 0.62, min: 0.1, max: 1.4, step: 0.01 },
    lengthRatio: { value: 0.72, min: 0.5, max: 0.9, step: 0.01, label: "length ratio" },
    widthRatio: { value: 0.64, min: 0.4, max: 0.85, step: 0.01, label: "width ratio" },
    twist: { value: 2.4, min: 0, max: 3.14, step: 0.01 },
    droop: { value: 0.12, min: -0.6, max: 0.8, step: 0.01 },
    jitter: { value: 0.45, min: 0, max: 1.5, step: 0.01 },
    blossoms: { value: 0.2, min: 0, max: 0.8, step: 0.01 },
    blossomSize: { value: 0.0075, min: 0.003, max: 0.05, step: 0.001, label: "blossom size" },
    seed: { value: 1, min: 0, max: 999, step: 1 },
  };
  const u = paramUniforms(params);
  const depthTable = uniformArray(new Array(MAX_DEPTH).fill(1), "float");
  let writer: ReturnType<typeof sampleWriter> | undefined;

  const make = () => sampleWriter((index, out) => {
    const rng = new Rng(uint(index).bitXor(pcg(bake.seed)));
    const depth = int(u.depth);
    const blossom = rng.next().lessThan(u.blossoms);
    const x = rng.next();
    const level = int(0).toVar();
    Loop({ start: int(0), end: depth, type: "int", condition: "<" }, ({ i }: { i: TslNode }) => {
      level.addAssign(select(depthTable.element(i).lessThan(x), int(1), int(0)));
    });
    const d = select(blossom, depth, min(level, depth)).toVar();

    const pos = vec3(0, TRUNK.base, 0).toVar();
    const dir = vec3(0, 1, 0).toVar();
    const side = vec3(1, 0, 0).toVar();
    const len = float(TRUNK.length).toVar();
    const rad = float(TRUNK.radius).toVar();
    const path = pcg(uint(u.seed).add(uint(17))).toVar();
    const branches = float(u.branches);
    Loop({ start: int(0), end: d, type: "int", condition: "<" }, ({ i }: { i: TslNode }) => {
      pos.addAssign(dir.mul(len));
      const child = floor(rng.next().mul(branches));
      path.assign(pcg(path.bitXor(uint(child).add(1).mul(uint(2654435761))).add(uint(i))));
      const j1 = float(path.shiftRight(uint(8))).mul(1 / 16777216).sub(0.5).toVar();
      const j2 = float(pcg(path).shiftRight(uint(8))).mul(1 / 16777216).sub(0.5).toVar();
      const azimuth = child.mul(Math.PI * 2).div(branches).add(float(i).mul(u.twist)).add(j1.mul(u.jitter).mul(1.5));
      const axis = normalize(rotate(side, dir, azimuth)).toVar();
      const leads = child.lessThan(0.5).and(branches.greaterThan(2.5));
      const tilt = u.spread.mul(select(leads, float(0.22), float(1))).mul(j2.mul(u.jitter).add(1));
      const turned = normalize(rotate(dir, axis, tilt).add(vec3(0, u.droop.negate().mul(float(i).add(1)).div(float(depth)), 0))).toVar();
      side.assign(normalize(cross(turned, axis)));
      dir.assign(turned);
      len.mulAssign(u.lengthRatio.mul(j1.mul(u.jitter).mul(0.4).add(1)));
      rad.mulAssign(u.widthRatio);
    });

    const t = rng.next();
    const flex = float(d).add(t).div(float(depth)).toVar();
    const wood = {
      pos: pos.add(dir.mul(len.mul(t))),
      size: max(rad.mul(float(1).sub(t.mul(0.35))), 0.0018),
    };
    const size = select(blossom, u.blossomSize.mul(rng.next().mul(0.7).add(0.5)), wood.size).toVar();
    const tip = pos.add(dir.mul(len)).add(rng.ball().mul(u.blossomSize.mul(3)));
    const falls = rng.next().lessThan(0.03);
    const motion = select(blossom, select(falls, rng.next().add(0.01).negate(), float(1)), flex);
    const shade = mix(float(0.55), float(1), clamp(flex, 0, 1));

    storeSample(out, {
      pos: vec4(select(blossom, tip, wood.pos), 0),
      normal: select(blossom, rng.direction(), dir),
      shape: select(blossom, float(0.35), clamp(len.mul(0.2).div(size), 1.01, 7)),
      trapA: select(blossom, rng.next().mul(0.25).add(0.75), float(d).div(float(depth)).mul(0.14).add(0.06)),
      trapB: select(blossom, rng.next(), float(0)),
      ao: select(blossom, float(1), shade),
      shadow: float(1),
      motion,
      lit: select(blossom, float(0.8), float(1)),
      size,
      alpha: float(1),
    });
  });

  return {
    id: "tree",
    label: "Fractal tree",
    family: "tree",
    params,
    uniforms: u,
    writer: () => (writer ??= make()),
    prepare: (values) => {
      const depth = Math.round(values.depth);
      const weights = Array.from({ length: depth + 1 }, (_, level) => {
        const length = TRUNK.length * values.lengthRatio ** level;
        const radius = Math.max(TRUNK.radius * values.widthRatio ** level, 0.0018);
        return Math.round(values.branches) ** level * (length / radius);
      });
      const total = weights.reduce((sum, w) => sum + w, 0);
      let cumulative = 0;
      const table = depthTable.array as number[];
      table.fill(1);
      weights.forEach((w, level) => {
        cumulative += w / total;
        table[level] = cumulative;
      });
    },
    look: { flatness: 1, pulse: 0, twinkle: 0 },
  };
}
