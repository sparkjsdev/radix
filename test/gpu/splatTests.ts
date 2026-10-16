// Checks of the library's splat readers, TSL codecs (encoders through the
// fragment writer and, on WebGPU, the compute one), GpuArrayWriter, swap,
// createRenderer options and the worker pool, on the current backend
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  ArrayData, GpuArrayReader, GpuArrays, GpuArrayWriter, GpuCovSplatReader, GpuExtSplatReader, GpuPackedSplatReader, GpuProfiler, GpuSplatReader,
  GpuSplats, SortKeys, Splats, TSL, WgpuArrayWriter, WorkerPool, createRenderer, defineBundle, getGpuCaps, loadSplats, writeSplats,
  type ArrayBundle, type BundleDef, type CovSplat, type ExtSplat, type Quat, type Schema, type Splat, type TslNode, type Vec3,
  type WorkerChoice, type WriterOutputs,
} from "@sparkjsdev/radix";
import { decodeAngle12, decodeCenter, decodeDepth20, encodeAngle12, encodeCenter, encodeDepth20 } from "../../src/render/projection.tsl";

const { exp2, float, mix, select, uint, uintBitsToFloat, uvec4, vec4 } = TSL;

// A bundle read back from the GPU, checked to be of the layout
function asLayout<B extends ArrayBundle>(bundle: ArrayBundle, guard: (bundle: ArrayBundle) => bundle is B): B {
  if (!guard(bundle)) {
    throw new Error("Read back the wrong layout");
  }
  return bundle;
}

type Check = (name: string, fn: () => Promise<string | undefined | "skip">) => Promise<void>;

// Deterministic random numbers (mulberry32)
let seed = 777;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randomUnit(): Vec3 {
  for (;;) {
    const v = { x: random() * 2 - 1, y: random() * 2 - 1, z: random() * 2 - 1 };
    const length = Math.hypot(v.x, v.y, v.z);
    if (length > 0.1 && length <= 1) {
      return { x: v.x / length, y: v.y / length, z: v.z / length };
    }
  }
}

function randomSplat(): ExtSplat {
  const axis = randomUnit();
  const angle = random() * Math.PI * 2;
  return {
    center: { x: (random() - 0.5) * 20, y: (random() - 0.5) * 20, z: (random() - 0.5) * 20 },
    scales: { x: Math.exp(random() * 8 - 6), y: Math.exp(random() * 8 - 6), z: Math.exp(random() * 8 - 6) },
    quaternion: { x: axis.x * Math.sin(angle / 2), y: axis.y * Math.sin(angle / 2), z: axis.z * Math.sin(angle / 2), w: Math.cos(angle / 2) },
    rgb: { r: random(), g: random(), b: random() },
    opacity: random(),
    normal: randomUnit(),
    roughness: random(),
    metallic: random(),
  };
}

const N = 3000;
const degrees = (radians: number) => (radians * 180) / Math.PI;
// Rotation between two quaternions (q and -q alike) as 4 asin(|a - b| / 2):
// acos of their dot product turns f32 rounding into hundredths of a degree
function quatAngle(a: Quat, b: Quat) {
  const la = Math.hypot(a.x, a.y, a.z, a.w);
  const lb = Math.hypot(b.x, b.y, b.z, b.w);
  const distance = (sign: number) => Math.hypot(a.x / la - (sign * b.x) / lb, a.y / la - (sign * b.y) / lb, a.z / la - (sign * b.z) / lb, a.w / la - (sign * b.w) / lb);
  return degrees(4 * Math.asin(Math.min(1, Math.min(distance(1), distance(-1)) / 2)));
}
// Angle between two directions as 2 asin(|a - b| / 2), for the same reason
function vecAngle(a: Vec3, b: Vec3) {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  return degrees(2 * Math.asin(Math.min(1, Math.hypot(a.x / la - b.x / lb, a.y / la - b.y / lb, a.z / la - b.z / lb) / 2)));
}
const lnError = (a: number, b: number) => Math.abs(Math.log(a) - Math.log(b));
// Two half-float steps of ln(v): one code off the CPU's, plus its rounding
const lnHalfSteps = (v: number) => Math.abs(Math.log(v)) * 2 ** -9 + 2 ** -23;
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

// Four float32x4 channels: one writer pass (64 bytes per texel)
const FLOATS = defineBundle({ a: "float32x4", b: "float32x4", c: "float32x4", d: "float32x4" });

// Run `write` over `count` elements into FLOATS outputs and read them back
async function writeFloats(renderer: WebGPURenderer, count: number, write: (index: TslNode) => TslNode[]) {
  const out = new GpuArrays({ renderer, bundles: { out: FLOATS }, capacity: count });
  const writer = new GpuArrayWriter({
    outputs: { out: FLOATS },
    write: (index, o) => {
      const values = write(index);
      (["a", "b", "c", "d"] as const).forEach((label, i) => {
        if (values[i]) {
          o.out[label].assign(values[i]);
        }
      });
    },
  });
  try {
    out.write(writer, { count });
    const data = await out.read();
    const c = data.bundles.out.channels;
    const at = (label: string, i: number) => Array.from((c[label].data as Float32Array).subarray(i * 4, i * 4 + 4));
    return { a: (i: number) => at("a", i), b: (i: number) => at("b", i), c: (i: number) => at("c", i), d: (i: number) => at("d", i) };
  } finally {
    writer.dispose();
    out.dispose();
  }
}

// Splat outputs: center + opacity, scales, quaternion, rgb
const splatOutputs = (s: TslNode) => [vec4(s.get("center"), s.get("opacity")), vec4(s.get("scales"), 0), s.get("quaternion"), vec4(s.get("rgb"), 0)];

type Floats = Awaited<ReturnType<typeof writeFloats>>;

