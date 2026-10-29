// Clouds of points, one glowing splat each.
//
// Flames: the chaos game of an iterated function system (Draves' fractal
// flames, in 3D): each sample starts at a random point and applies 32
// randomly chosen maps, each an affine map then a blend of variations
// (linear, sinusoidal, spherical, swirl, bubble, cylinder, polar,
// horseshoe), its color moving toward the map's. Forms: a random flame
// from a seed, the Sierpinski tetrahedron, Menger dust and the octahedron
// flake. The CPU runs the same game first to frame the flame.
//
// Nebula: the Buddhabrot in 4D. Each sample is a point of the orbit of a c
// that escapes the Mandelbrot iteration (or, inverted, one that never
// does), stored as (z, c), four coordinates; the draw turns them in 4D, so
// the cloud morphs live. Half the c are drawn near the main cardioid and
// the period-2 bulb, where orbits are long.
import * as THREE from "three";
import { TSL,              } from "@sparkjsdev/radix";
import { paramUniforms,                              } from "./kind.js";
import { Rng, pcg, sampleWriter, storeSample } from "./sample.js";

const { Break, If, Loop, abs, atan, cos, dot, float, floor, int, length, log, max, min, mix, select, sin, sqrt, uint, uniform, uniformArray, vec2, vec3, vec4 } = TSL;

const MAX_MAPS = 20;
const ROWS = 6;

                    
                             
              
                 
                
                                                                             
                 
 

// A seeded random stream (mulberry32)
function random(seed        ) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const scaleTo = (s        , [x, y, z]          , k = 1 - s) => [s, 0, 0, x * k, 0, s, 0, y * k, 0, 0, s, z * k];
const linear = [1, 0, 0, 0, 0, 0, 0, 0];

function formMaps(form        , seed        )             {
  if (form === 1) {
    const corners = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
    return corners.map((corner, i) => ({ m: scaleTo(0.5, corner), weight: 1, color: i / 3, vars: linear }));
  }
  if (form === 2) {
    const maps             = [];
    for (const x of [-1, 0, 1]) {
      for (const y of [-1, 0, 1]) {
        for (const z of [-1, 0, 1]) {
          const zeros = [x, y, z].filter((c) => c === 0).length;
          if (zeros <= 1) {
            maps.push({ m: scaleTo(1 / 3, [x, y, z], 1), weight: 1, color: zeros === 0 ? 0.15 : 0.8, vars: linear });
          }
        }
      }
    }
    return maps.map((map) => ({ ...map, m: map.m.map((v, i) => (i % 4 === 3 ? (v * 2) / 3 : v)) }));
  }
  if (form === 3) {
    const corners = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    return corners.map((corner, i) => ({ m: scaleTo(0.5, corner), weight: 1, color: i / 5, vars: linear }));
  }
  const rand = random(seed * 7919 + 13);
  const count = 3 + Math.floor(rand() * 3);
  return Array.from({ length: count }, (_, i) => {
    const axis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    const turn = new THREE.Matrix4().makeRotationAxis(axis, (rand() - 0.5) * Math.PI * 1.6);
    const s = 0.35 + rand() * 0.45;
    turn.multiply(new THREE.Matrix4().makeScale(s * (0.8 + rand() * 0.4), s * (0.8 + rand() * 0.4), s * (0.8 + rand() * 0.4)));
    const e = turn.elements;
    const t = [0, 1, 2].map(() => (rand() - 0.5) * 1.6);
    const vars = [0.6 + rand() * 0.4, 0, 0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 2; k += 1) {
      vars[1 + Math.floor(rand() * 7)] += 0.3 + rand() * 0.7;
    }
    const total = vars.reduce((sum, v) => sum + v, 0);
    return {
      m: [e[0], e[4], e[8], t[0], e[1], e[5], e[9], t[1], e[2], e[6], e[10], t[2]],
      weight: 0.5 + rand(),
      color: count > 1 ? i / (count - 1) : 0,
      vars: vars.map((v) => v / total),
    };
  });
}