function splatOf(f: Floats, i: number): Splat {
  const [a, b, c, d] = [f.a(i), f.b(i), f.c(i), f.d(i)];
  return { center: { x: a[0], y: a[1], z: a[2] }, opacity: a[3], scales: { x: b[0], y: b[1], z: b[2] }, quaternion: { x: c[0], y: c[1], z: c[2], w: c[3] }, rgb: { r: d[0], g: d[1], b: d[2] } };
}

// GPU decode against CPU decode: f32 math against f64
function compareSplat(gpu: Splat, cpu: Splat, rotationDegrees = 0.01) {
  const centerTolerance = 1e-6 * (1 + Math.abs(cpu.center.x) + Math.abs(cpu.center.y) + Math.abs(cpu.center.z));
  if (!near(gpu.center.x, cpu.center.x, centerTolerance) || !near(gpu.center.z, cpu.center.z, centerTolerance) || !near(gpu.opacity, cpu.opacity, 1e-6)) {
    return `center / opacity ${JSON.stringify(gpu.center)} ${gpu.opacity} vs ${JSON.stringify(cpu.center)} ${cpu.opacity}`;
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (cpu.scales[axis] > 0 && lnError(gpu.scales[axis], cpu.scales[axis]) > 1e-4) {
      return `scale ${gpu.scales[axis]} vs ${cpu.scales[axis]}`;
    }
  }
  const rgbTolerance = 1e-5 * (1 + Math.abs(cpu.rgb.r) + Math.abs(cpu.rgb.g) + Math.abs(cpu.rgb.b));
  if (!near(gpu.rgb.r, cpu.rgb.r, rgbTolerance) || !near(gpu.rgb.b, cpu.rgb.b, rgbTolerance)) {
    return `rgb ${JSON.stringify(gpu.rgb)} vs ${JSON.stringify(cpu.rgb)}`;
  }
  if (quatAngle(gpu.quaternion, cpu.quaternion) > rotationDegrees) {
    return `rotation ${quatAngle(gpu.quaternion, cpu.quaternion)} degrees`;
  }
  return undefined;
}

// Splats of every layout from the same inputs, on the CPU and the GPU
function layoutData(renderer: WebGPURenderer, inputs: ExtSplat[]) {
  const data = new ArrayData({ bundles: { extSplats: Splats.EXT, covSplats: Splats.COV, packedSplats: Splats.PACKED }, count: inputs.length });
  inputs.forEach((s, i) => {
    Splats.encodeExt(data.bundles.extSplats, i, s);
    Splats.encodeCov(data.bundles.covSplats, i, { ...Splats.toCov(s, Splats.makeCovSplat()), normal: s.normal });
    Splats.encodePacked(data.bundles.packedSplats, i, s);
  });
  return { data, gpu: GpuArrays.fromData(renderer, data) };
}

// Covariance of a splat, to compare diagonalizations (whose axes are
// ambiguous where scales are close)
function covOf(s: Splat) {
  const c = Splats.toCov(s, Splats.makeCovSplat()).cov;
  return [c.xx, c.yy, c.zz, c.xy, c.xz, c.yz];
}

type WriterKind = "fragment" | "compute";
const kindLabel = (kind: WriterKind) => (kind === "compute" ? ", compute" : "");

function makeWriter<O extends Schema>(kind: WriterKind, options: { outputs: O; write: (index: TslNode, out: WriterOutputs<O>) => void }) {
  return kind === "compute" ? new WgpuArrayWriter(options) : new GpuArrayWriter(options);
}

// Run either writer kind over the first `count` elements; compute writers
// need arrays made with storage: true
function writeAll(arrays: GpuArrays, writer: GpuArrayWriter | WgpuArrayWriter, count: number) {
  if (writer instanceof GpuArrayWriter) {
    arrays.write(writer, { count });
  } else if (arrays.hasStorage()) {
    arrays.write(writer, { count });
  } else {
    throw new Error("A compute writer needs storage arrays");
  }
}

export async function runSplatTests(renderer: WebGPURenderer, check: Check) {
  const backend = getGpuCaps(renderer).backend;
  // Encoders through the fragment writer, and on WebGPU the compute one
  const writerKinds: WriterKind[] = backend === "webgpu" ? ["fragment", "compute"] : ["fragment"];
  const inputs = Array.from({ length: N }, randomSplat);

  // --- Readers: TSL decode against the CPU's ---
  await check("GpuExtSplatReader loadSplat / loadPbr / loadCenter / loadRgb / loadOpacity", async () => {
    const { data, gpu } = layoutData(renderer, inputs);
    try {
      const reader = new GpuExtSplatReader().bind(gpu);
      const splats = await writeFloats(renderer, N, (index) => splatOutputs(reader.loadSplat(index).toVar()));
      const pbr = await writeFloats(renderer, N, (index) => {
        const p = reader.loadPbr(index).toVar();
        return [vec4(p.get("normal"), p.get("roughness")), vec4(p.get("metallic"), reader.loadOpacity(index), 0, 0), vec4(reader.loadCenter(index), 0), vec4(reader.loadRgb(index), 0)];
      });
      const cpu = Splats.makeExtSplat();
      for (let i = 0; i < N; i += 1) {
        Splats.decodeExt(data.bundles.extSplats, i, cpu);
        const mismatch = compareSplat(splatOf(splats, i), cpu);
        if (mismatch) {
          return `splat ${i}: ${mismatch}`;
        }
        const [n, m, center, rgb] = [pbr.a(i), pbr.b(i), pbr.c(i), pbr.d(i)];
        if (vecAngle({ x: n[0], y: n[1], z: n[2] }, cpu.normal) > 0.001 || !near(n[3], cpu.roughness, 1e-6) || !near(m[0], cpu.metallic, 1e-6)) {
          return `pbr ${i}: ${n} ${m[0]}`;
        }
        const s = splatOf(splats, i);
        if (m[1] !== s.opacity || center[0] !== s.center.x || center[2] !== s.center.z || rgb[1] !== s.rgb.g) {
          return `field loads ${i} differ from loadSplat`;
        }
      }
      return undefined;
    } finally {
      gpu.dispose();
    }
  });

  await check("GpuCovSplatReader loadCovSplat, and loadSplat diagonalized", async () => {
    const { data, gpu } = layoutData(renderer, inputs);
    try {
      const reader = new GpuCovSplatReader().bind(gpu);
      const covs = await writeFloats(renderer, N, (index) => {
        const c = reader.loadCovSplat(index).toVar();
        return [vec4(c.get("center"), c.get("opacity")), vec4(c.get("xxyyzz"), 0), vec4(c.get("xyxzyz"), 0), vec4(c.get("rgb"), 0)];
      });
      const splats = await writeFloats(renderer, N, (index) => splatOutputs(reader.loadSplat(index).toVar()));
      const cpu: CovSplat = Splats.makeCovSplat();
      for (let i = 0; i < N; i += 1) {
        Splats.decodeCov(data.bundles.covSplats, i, cpu);
        const [b, c] = [covs.b(i), covs.c(i)];
        const scale = Math.max(cpu.cov.xx, cpu.cov.yy, cpu.cov.zz);
        const expected = [cpu.cov.xx, cpu.cov.yy, cpu.cov.zz, cpu.cov.xy, cpu.cov.xz, cpu.cov.yz];
        const actual = [b[0], b[1], b[2], c[0], c[1], c[2]];
        if (actual.some((v, k) => !near(v, expected[k], scale * 1e-5))) {
          return `cov ${i}: ${actual} vs ${expected}`;
        }
        // Diagonalized in f32: the covariance it stands for, to 1e-4
        const gpuCov = covOf(splatOf(splats, i));
        if (gpuCov.some((v, k) => !near(v, expected[k], scale * 1e-4))) {
          return `diagonalized ${i}: ${gpuCov} vs ${expected}`;
        }
      }
      return undefined;
    } finally {
      gpu.dispose();
    }
  });

  await check("GpuPackedSplatReader loadSplat with the bundle's encoding", async () => {
    const packed = new ArrayData({ bundles: { packed: Splats.PACKED }, count: N });
    packed.bundles.packed.meta.encoding = { rgbMin: -0.5, rgbMax: 1.5, lnScaleMin: -10, lnScaleMax: 4 };
    inputs.forEach((s, i) => Splats.encodePacked(packed.bundles.packed, i, s));
    const arrays = GpuArrays.fromData(renderer, packed);
    try {
      const reader = new GpuPackedSplatReader().bind(arrays, "packed");
      const splats = await writeFloats(renderer, N, (index) => splatOutputs(reader.loadSplat(index).toVar()));
      const centers = await writeFloats(renderer, N, (index) => [vec4(reader.loadCenter(index), reader.loadOpacity(index)), vec4(reader.loadRgb(index), 0)]);
      const cpu = Splats.makeSplat();
      for (let i = 0; i < N; i += 1) {
        Splats.decodePacked(packed.bundles.packed, i, cpu);
        const mismatch = compareSplat(splatOf(splats, i), cpu);
        if (mismatch) {
          return `splat ${i}: ${mismatch}`;
        }
        if (centers.a(i)[0] !== splatOf(splats, i).center.x || centers.a(i)[3] !== splatOf(splats, i).opacity || centers.b(i)[2] !== splatOf(splats, i).rgb.b) {
          return `field loads ${i} differ from loadSplat`;
        }
      }
      return undefined;
    } finally {
      arrays.dispose();
    }
  });

  // --- Writers: TSL encode against the CPU's bits ---
  const INPUTS = defineBundle({ a: "float32x4", b: "float32x4", c: "float32x4", d: "float32x4", e: "float32x4", f: "float32x4" });

  // The inputs as stored floats (what the GPU reads), one splat per element
  function inputArrays(values: (i: number) => number[][]) {
    const data = new ArrayData({ bundles: { in: INPUTS }, count: N });
    for (let i = 0; i < N; i += 1) {
      values(i).forEach((vector, k) => (data.bundles.in.channels["abcdef"[k] as "a"].data as Float32Array).set(vector, i * 4));
    }
    return { data, gpu: GpuArrays.fromData(renderer, data) };
  }

  // GPU words against CPU words; a splat whose words differ (an f32 ln or
  // acos on a rounding boundary) must decode within the CPU's budgets, and
  // at most `share` of them may differ
  function compareWords(gpu: Uint32Array, cpu: Uint32Array, words: number, withinBudget: (i: number) => string | undefined, share = 0.02) {
    let differ = 0;
    for (let i = 0; i < N; i += 1) {
      let same = true;
      for (let w = 0; w < words; w += 1) {
        same &&= gpu[i * words + w] === cpu[i * words + w];
      }
      if (!same) {
        differ += 1;
        const problem = withinBudget(i);
        if (problem) {
          return `splat ${i}: ${problem}`;
        }
      }
    }
    return differ <= N * share ? undefined : `${differ} of ${N} splats differ`;
  }

  const fround = (s: ExtSplat): ExtSplat => {
    const f = Math.fround;
    return {
      center: { x: f(s.center.x), y: f(s.center.y), z: f(s.center.z) },
      scales: { x: f(s.scales.x), y: f(s.scales.y), z: f(s.scales.z) },
      quaternion: { x: f(s.quaternion.x), y: f(s.quaternion.y), z: f(s.quaternion.z), w: f(s.quaternion.w) },
      rgb: { r: f(s.rgb.r), g: f(s.rgb.g), b: f(s.rgb.b) },
      opacity: f(s.opacity), normal: { x: f(s.normal.x), y: f(s.normal.y), z: f(s.normal.z) }, roughness: f(s.roughness), metallic: f(s.metallic),
    };
  };
  const floats = inputs.map(fround);
  const splatVectors = (s: ExtSplat) => [
    [s.center.x, s.center.y, s.center.z, s.opacity], [s.scales.x, s.scales.y, s.scales.z, 0], [s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w],
    [s.rgb.r, s.rgb.g, s.rgb.b, 0], [s.normal.x, s.normal.y, s.normal.z, s.roughness], [s.metallic, 0, 0, 0],
  ];
  const splatFrom = (reader: GpuArrayReader<typeof INPUTS>, index: TslNode) =>
    GpuSplats.Splat(reader.load("a", index).xyz, reader.load("b", index).xyz, reader.load("c", index), reader.load("d", index).xyz, reader.load("a", index).w);

  // Decoded GPU words against the input, within the encoder's budgets
  const extBudget = (decoded: ExtSplat, s: ExtSplat) => {
    if (decoded.center.x !== s.center.x || !near(decoded.opacity, s.opacity, 1 / 256 + 1e-6)) {
      return "center or opacity";
    }
    // Two half-float steps of ln(scale)
    if ((["x", "y", "z"] as const).some((k) => lnError(decoded.scales[k], s.scales[k]) > lnHalfSteps(s.scales[k]))) {
      return "scales";
    }
    // The rounded octahedral codes: about 0.43 degrees of rotation, 0.057 of normal
    if (quatAngle(decoded.quaternion, s.quaternion) > 0.45 || vecAngle(decoded.normal, s.normal) > 0.06) {
      return `rotation ${quatAngle(decoded.quaternion, s.quaternion)}, normal ${vecAngle(decoded.normal, s.normal)}`;
    }
    if (!near(decoded.rgb.g, s.rgb.g, 2 / 255) || !near(decoded.roughness, s.roughness, 1 / 255) || !near(decoded.metallic, s.metallic, 1 / 255)) {
      return "rgb or pbr";
    }
    return undefined;
  };

  for (const kind of writerKinds) await check(`GpuSplats.storeExt (TSL encode${kindLabel(kind)}) matches the CPU's bits`, async () => {
    const source = inputArrays((i) => splatVectors(floats[i]));
    const out = new GpuArrays({ renderer, bundles: { extSplats: Splats.EXT }, capacity: N, storage: kind === "compute" });
    const reader = new GpuArrayReader(INPUTS).bind(source.gpu, "in");
    const writer = makeWriter(kind, {
      outputs: { extSplats: Splats.EXT },
      write: (index, o) => {
        const p = GpuSplats.Pbr(reader.load("e", index).xyz, reader.load("e", index).w, reader.load("f", index).x);
        GpuSplats.storeExt(o.extSplats, splatFrom(reader, index), p);
      },
    });
    try {
      writeAll(out, writer, N);
      const gpuData = await out.read();
      const cpu = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: N });
      floats.forEach((s, i) => Splats.encodeExt(cpu.bundles.extSplats, i, s));
      const decoded = Splats.makeExtSplat();
      const budget = (i: number) => extBudget(Splats.decodeExt(asLayout(gpuData.bundles.extSplats, Splats.isExt), i, decoded), floats[i]);
      return compareWords(gpuData.bundles.extSplats.channels.extA.data as Uint32Array, cpu.bundles.extSplats.channels.extA.data, 4, budget)
        ?? compareWords(gpuData.bundles.extSplats.channels.extB.data as Uint32Array, cpu.bundles.extSplats.channels.extB.data, 4, budget);
    } finally {
      writer.dispose();
      out.dispose();
      source.gpu.dispose();
    }
  });

  for (const kind of writerKinds) await check(`GpuSplats.storeCov (TSL encode${kindLabel(kind)}) matches the CPU's bits`, async () => {
    const covs = floats.map((s) => {
      const c = Splats.toCov(s, Splats.makeCovSplat());
      const f = Math.fround;
      return { ...c, cov: { xx: f(c.cov.xx), yy: f(c.cov.yy), zz: f(c.cov.zz), xy: f(c.cov.xy), xz: f(c.cov.xz), yz: f(c.cov.yz) }, normal: s.normal };
    });
    const source = inputArrays((i) => {
      const c = covs[i];
      return [[c.center.x, c.center.y, c.center.z, c.opacity], [c.cov.xx, c.cov.yy, c.cov.zz, 0], [c.cov.xy, c.cov.xz, c.cov.yz, 0], [c.rgb.r, c.rgb.g, c.rgb.b, 0], [c.normal.x, c.normal.y, c.normal.z, 0], [0, 0, 0, 0]];
    });
    const out = new GpuArrays({ renderer, bundles: { covSplats: Splats.COV }, capacity: N, storage: kind === "compute" });
    const reader = new GpuArrayReader(INPUTS).bind(source.gpu, "in");
    const writer = makeWriter(kind, {
      outputs: { covSplats: Splats.COV },
      write: (index, o) => GpuSplats.storeCov(o.covSplats, GpuSplats.CovSplat(
        reader.load("a", index).xyz, reader.load("b", index).xyz, reader.load("c", index).xyz, reader.load("d", index).xyz, reader.load("a", index).w, reader.load("e", index).xyz,
      )),
    });
    try {
      writeAll(out, writer, N);
      const gpuData = await out.read();
      const cpu = new ArrayData({ bundles: { covSplats: Splats.COV }, count: N });
      covs.forEach((c, i) => Splats.encodeCov(cpu.bundles.covSplats, i, c));
      const decoded = Splats.makeCovSplat();
      const budget = (i: number) => {
        Splats.decodeCov(asLayout(gpuData.bundles.covSplats, Splats.isCov), i, decoded);
        const c = covs[i].cov;
        const scale = Math.max(c.xx, c.yy, c.zz);
        // Diagonal: two half steps of its ln; off-diagonal: those plus the
        // correlation's half rounding, relative to the largest variance
        const diagonal = (["xx", "yy", "zz"] as const).some((k) => lnError(decoded.cov[k], c[k]) > lnHalfSteps(c[k]));
        const offDiagonal = (["xy", "xz", "yz"] as const).some((k) => !near(decoded.cov[k], c[k], scale * (lnHalfSteps(scale) + 1e-3)));
        return diagonal || offDiagonal ? `cov ${JSON.stringify(decoded.cov)} vs ${JSON.stringify(c)}` : undefined;
      };
      // ln|correlation| near +-1 is tiny, so f32 rounding picks its half code
      // for about 7% of random splats
      return compareWords(gpuData.bundles.covSplats.channels.covA.data as Uint32Array, cpu.bundles.covSplats.channels.covA.data, 4, budget)
        ?? compareWords(gpuData.bundles.covSplats.channels.covB.data as Uint32Array, cpu.bundles.covSplats.channels.covB.data, 4, budget, 0.1);
    } finally {
      writer.dispose();
      out.dispose();
      source.gpu.dispose();
    }
  });

  for (const kind of writerKinds) await check(`GpuSplats.storePacked (TSL encode${kindLabel(kind)}) matches the CPU's bits`, async () => {
    const source = inputArrays((i) => splatVectors(floats[i]));
    const out = new GpuArrays({ renderer, bundles: { packedSplats: Splats.PACKED }, capacity: N, storage: kind === "compute" });
    const reader = new GpuArrayReader(INPUTS).bind(source.gpu, "in");
    const writer = makeWriter(kind, { outputs: { packedSplats: Splats.PACKED }, write: (index, o) => GpuSplats.storePacked(o.packedSplats, splatFrom(reader, index)) });
    try {
      writeAll(out, writer, N);
      const gpuData = await out.read();
      const cpu = new ArrayData({ bundles: { packedSplats: Splats.PACKED }, count: N });
      floats.forEach((s, i) => Splats.encodePacked(cpu.bundles.packedSplats, i, s));
      const decoded = Splats.makeSplat();
      const budget = (i: number) => {
        Splats.decodePacked(asLayout(gpuData.bundles.packedSplats, Splats.isPacked), i, decoded);
        const s = floats[i];
        return quatAngle(decoded.quaternion, s.quaternion) > 2 || !near(decoded.rgb.r, s.rgb.r, 1 / 255) || lnError(decoded.scales.y, s.scales.y) > 21 / 254
          ? `rotation ${quatAngle(decoded.quaternion, s.quaternion)}` : undefined;
      };
      return compareWords(gpuData.bundles.packedSplats.channels.packed.data as Uint32Array, cpu.bundles.packedSplats.channels.packed.data, 4, budget);
    } finally {
      writer.dispose();
      out.dispose();
      source.gpu.dispose();
    }
  });

  await check("GpuSplatReader.from(arrays) picks the layout and binds to the splat bundle", async () => {
    const data = new ArrayData({ bundles: { packedSplats: Splats.PACKED }, count: N });
    inputs.forEach((s, i) => Splats.encodePacked(data.bundles.packedSplats, i, s));
    const arrays = GpuArrays.fromData(renderer, data);
    try {
      const reader = GpuSplatReader.from(arrays);
      if (reader.layout !== "packedSplats") {
        return `picked ${reader.layout}`;
      }
      const out = await writeFloats(renderer, N, (index) => [vec4(reader.loadCenter(index), reader.loadOpacity(index))]);
      const cpu = Splats.makeSplat();
      for (let i = 0; i < N; i += 1) {
        Splats.decodePacked(data.bundles.packedSplats, i, cpu);
        const [x, , z, opacity] = out.a(i);
        if (x !== cpu.center.x || z !== cpu.center.z || !near(opacity, cpu.opacity, 1e-6)) {
          return `splat ${i}: ${out.a(i)} vs ${JSON.stringify(cpu.center)} ${cpu.opacity}`;
        }
      }
      return undefined;
    } finally {
      arrays.dispose();
    }
  });

  await check("a writer decodes and re-encodes ext splats unchanged", async () => {
    const { data, gpu } = layoutData(renderer, inputs);
    const out = new GpuArrays({ renderer, bundles: { extSplats: Splats.EXT }, capacity: N });
    const reader = new GpuExtSplatReader().bind(gpu);
    const writer = new GpuArrayWriter({ outputs: { extSplats: Splats.EXT }, write: (index, o) => GpuSplats.storeExt(o.extSplats, reader.loadSplat(index), reader.loadPbr(index)) });
    try {
      out.write(writer, { count: N });
      const back = await out.read();
      const decoded = Splats.makeExtSplat();
      const original = Splats.makeExtSplat();
      for (let i = 0; i < N; i += 1) {
        const problem = extBudget(Splats.decodeExt(asLayout(back.bundles.extSplats, Splats.isExt), i, decoded), Splats.decodeExt(data.bundles.extSplats, i, original));
        if (problem) {
          return `splat ${i}: ${problem}`;
        }
      }
      return undefined;
    } finally {
      writer.dispose();
      out.dispose();
      gpu.dispose();
    }
  });

  // --- GpuArrayWriter: ranges, packing, batches, limits ---
  const pattern = (i: number) => [(i * 2654435761) >>> 0, i, 7, (i ^ 0x55) >>> 0];
  const patternTsl = (i: TslNode) => uvec4(i.mul(uint(2654435761)), i, uint(7), i.bitXor(uint(0x55)));

  for (const [label, def, texel] of [
    ["uint32x4", defineBundle({ v: "uint32x4" }), (i: TslNode) => patternTsl(i)],
    ["uint32x2 packed 2", defineBundle({ v: "uint32x2" }, { packing: 2 }), (i: TslNode) => uvec4(patternTsl(i).xy, patternTsl(i.add(uint(1))).xy)],
    ["uint32 packed 4", defineBundle({ v: "uint32" }, { packing: 4 }), (i: TslNode) => uvec4(patternTsl(i).x, patternTsl(i.add(uint(1))).x, patternTsl(i.add(uint(2))).x, patternTsl(i.add(uint(3))).x)],
  ] as [string, BundleDef, (i: TslNode) => TslNode][]) {
    await check(`GpuArrayWriter ${label}: a range across rows and layers, then a batch`, async () => {
      const components = Number(def.channels.v.split("x")[1] ?? 1);
      const arrays = new GpuArrays({ renderer, bundles: { b: def }, capacity: 10000 });
      const writer = new GpuArrayWriter({ outputs: { b: def }, write: (index, o) => o.b.v.assign(texel(index)) });
      const constant = new GpuArrayWriter({ outputs: { b: def }, write: (_index, o) => o.b.v.assign(texel(uint(1234567))) });
      if (arrays.bundle("b").layout.layers < 3) {
        return `only ${arrays.bundle("b").layout.layers} layers`;
      }
      try {
        const expected = new Uint32Array(10000 * components);
        const fill = (at: number, count: number, first: number) => {
          for (let e = at; e < at + count; e += 1) {
            expected.set(pattern(e - at + first).slice(0, components), e * components);
          }
        };
        arrays.write(writer, { at: 1500, count: 6000, first: 100 });
        fill(1500, 6000, 100);
        if (arrays.count !== 7500) {
          return `count ${arrays.count}`;
        }
        arrays.writeBatch([{ writer, at: 0, count: 1000 }, { writer: constant, at: 8000, count: 1996 }]);
        const count: number = arrays.count;
        fill(0, 1000, 0);
        // The constant texel: element k of every texel is pattern(1234567 + k)
        for (let e = 8000; e < 9996; e += 1) {
          expected.set(pattern(1234567 + ((e - 8000) % def.packing)).slice(0, components), e * components);
        }

        const values = (await arrays.read({ count: 10000 })).bundles.b.channels.v.data;
        for (let k = 0; k < expected.length; k += 1) {
          if (values[k] !== expected[k]) {
            return `value ${k} (element ${Math.floor(k / components)}): got ${values[k]}, expected ${expected[k]}`;
          }
        }
        return count === 9996 ? undefined : `count ${count}`;
      } finally {
        writer.dispose();
        constant.dispose();
        arrays.dispose();
      }
    });
  }

  await check("GpuArrayWriter limits: channels, bytes, packing, formats", async () => {
    const attempts: [string, () => unknown][] = [
      ["5 channels", () => new GpuArrayWriter({ outputs: { a: FLOATS, b: defineBundle({ e: "uint32" }) }, write: () => {} })],
      ["mixed packing", () => new GpuArrayWriter({ outputs: { a: defineBundle({ v: "uint32" }), b: defineBundle({ v: "uint32" }, { packing: 4 }) }, write: () => {} })],
      ["snorm8", () => new GpuArrayWriter({ outputs: { a: defineBundle({ v: "snorm8x4" }) }, write: () => {} })],
    ];
    for (const [name, attempt] of attempts) {
      try {
        attempt();
        return `${name} accepted`;
      } catch {
        // expected
      }
    }
    const arrays = new GpuArrays({ renderer, bundles: { b: defineBundle({ v: "uint32" }, { packing: 4 }) }, capacity: 100 });
    const writer = new GpuArrayWriter({ outputs: { b: defineBundle({ v: "uint32" }, { packing: 4 }) }, write: (index, o) => o.b.v.assign(uvec4(index)) });
    try {
      arrays.write(writer, { at: 2, count: 4 });
      return "a start off the packing accepted";
    } catch {
      return undefined;
    } finally {
      writer.dispose();
      arrays.dispose();
    }
  });

  // --- Double buffering ---
  await check("GpuArrays.swap, with the reader bound again", async () => {
    const def = defineBundle({ v: "float32x4" });
    const [a, b] = [1, 2].map((k) => {
      const data = new ArrayData({ bundles: { b: def }, count: 100 });
      data.bundles.b.channels.v.data.forEach((_, i, values) => (values[i] = i * k));
      return GpuArrays.fromData(renderer, data);
    });
    const reader = new GpuArrayReader(def).bind(a, "b");
    try {
      a.swap(b);
      reader.bind(a, "b");
      const out = await writeFloats(renderer, 100, (index) => [reader.load("v", index)]);
      return out.a(10)[1] === 41 * 2 && b.count === 100 ? undefined : `read ${out.a(10)}`;
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  // --- Projected word codecs (render/projection.tsl.ts) ---

  await check("projection codecs: depth20 within 2^-16 of the depth (clamped to 2^-14..2^18), angle12 within pi / 8192", async () => {
    const out = await writeFloats(renderer, N + 2, (index) => {
      const i = uint(index).toVar();
      const t = float(i).div(N - 1).toVar();
      const sweep = exp2(mix(float(Math.log2(1e-3)), float(Math.log2(1e5)), t));
      const depth = select(i.equal(uint(N)), float(1e-6), select(i.equal(uint(N + 1)), float(1e7), sweep)).toVar();
      const angle = t.mul(Math.PI).toVar();
      return [vec4(depth, decodeDepth20(encodeDepth20(depth.negate())).negate(), angle, decodeAngle12(encodeAngle12(angle)))];
    });
    for (let i = 0; i < N + 2; i += 1) {
      const [depth, back, angle, angleBack] = out.a(i);
      const expected = Math.min(Math.max(depth, 2 ** -14), 2 ** 18);
      if (!(Math.abs(back / expected - 1) <= 2 ** -16 * 1.01)) {
        return `depth ${depth} came back ${back}`;
      }
      const turn = Math.abs(angleBack - angle) % Math.PI;
      if (i < N && Math.min(turn, Math.PI - turn) > (Math.PI / 8192) * 1.01) {
        return `angle ${angle} came back ${angleBack}`;
      }
    }
    return undefined;
  });

  await check("projection codecs: the ray methods' center keeps its direction within 5e-6 rad (20 + 20 bits) and its distance", async () => {
    const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => ({ x, y, z }))));
    const axes = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }];
    // Either side of the octahedral fold (z = 0)
    const fold = [{ x: 0.6, y: -0.4, z: 1e-4 }, { x: 0.6, y: -0.4, z: -1e-4 }, { x: -0.3, y: 0.7, z: -1e-6 }];
    const directions = [...corners, ...axes, ...fold, ...Array.from({ length: N }, randomUnit)];
    const values = new Float32Array(directions.length * 4);
    directions.forEach((d, i) => {
      const length = Math.hypot(d.x, d.y, d.z);
      values.set([d.x / length, d.y / length, d.z / length, 1e-3 * 1e8 ** (i / directions.length)], i * 4);
    });
    const INPUT = defineBundle({ v: "float32x4" });
    const arrays = GpuArrays.fromData(renderer, new ArrayData({ count: directions.length }).addBundle("input", INPUT, { data: { v: values } }));
    const reader = new GpuArrayReader(INPUT).bind(arrays, "input");
    try {
      const out = await writeFloats(renderer, directions.length, (index) => {
        const v = reader.load("v", index).toVar();
        const [dir, distance, low] = encodeCenter(v.xyz.mul(v.w));
        // The last head word holds other fields below bit 24
        return [vec4(decodeCenter(dir, distance, low.bitOr(uint(0xabcdef))), uintBitsToFloat(distance))];
      });
      for (let i = 0; i < directions.length; i += 1) {
        const [x, y, z, distance] = out.a(i);
        const [dx, dy, dz, w] = values.subarray(i * 4, i * 4 + 4);
        const turn = vecAngle({ x, y, z }, { x: dx, y: dy, z: dz });
        if (turn > degrees(5e-6) || Math.abs(distance / w - 1) > 1e-6 || Math.abs(Math.hypot(x, y, z) / w - 1) > 1e-6) {
          return `direction ${[dx, dy, dz].map((c) => c.toFixed(5))} at ${w}: turned ${turn.toExponential(2)} degrees, distance ${distance}`;
        }
      }
      return undefined;
    } finally {
      arrays.dispose();
    }
  });

  // --- createRenderer options ---
  await check("createRenderer with profile, hdr and directCanvas", async () => {
    const other = await createRenderer({ backend, canvas: document.createElement("canvas"), profile: true, hdr: false, directCanvas: false });
    try {
      const caps = getGpuCaps(other);
      if (!(other.inspector instanceof GpuProfiler) || other.outputColorSpace !== THREE.SRGBColorSpace || caps.hdr || caps.backend !== backend) {
        return `inspector ${other.inspector?.constructor.name}, color space ${other.outputColorSpace}, caps ${JSON.stringify(caps)}`;
      }
      return renderer.outputColorSpace === THREE.LinearSRGBColorSpace ? undefined : "the default renderer does not draw straight to the canvas";
    } finally {
      other.dispose();
    }
  });

  // --- Workers ---
  await check("loadSplats / writeSplats on every worker choice give the same results", async () => {
    const pool = new WorkerPool({ size: 2 });
    if (pool.workerCount !== 0) {
      return "workers made up front";
    }
    const lease = await pool.acquire();
    try {
      const source = new ArrayData({ bundles: { extSplats: Splats.EXT, lodTree: Splats.LOD_TREE }, count: 2000 });
      inputs.slice(0, 2000).forEach((s, i) => Splats.encodeExt(source.bundles.extSplats, i, s));
      source.bundles.lodTree.channels.node.data.forEach((_, i, a) => (a[i] = i % 5));
      const word = source.bundles.extSplats.channels.extB.data[123];

      const ply = await writeSplats(source, "ply", { worker: false, pbr: true });
      const spz = await writeSplats(source, "spz", { worker: false, pbr: true });
      const reference = await loadSplats(spz.slice(), { name: "scene.spz", worker: false });
      const choices: [string, WorkerChoice | undefined][] = [["default", undefined], ["true", true], ["pool", pool], ["lease", lease]];
      for (const [name, worker] of choices) {
        const bytes = await writeSplats(source, "ply", { worker, pbr: true });
        if (bytes.length !== ply.length || bytes.some((v, i) => v !== ply[i])) {
          return `${name}: PLY bytes differ`;
        }
        if (source.bundles.extSplats.channels.extB.data[123] !== word || source.bundles.lodTree.channels.node.data[7] !== 2) {
          return `${name}: the data did not come back`;
        }
        const loaded = await loadSplats(spz.slice(), { name: "scene.spz", worker });
        const [x, y] = [loaded.bundles.extSplats.channels.extA.data, reference.bundles.extSplats.channels.extA.data];
        if (x.length !== y.length || x.some((v, i) => v !== y[i]) || Splats.findLodTree(loaded)?.channels.node.data[7] !== 2) {
          return `${name}: loaded splats differ`;
        }
      }
      return pool.workerCount >= 1 && WorkerPool.default.workerCount >= 1 ? undefined : `workers ${pool.workerCount}, ${WorkerPool.default.workerCount}`;
    } finally {
      lease.release();
      pool.dispose();
    }
  });

  await check("loadSplats into packedSplats with an encoding, on a worker and here alike", async () => {
    const source = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 2000 });
    inputs.slice(0, 2000).forEach((s, i) => Splats.encodeExt(source.bundles.extSplats, i, s));
    const spz = await writeSplats(source, "spz", { worker: false });
    const options = { name: "scene.spz", layout: "packedSplats", encoding: { rgbMin: -1, rgbMax: 2 } } as const;
    const [there, here] = [await loadSplats(spz.slice(), { ...options, worker: true }), await loadSplats(spz.slice(), { ...options, worker: false })];
    const [a, b] = [there.bundles.packedSplats, here.bundles.packedSplats];
    if (Splats.packedEncodingOf(a).rgbMin !== -1 || Splats.packedEncodingOf(a).rgbMax !== 2 || Splats.packedEncodingOf(a).lnScaleMin !== Splats.packedEncodingOf(b).lnScaleMin) {
      return `encoding ${JSON.stringify(a.meta.encoding)}`;
    }
    return a.channels.packed.data.every((v, i) => v === b.channels.packed.data[i]) && "extSplats" in there.bundles === false ? undefined : "worker and here differ";
  });

  await check("loadSplats: a signal aborts it here and on a pool (before and during the load), and the pool loads again", async () => {
    const source = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 2000 });
    inputs.slice(0, 2000).forEach((s, i) => Splats.encodeExt(source.bundles.extSplats, i, s));
    const ply = await writeSplats(source, "ply", { worker: false });
    const pool = new WorkerPool({ size: 1 });
    const outcome = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => error);
    try {
      for (const [name, worker] of [["here", false], ["pool", pool]] as const) {
        const reason = new Error("stop");
        const before = new AbortController();
        before.abort(reason);
        if (await outcome(loadSplats(ply.slice(), { name: "a.ply", worker, signal: before.signal })) !== reason) {
          return `${name}: an aborted signal did not reject with its reason`;
        }
        const during = new AbortController();
        const progressed = await outcome(loadSplats(ply.slice(), { name: "a.ply", worker, signal: during.signal, onProgress: () => during.abort(reason) }));
        if (progressed !== reason) {
          return `${name}: aborting on the first progress gave ${String(progressed)}`;
        }
        const loaded = await loadSplats(ply.slice(), { name: "a.ply", worker });
        if (loaded.count !== source.count) {
          return `${name}: the next load has ${loaded.count} splats`;
        }
      }
      // Queued behind a lease on the pool's only worker: rejects without it
      const lease = await pool.acquire();
      const queued = new AbortController();
      const waiting = outcome(loadSplats(ply.slice(), { name: "a.ply", worker: pool, signal: queued.signal }));
      const reason = new Error("stop waiting");
      queued.abort(reason);
      const waited = await waiting;
      lease.release();
      if (waited !== reason) {
        return `a queued load gave ${String(waited)}`;
      }
      return pool.workerCount === 1 ? undefined : `pool has ${pool.workerCount} workers`;
    } finally {
      pool.dispose();
    }
  });

  await check("loadSplats: request options reach fetch here and go to a worker (a Headers object too)", async () => {
    const source = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 100 });
    inputs.slice(0, 100).forEach((s, i) => Splats.encodeExt(source.bundles.extSplats, i, s));
    const url = URL.createObjectURL(new Blob([await writeSplats(source, "ply", { worker: false })]));
    const original = globalThis.fetch;
    let seen: RequestInit | undefined;
    globalThis.fetch = (input, init) => {
      seen = init;
      return original(input, init);
    };
    try {
      const here = await loadSplats(url, { name: "a.ply", worker: false, request: { credentials: "omit", headers: { "X-Radix": "1" } } });
      const headers = new Headers(seen?.headers);
      if (here.count !== 100 || seen?.credentials !== "omit" || headers.get("X-Radix") !== "1") {
        return `here: ${here.count} splats, init ${JSON.stringify(seen)}`;
      }
      const there = await loadSplats(url, { name: "a.ply", worker: true, request: { credentials: "omit", headers: new Headers({ "X-Radix": "1" }) } });
      return there.count === 100 ? undefined : `worker: ${there.count} splats`;
    } finally {
      globalThis.fetch = original;
      URL.revokeObjectURL(url);
    }
  });

  await check("WorkerPool.coreUrl: an app's own module worker imports core/ from it and sorts like this thread", async () => {
    const code = `self.onmessage = async (event) => {
      const core = await import(event.data.url);
      const { ordering, visible } = core.SortKeys.sort({ keys: event.data.keys, count: event.data.keys.length, bits: 24 });
      self.postMessage({ ordering, visible, serves: typeof core.serveWorker });
    };`;
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    try {
      const keys = new Uint32Array(5000).map((_, i) => (i * 2654435761) % 0xfeffff);
      const reply = await new Promise<{ ordering: Uint32Array; visible: number; serves: string }>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message || "worker failed"));
        worker.postMessage({ url: WorkerPool.coreUrl, keys });
      });
      const here = SortKeys.sort({ keys: keys.slice(), count: keys.length, bits: 24 });
      const at = here.ordering.findIndex((v, i) => reply.ordering[i] !== v);
      return reply.visible === here.visible && at < 0 && reply.serves === "function" ? undefined : `visible ${reply.visible} vs ${here.visible}, index ${at}, serveWorker ${reply.serves}`;
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });

  await check("writeSplats on a worker gives the data back when it fails", async () => {
    const data = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 10 });
    data.bundles.extSplats.channels.extA.data[0] = 42;
    try {
      await writeSplats(data, "spz", { worker: true, lod: true });
      return "a missing tree accepted";
    } catch {
      return data.bundles.extSplats.channels.extA.data[0] === 42 ? undefined : "data lost";
    }
  });

}