function vary(q          , v          ) {
  const [x, y, z] = q;
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2) + 1e-6;
  const out = [0, 0, 0];
  const add = (w        , a        , b        , c        ) => {
    out[0] += w * a;
    out[1] += w * b;
    out[2] += w * c;
  };
  add(v[0], x, y, z);
  add(v[1], Math.sin(x), Math.sin(y), Math.sin(z));
  add(v[2], x / (r2 + 1e-6), y / (r2 + 1e-6), z / (r2 + 1e-6));
  add(v[3], x * Math.sin(r2) - z * Math.cos(r2), y, x * Math.cos(r2) + z * Math.sin(r2));
  add(v[4], (x * 4) / (r2 + 4), (y * 4) / (r2 + 4), (z * 4) / (r2 + 4));
  add(v[5], Math.sin(x), y, Math.cos(z));
  add(v[6], Math.atan2(z, x) / Math.PI, y, r - 1);
  add(v[7], ((x - z) * (x + z)) / r, y, (2 * x * z) / r);
  return out;
}

// The center and the radius holding 97% of a chaos game's points
function frame(maps            ) {
  const rand = random(1);
  const total = maps.reduce((sum, map) => sum + map.weight, 0);
  let p = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
  const points             = [];
  for (let i = 0; i < 24000; i += 1) {
    let x = rand() * total;
    const map = maps.find((each) => (x -= each.weight) < 0) ?? maps[maps.length - 1];
    const m = map.m;
    p = vary([m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]], map.vars);
    if (!p.every(Number.isFinite) || Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]) > 1e4) {
      p = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
    } else if (i > 30) {
      points.push(p);
    }
  }
  const center = [0, 1, 2].map((k) => {
    const sorted = points.map((point) => point[k]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  });
  const radii = points.map((point) => Math.hypot(point[0] - center[0], point[1] - center[1], point[2] - center[2])).sort((a, b) => a - b);
  return { center, radius: radii[Math.floor(radii.length * 0.97)] ?? 0 };
}

// Flames whose points spread out (a random seed can collapse to a point
// or a line), with their frame
function flameOf(form        , seed        ) {
  for (let attempt = 0; ; attempt += 1) {
    const maps = formMaps(form, seed + attempt * 1000);
    const framed = frame(maps);
    if (form !== 0 || attempt > 20 || (framed.radius > 0.05 && framed.radius < 50)) {
      return { maps, ...framed };
    }
  }
}

export function flameKind(bake              )       {
  const params = {
    form: { value: 0, min: 0, max: 3, step: 1, label: "form (flame, tetra, menger, octa)" },
    seed: { value: 7, min: 0, max: 999, step: 1 },
    symmetry: { value: 1, min: 1, max: 8, step: 1 },
    colorSpeed: { value: 0.5, min: 0.05, max: 1, step: 0.01, label: "color speed" },
    size: { value: 0.0028, min: 0.0005, max: 0.03, step: 0.0001, label: "point size" },
  };
  const u = paramUniforms(params);
  const maps = uniformArray(Array.from({ length: MAX_MAPS * ROWS }, () => new THREE.Vector4()), "vec4");
  const mapCount = uniform(1, "int");
  const center = uniform(new THREE.Vector3());
  const scale = uniform(1);
  let writer                                             ;

  const make = () => sampleWriter((index, out) => {
    const rng = new Rng(uint(index).bitXor(pcg(bake.seed)));
    const p = rng.ball().toVar();
    const color = rng.next().toVar();
    Loop(32, () => {
      const x = rng.next();
      const k = int(0).toVar();
      Loop({ start: int(0), end: mapCount, type: "int", condition: "<" }, ({ i }                ) => {
        k.addAssign(select(maps.element(i.mul(ROWS).add(3)).x.lessThan(x), int(1), int(0)));
      });
      const base = min(k, mapCount.sub(1)).mul(ROWS).toVar();
      const r0 = maps.element(base);
      const r1 = maps.element(base.add(1));
      const r2 = maps.element(base.add(2));
      const meta = maps.element(base.add(3));
      const va = maps.element(base.add(4)).toVar();
      const vb = maps.element(base.add(5)).toVar();
      const q = vec3(dot(r0.xyz, p).add(r0.w), dot(r1.xyz, p).add(r1.w), dot(r2.xyz, p).add(r2.w)).toVar();
      const rr = dot(q, q).toVar();
      const r = sqrt(rr).add(1e-6);
      const v = q.mul(va.x)
        .add(sin(q).mul(va.y))
        .add(q.div(rr.add(1e-6)).mul(va.z))
        .add(vec3(q.x.mul(sin(rr)).sub(q.z.mul(cos(rr))), q.y, q.x.mul(cos(rr)).add(q.z.mul(sin(rr)))).mul(va.w))
        .add(q.mul(4).div(rr.add(4)).mul(vb.x))
        .add(vec3(sin(q.x), q.y, cos(q.z)).mul(vb.y))
        .add(vec3(atan(q.z, q.x).div(Math.PI), q.y, r.sub(1)).mul(vb.z))
        .add(vec3(q.x.sub(q.z).mul(q.x.add(q.z)).div(r), q.y, q.x.mul(q.z).mul(2).div(r)).mul(vb.w));
      p.assign(v);
      If(abs(p.x).add(abs(p.y)).add(abs(p.z)).greaterThan(1e4), () => {
        p.assign(rng.ball());
      });
      color.assign(mix(color, meta.y, u.colorSpeed));
    });
    // Rotational symmetry about y
    const turn = floor(rng.next().mul(u.symmetry)).mul(Math.PI * 2).div(u.symmetry);
    const c = p.sub(center).toVar();
    const placed = vec3(c.x.mul(cos(turn)).sub(c.z.mul(sin(turn))), c.y, c.x.mul(sin(turn)).add(c.z.mul(cos(turn)))).mul(scale);
    storeSample(out, {
      pos: vec4(placed, 0), normal: vec3(0, 0, 1), shape: float(1), trapA: color, trapB: float(0), ao: float(1), shadow: float(1),
      motion: rng.next(), lit: float(0), size: u.size, alpha: float(1),
    });
  });

  return {
    id: "flame",
    label: "3D flame / chaos game",
    family: "cloud",
    params,
    uniforms: u,
    writer: () => (writer ??= make()),
    prepare: (values) => {
      const flame = flameOf(Math.round(values.form), Math.round(values.seed));
      const total = flame.maps.reduce((sum, map) => sum + map.weight, 0);
      let cumulative = 0;
      const array = maps.array                   ;
      flame.maps.slice(0, MAX_MAPS).forEach((map, i) => {
        cumulative += map.weight / total;
        const m = map.m;
        array[i * ROWS].set(m[0], m[1], m[2], m[3]);
        array[i * ROWS + 1].set(m[4], m[5], m[6], m[7]);
        array[i * ROWS + 2].set(m[8], m[9], m[10], m[11]);
        array[i * ROWS + 3].set(cumulative, map.color, 0, 0);
        array[i * ROWS + 4].set(map.vars[0], map.vars[1], map.vars[2], map.vars[3]);
        array[i * ROWS + 5].set(map.vars[4], map.vars[5], map.vars[6], map.vars[7]);
      });
      mapCount.value = Math.min(flame.maps.length, MAX_MAPS);
      center.value.set(flame.center[0], flame.center[1], flame.center[2]);
      scale.value = 0.9 / Math.max(flame.radius, 1e-3);
    },
    look: { flatness: 1, sway: 0, petals: 0, pulse: 0, glow: 1.4 },
  };
}

export function nebulaKind(bake              )       {
  const params = {
    maxIterations: { value: 200, min: 16, max: 400, step: 1, label: "max iterations" },
    minIterations: { value: 20, min: 1, max: 60, step: 1, label: "min iterations" },
    inverted: { value: 0, min: 0, max: 1, step: 1, label: "anti-Buddhabrot" },
    boundary: { value: 0.6, min: 0, max: 1, step: 0.01, label: "near boundary" },
    size: { value: 0.0022, min: 0.0005, max: 0.02, step: 0.0001, label: "point size" },
  };
  const u = paramUniforms(params);
  let writer                                             ;

  const make = () => sampleWriter((index, out) => {
    const rng = new Rng(uint(index).bitXor(pcg(bake.seed)));
    const maxIter = int(u.maxIterations);
    const inverted = u.inverted.greaterThan(0.5);
    const found = float(0).toVar();
    const c = vec2(0).toVar();
    const escape = int(0).toVar();
    Loop(16, () => {
      If(found.lessThan(0.5), () => {
        const theta = rng.next().mul(Math.PI * 2);
        const jitter = vec2(rng.next().add(rng.next()).sub(1), rng.next().add(rng.next()).sub(1)).mul(0.08);
        const cardioid = vec2(cos(theta).mul(0.5).sub(cos(theta.mul(2)).mul(0.25)), sin(theta).mul(0.5).sub(sin(theta.mul(2)).mul(0.25)));
        const bulb = vec2(cos(theta).mul(0.25).sub(1), sin(theta).mul(0.25));
        const near = select(rng.next().lessThan(0.75), cardioid, bulb).add(jitter);
        const anywhere = vec2(rng.next().mul(3).sub(2), rng.next().mul(3).sub(1.5));
        c.assign(select(rng.next().lessThan(u.boundary), near, anywhere));
        const z = vec2(0).toVar();
        const n = int(0).toVar();
        const escaped = float(0).toVar();
        Loop({ start: int(0), end: maxIter, type: "int", condition: "<" }, () => {
          z.assign(vec2(z.x.mul(z.x).sub(z.y.mul(z.y)), z.x.mul(z.y).mul(2)).add(c));
          n.addAssign(1);
          If(dot(z, z).greaterThan(4), () => {
            escaped.assign(1);
            Break();
          });
        });
        const valid = select(inverted, escaped.lessThan(0.5), escaped.greaterThan(0.5).and(n.greaterThanEqual(int(u.minIterations))));
        If(valid, () => {
          found.assign(1);
          escape.assign(n);
        });
      });
    });
    // A point along the orbit (the anti-Buddhabrot's settled half)
    const first = select(inverted, escape.div(2), int(0));
    const k = first.add(int(floor(rng.next().mul(float(escape.sub(first)))))).toVar();
    const z = vec2(0).toVar();
    Loop({ start: int(0), end: k.add(1), type: "int", condition: "<" }, () => {
      z.assign(vec2(z.x.mul(z.x).sub(z.y.mul(z.y)), z.x.mul(z.y).mul(2)).add(c));
    });
    const heat = log(float(max(escape, 1))).div(log(float(maxIter)));
    storeSample(out, {
      pos: vec4(z.y, z.x.add(0.4).negate(), c.x.add(0.5), c.y).mul(0.62),
      normal: vec3(0, 0, 1), shape: float(1), trapA: select(inverted, float(k).div(float(maxIter)), heat), trapB: float(k).div(float(max(escape, 1))),
      ao: float(1), shadow: float(1), motion: rng.next(), lit: float(0), size: u.size, alpha: select(length(z).lessThan(2.5), found, float(0)),
    });
  });

  return {
    id: "nebula",
    label: "Buddhabrot in 4D",
    family: "cloud",
    params,
    uniforms: u,
    writer: () => (writer ??= make()),
    look: { flatness: 1, sway: 0, petals: 0, pulse: 0, glow: 1.5 },
    fourD: true,
  };
}


//# sourceURL=examples/fractals/clouds.ts