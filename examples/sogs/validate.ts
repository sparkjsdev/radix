import type { WebGPURenderer } from "three/webgpu";
import {
  ArrayData, Encoding, GpuArrayReader, GpuArrayWriter, GpuArrays, GpuSh, GpuShReader, Sh, ShPalette, Splats, TSL, defineBundle,
  type ExtSplat, type ShDegree, type TslNode,
} from "@sparkjsdev/radix";
import { decodeSogGpu } from "./gpuDecode.js";
import { availableLevel, fovScale, levelChains, selectLevels, type LodSettings, type Vec3Like } from "./lod.js";
import type { SogLodStream } from "./lodStream.js";
import { SH_C0, type SogSource } from "./sog.js";
import { RANGES_BUNDLE, paletteOf, rangeLookup, type SogArrays } from "./sh.js";

const { vec4 } = TSL;

export interface ValidateOptions {
  renderer: WebGPURenderer;
  shown?: { file?: SogArrays; data?: ArrayData; source?: SogSource; stream?: SogLodStream; count: number };
  // URL of a reference PLY of the shown file
  reference?: string;
  // Splats sampled by the SH checks
  samples?: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: Record<string, unknown>;
}

const summary = (values: number[]) => {
  const sorted = Float64Array.from(values).sort();
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { max: +(sorted[sorted.length - 1] ?? 0).toPrecision(3), p99: +at(0.99).toPrecision(3), p50: +at(0.5).toPrecision(3) };
};

async function readPlyFloats(url: string) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const end = head.indexOf("end_header\n");
  if (!head.startsWith("ply") || end < 0 || !head.includes("binary_little_endian")) {
    throw new Error(`${url}: not a binary little-endian PLY`);
  }
  let count = 0;
  const names: string[] = [];
  for (const line of head.slice(0, end).split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] === "element") {
      if (f[1] !== "vertex" || names.length > 0) {
        throw new Error(`${url}: only a vertex element is read`);
      }
      count = Number(f[2]);
    } else if (f[0] === "property") {
      if (f[1] !== "float") {
        throw new Error(`${url}: property ${f[2]} is not float`);
      }
      names.push(f[2]);
    }
  }
  const start = end + "end_header\n".length;
  const floats = new Float32Array(bytes.slice(start, start + count * names.length * 4).buffer);
  const column = Object.fromEntries(names.map((name, j) => [name, j]));
  return { count, stride: names.length, floats, column };
}

// The palette's coefficients (coefficient-major RGB) of entry n
function paletteValues(palette: ArrayData, n: number, out: Float32Array) {
  return new ShPalette(palette).get(n, out);
}

async function checkReference(o: ValidateOptions, url: string): Promise<Check> {
  const { data, file } = o.shown!;
  if (!data || !file) {
    return { name: "reference", ok: false, detail: { error: "needs a single file decoded on the CPU (?decode=cpu)" } };
  }
  const ref = await readPlyFloats(url);
  if (ref.count !== data.count) {
    return { name: "reference", ok: false, detail: { error: `count ${data.count}, reference ${ref.count}` } };
  }
  const decode = Splats.decoder(Splats.get(data).bundle);
  const scratch = Splats.make(1);
  const encodeRef = Splats.encoder(scratch.bundles.extSplats);
  const decodeRef = Splats.decoder(scratch.bundles.extSplats);
  const ours = Splats.makeExtSplat();
  const theirs = Splats.makeExtSplat();
  const r = Splats.makeExtSplat();
  const c = ref.column;
  const fRest = Array.from({ length: 45 }, (_, k) => c[`f_rest_${k}`]).filter((j) => j !== undefined);
  const coefficients = fRest.length / 3;

  const palette = file.palette ? await file.palette.read() : undefined;
  const labels = file.palette ? (await file.arrays.read({ bundles: ["shLabel"] })).bundles.shLabel.channels.label.data as Uint16Array : undefined;
  const values = new Float32Array(Sh.VALUES);

  let extent = 0;
  const errors = { center: [] as number[], scale: [] as number[], angle: [] as number[], rgb: [] as number[], opacity: [] as number[], sh: [] as number[] };
  const step = Math.max(1, Math.floor(data.count / 200_000));
  for (let i = 0; i < data.count; i += step) {
    const base = i * ref.stride;
    const get = (name: string) => ref.floats[base + c[name]];
    theirs.center.x = get("x");
    theirs.center.y = get("y");
    theirs.center.z = get("z");
    theirs.scales.x = Math.exp(get("scale_0"));
    theirs.scales.y = Math.exp(get("scale_1"));
    theirs.scales.z = Math.exp(get("scale_2"));
    const q = [get("rot_1"), get("rot_2"), get("rot_3"), get("rot_0")];
    const length = Math.hypot(...q) || 1;
    theirs.quaternion.x = q[0] / length;
    theirs.quaternion.y = q[1] / length;
    theirs.quaternion.z = q[2] / length;
    theirs.quaternion.w = q[3] / length;
    theirs.rgb.r = 0.5 + SH_C0 * get("f_dc_0");
    theirs.rgb.g = 0.5 + SH_C0 * get("f_dc_1");
    theirs.rgb.b = 0.5 + SH_C0 * get("f_dc_2");
    theirs.opacity = 1 / (1 + Math.exp(-get("opacity")));
    theirs.roughness = 0;
    encodeRef(0, theirs);
    decodeRef(0, r);
    decode(i, ours);

    extent = Math.max(extent, Math.abs(r.center.x), Math.abs(r.center.y), Math.abs(r.center.z));
    errors.center.push(Math.max(Math.abs(ours.center.x - r.center.x), Math.abs(ours.center.y - r.center.y), Math.abs(ours.center.z - r.center.z)));
    errors.scale.push(Math.max(...(["x", "y", "z"] as const).map((k) => Math.abs(Math.log(ours.scales[k] / r.scales[k])))));
    const dot = Math.abs(ours.quaternion.x * r.quaternion.x + ours.quaternion.y * r.quaternion.y + ours.quaternion.z * r.quaternion.z + ours.quaternion.w * r.quaternion.w);
    errors.angle.push(2 * Math.acos(Math.min(1, dot)));
    errors.rgb.push(Math.max(Math.abs(ours.rgb.r - r.rgb.r), Math.abs(ours.rgb.g - r.rgb.g), Math.abs(ours.rgb.b - r.rgb.b)));
    errors.opacity.push(Math.abs(ours.opacity - r.opacity));
    if (palette && labels && coefficients > 0) {
      paletteValues(palette, labels[i], values);
      let worst = 0;
      for (let k = 0; k < coefficients; k += 1) {
        for (let ch = 0; ch < 3; ch += 1) {
          worst = Math.max(worst, Math.abs(values[k * 3 + ch] - ref.floats[base + fRest[ch * coefficients + k]]));
        }
      }
      errors.sh.push(worst);
    }
  }

  const detail = Object.fromEntries(Object.entries(errors).filter(([, list]) => list.length > 0).map(([name, list]) => [name, summary(list)])) as Record<string, ReturnType<typeof summary>>;
  // Both sides go through the ext encoding, so what is left is f32 against f64
  // math, and the SH is the codebook's values in ext's steps
  const budgets: Record<string, number> = { center: extent * 1e-5, scale: 1e-3, angle: 2e-3, rgb: 2e-3, opacity: 1e-2, sh: 1e-2 };
  const ok = Object.entries(detail).every(([name, s]) => s.p99 <= budgets[name] && s.max <= budgets[name] * 8);
  return { name: "reference", ok, detail: { splats: data.count, compared: errors.center.length, coefficients, extent: +extent.toPrecision(4), budgets, ...detail } };
}

const SAMPLE_BUNDLE = defineBundle({ splat: "uint32", dir: "float32x4" });
const OUT_BUNDLE = defineBundle({ rgb: "float32x4" });

async function checkSh(o: ValidateOptions): Promise<Check> {
  const file = o.shown?.file;
  if (!file?.palette) {
    return { name: "sh", ok: true, detail: { skipped: "no SH" } };
  }
  const { renderer } = o;
  const n = Math.min(o.samples ?? 4096, file.arrays.count);
  const samples = new ArrayData({ count: n }).addBundle("samples", SAMPLE_BUNDLE);
  const { splat, dir } = samples.bundles.samples.channels;
  for (let k = 0; k < n; k += 1) {
    splat.data[k] = Math.floor((k * file.arrays.count) / n);
    // Fibonacci sphere directions
    const y = 1 - (2 * (k + 0.5)) / n;
    const radius = Math.sqrt(1 - y * y);
    const phi = k * Math.PI * (3 - Math.sqrt(5));
    dir.data.set([radius * Math.cos(phi), y, radius * Math.sin(phi), 0], k * 4);
  }
  const sampleArrays = GpuArrays.fromData(renderer, samples);
  const sampleReader = new GpuArrayReader(SAMPLE_BUNDLE).bind(sampleArrays, "samples");
  const { codec, degree } = paletteOf(file)!;
  const shReader = new GpuShReader({ codec, degree, palette: true }).bind(file.arrays, file.palette);
  const writer = new GpuArrayWriter({
    outputs: { out: OUT_BUNDLE },
    write: (index: TslNode, out) => {
      const stored = sampleReader.load("splat", index).toVar();
      out.out.rgb.assign(vec4(GpuSh.evaluate(sampleReader.load("dir", index).xyz, degree, (band) => shReader.band(stored, band), { cap: false }), 0));
    },
  });
  const result = new GpuArrays({ renderer, bundles: { out: OUT_BUNDLE }, capacity: n });
  result.write(writer, { at: 0, count: n });
  const gpu = (await result.read()).bundles.out.channels.rgb.data as Float32Array;
  const palette = await file.palette.read();
  const labels = (await file.arrays.read({ bundles: ["shLabel"] })).bundles.shLabel.channels.label.data as Uint16Array;
  [sampleArrays, result].forEach((arrays) => arrays.dispose());
  writer.dispose();

  const values = new Float32Array(Sh.VALUES);
  const rgb = [0, 0, 0];
  const errors: number[] = [];
  let magnitude = 0;
  for (let k = 0; k < n; k += 1) {
    paletteValues(palette, labels[splat.data[k]], values);
    Sh.evaluate(values, { x: dir.data[k * 4], y: dir.data[k * 4 + 1], z: dir.data[k * 4 + 2] }, degree as ShDegree, rgb);
    magnitude = Math.max(magnitude, ...rgb.map(Math.abs));
    errors.push(Math.max(...rgb.map((v, ch) => Math.abs(v - gpu[k * 4 + ch]))));
  }
  const s = summary(errors);
  return { name: "sh", ok: s.max <= 1e-4 + magnitude * 1e-5, detail: { samples: n, codec, degree, largestTerm: +magnitude.toPrecision(3), ...s } };
}

async function checkGpuDecode(o: ValidateOptions): Promise<Check> {
  const { source, data } = o.shown!;
  if (!source || !data || Splats.get(data).layout !== "extSplats") {
    return { name: "gpuDecode", ok: true, detail: { skipped: "needs a CPU decode of ext splats" } };
  }
  const gpu = await decodeSogGpu(o.renderer, source);
  const back = await gpu.arrays.read();
  const gpuPalette = await gpu.palette?.read();
  const cpuPalette = await o.shown!.file?.palette?.read();
  gpu.arrays.dispose();
  gpu.palette?.dispose();

  // f32 math on the GPU can put a palette value in the next ext step, so a word
  // that differs must decode within a step (2^e / 255 <= 2 max / 255)
  const palette = { words: 0, differ: 0, outside: 0 };
  if (gpuPalette && cpuPalette) {
    const [a, b] = [cpuPalette.bundles.shPalette.channels.shEntries.data as Uint32Array, gpuPalette.bundles.shPalette.channels.shEntries.data as Uint32Array];
    const [x, y] = [{ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }];
    const n = Math.min(cpuPalette.count, gpuPalette.count) * 4;
    for (let i = 0; i < n; i += 1) {
      palette.words += 1;
      if (a[i] !== b[i]) {
        palette.differ += 1;
        Encoding.decodeExtRgb(a[i], x);
        Encoding.decodeExtRgb(b[i], y);
        const step = (2 / 255) * Math.max(Math.abs(x.r), Math.abs(x.g), Math.abs(x.b), Math.abs(y.r), Math.abs(y.g), Math.abs(y.b)) + 1e-9;
        palette.outside += Math.abs(x.r - y.r) > step || Math.abs(x.g - y.g) > step || Math.abs(x.b - y.b) > step ? 1 : 0;
      }
    }
  }
  const paletteOk = (gpuPalette === undefined) === (cpuPalette === undefined) && gpuPalette?.count === cpuPalette?.count && palette.outside === 0;

  const count = data.count;
  const words = (d: ArrayData) => {
    const { extA, extB } = (d.bundles.extSplats as unknown as { channels: Record<"extA" | "extB", { data: Uint32Array }> }).channels;
    return [extA.data, extB.data];
  };
  const [cpuA, cpuB] = words(data);
  const [gpuA, gpuB] = words(back);
  let equal = 0;
  for (let i = 0; i < count * 4; i += 1) {
    equal += cpuA[i] === gpuA[i] ? 1 : 0;
    equal += cpuB[i] === gpuB[i] ? 1 : 0;
  }

  const decodeCpu = Splats.decoder(Splats.get(data).bundle);
  const decodeGpu = Splats.decoder(Splats.get(back).bundle);
  const a: ExtSplat = Splats.makeExtSplat();
  const b: ExtSplat = Splats.makeExtSplat();
  const errors = { center: [] as number[], scale: [] as number[], angle: [] as number[], rgb: [] as number[], opacity: [] as number[] };
  let extent = 0;
  const step = Math.max(1, Math.floor(count / 200_000));
  for (let i = 0; i < count; i += step) {
    decodeCpu(i, a);
    decodeGpu(i, b);
    extent = Math.max(extent, Math.abs(a.center.x), Math.abs(a.center.y), Math.abs(a.center.z));
    errors.center.push(Math.max(Math.abs(a.center.x - b.center.x), Math.abs(a.center.y - b.center.y), Math.abs(a.center.z - b.center.z)));
    errors.scale.push(Math.max(...(["x", "y", "z"] as const).map((k) => Math.abs(Math.log(a.scales[k] / b.scales[k])))));
    const dot = Math.abs(a.quaternion.x * b.quaternion.x + a.quaternion.y * b.quaternion.y + a.quaternion.z * b.quaternion.z + a.quaternion.w * b.quaternion.w);
    errors.angle.push(2 * Math.acos(Math.min(1, dot)));
    errors.rgb.push(Math.max(Math.abs(a.rgb.r - b.rgb.r), Math.abs(a.rgb.g - b.rgb.g), Math.abs(a.rgb.b - b.rgb.b)));
    errors.opacity.push(Math.abs(a.opacity - b.opacity));
  }

  let labelsDiffer = 0;
  if (data.bundles.shLabel) {
    const cpuLabels = data.bundles.shLabel.channels.label.data as Uint16Array;
    const gpuLabels = back.bundles.shLabel.channels.label.data as Uint16Array;
    for (let i = 0; i < count; i += 1) {
      labelsDiffer += cpuLabels[i] === gpuLabels[i] ? 0 : 1;
    }
  }

  const detail = Object.fromEntries(Object.entries(errors).map(([name, list]) => [name, summary(list)])) as Record<string, ReturnType<typeof summary>>;
  // f32 exp and rounding on the GPU may leave a code one step off: a half step
  // of ln scale, a step of QuatOct32's 10 + 10 bit axis, an 8-bit opacity step
  const budgets: Record<string, number> = { center: extent * 1e-5, scale: 0.02, angle: 1e-2, rgb: 4e-3, opacity: 1e-2 };
  // Twice for the max, as a few quaternions sit on an octahedral fold where a step is longer
  const ok = labelsDiffer === 0 && Object.entries(detail).every(([name, s]) => s.p99 <= budgets[name] && s.max <= budgets[name] * 2)
    && (gpuPalette !== undefined) === (data.bundles.shLabel !== undefined) && paletteOk;
  return { name: "gpuDecode", ok, detail: { splats: count, wordsEqual: +(equal / (count * 8)).toFixed(5), labelsDiffer, palette, budgets, ...detail } };
}

async function checkLod(o: ValidateOptions): Promise<Check> {
  const stream = o.shown!.stream!;
  const { tree } = stream;
  const problems: string[] = [];

  if (tree.counts && tree.counts.some((count, level) => count !== tree.levelTotals[level])) {
    problems.push(`level totals ${tree.levelTotals} differ from the file's counts ${tree.counts}`);
  }

  const { objects, shown } = stream.inspect();
  let listed = 0;
  let looked = 0;
  for (const [k, object] of objects.entries()) {
    if (!object.ranges) {
      continue;
    }
    const expected: number[] = [];
    for (const leaf of object.leaves) {
      const at = leaf * tree.levels + object.level;
      if (tree.file[at] !== object.file || shown[leaf] !== object.level) {
        problems.push(`file ${object.file}: leaf ${leaf} does not show level ${object.level} from it (it shows ${shown[leaf]}; that level's file is ${tree.file[at]})`);
      }
      for (let i = 0; i < tree.count[at]; i += 1) {
        expected.push(tree.offset[at] + i);
      }
    }
    const rows = (await object.ranges.read()).bundles.ranges.channels.range.data as Uint32Array;
    const expansion = new Uint32Array(object.count);
    for (let r = 0; r < object.ranges.count; r += 1) {
      const end = r + 1 < object.ranges.count ? rows[(r + 1) * 2] : object.count;
      for (let i = rows[r * 2]; i < end; i += 1) {
        expansion[i] = rows[r * 2 + 1] + (i - rows[r * 2]);
      }
    }
    const sorted = Uint32Array.from(expected).sort();
    if (object.count !== expected.length || rows[0] !== 0 || Uint32Array.from(expansion).sort().some((value, i) => value !== sorted[i])) {
      problems.push(`file ${object.file}: range table differs from its leaves' ranges`);
    }
    if (expected.some((value) => value >= object.gpu.arrays.count)) {
      problems.push(`file ${object.file}: a range runs past its ${object.gpu.arrays.count} splats`);
    }
    listed += expected.length;

    if (k < 4) {
      const lookup = await lookupOnGpu(o.renderer, object.ranges, object.count);
      const wrong = expansion.findIndex((value, i) => lookup[i] !== value);
      if (wrong >= 0) {
        problems.push(`file ${object.file}: rangeLookup(${wrong}) = ${lookup[wrong]}, expected ${expansion[wrong]}`);
      }
      looked += object.count;
    }
  }

  const settings: LodSettings = { ...stream.settings, splatBudget: 0, budgetMode: "limit", rangeMin: 0, rangeMax: tree.levels - 1 };
  const levels = new Int8Array(tree.leaves);
  const distance = new Float32Array(tree.leaves);
  const b = tree.bounds;
  const leaf = Math.floor(tree.leaves / 2);
  const inside = { x: (b[leaf * 6] + b[leaf * 6 + 3]) / 2, y: (b[leaf * 6 + 1] + b[leaf * 6 + 4]) / 2, z: (b[leaf * 6 + 2] + b[leaf * 6 + 5]) / 2 };
  selectLevels(tree, inside, { x: 0, y: 0, z: 1 }, settings, levels, distance);
  if (levels[leaf] !== availableLevel(tree, leaf, 0)) {
    problems.push(`a camera inside leaf ${leaf} picked level ${levels[leaf]}`);
  }
  const far = { x: tree.max[0] + 1e7, y: tree.max[1], z: tree.max[2] };
  selectLevels(tree, far, { x: -1, y: 0, z: 0 }, settings, levels, distance);
  for (let l = 0; l < tree.leaves; l += 1) {
    if (levels[l] !== availableLevel(tree, l, tree.levels - 1)) {
      problems.push(`a camera far away picked level ${levels[l]} for leaf ${l}`);
      break;
    }
  }
  const front = new Int8Array(tree.leaves);
  const center = { x: (tree.min[0] + tree.max[0]) / 2, y: (tree.min[1] + tree.max[1]) / 2, z: (tree.min[2] + tree.max[2]) / 2 };
  const penalized = { ...settings, behindPenalty: 3 };
  selectLevels(tree, center, { x: 1, y: 0, z: 0 }, penalized, front, distance);
  selectLevels(tree, center, { x: -1, y: 0, z: 0 }, penalized, levels, distance);
  let behindFiner = 0;
  for (let l = 0; l < tree.leaves; l += 1) {
    const ahead = (b[l * 6] + b[l * 6 + 3]) / 2 > center.x;
    // Leaves ahead when facing +x are behind when facing -x
    if (ahead && levels[l] < front[l]) {
      behindFiner += 1;
    }
  }
  if (behindFiner > 0) {
    problems.push(`${behindFiner} leaves behind the camera got a finer level than in front`);
  }
  const selection = checkSelection(stream, center, problems);
  const underfill = checkUnderfill(stream, problems);

  return {
    name: "lod", ok: problems.length === 0,
    detail: { leaves: tree.leaves, levels: tree.levels, objects: objects.length, listed, lookedUp: looked, selection, underfill, problems: problems.slice(0, 10) },
  };
}

function checkSelection(stream: SogLodStream, center: Vec3Like, problems: string[]) {
  const { tree } = stream;
  const settings: LodSettings = { ...stream.settings, rangeMin: 0, rangeMax: tree.levels - 1 };
  const chains = levelChains(tree, 0, tree.levels - 1);
  const budget = Math.round((chains.coarsest + chains.finest) / 2);
  const forward = { x: 1, y: 0, z: 0 };
  const levels = new Int8Array(tree.leaves);
  const other = new Int8Array(tree.leaves);
  const distance = new Float32Array(tree.leaves);
  let step = 0;
  for (let i = 0; i < tree.leaves * chains.span; i += 1) {
    if (i % chains.span > 0) {
      step = Math.max(step, chains.count[i - 1] - chains.count[i]);
    }
  }

  const target = selectLevels(tree, center, forward, { ...settings, budgetMode: "target", splatBudget: budget }, levels, distance);
  if (target > budget || budget - target > Math.max(budget * 0.01, step)) {
    problems.push(`target mode selected ${target} for a budget of ${budget} (largest step ${step})`);
  }
  const extent = Math.hypot(tree.max[0] - tree.min[0], tree.max[1] - tree.min[1], tree.max[2] - tree.min[2]);
  const moved = { x: center.x + extent * 1e-3, y: center.y, z: center.z };
  selectLevels(tree, moved, forward, { ...settings, budgetMode: "target", splatBudget: budget }, other, distance);
  const flipped = levels.reduce((n, level, l) => n + (level !== other[l] ? 1 : 0), 0);
  if (flipped > Math.max(2, tree.leaves * 0.02)) {
    problems.push(`a move of ${(extent * 1e-3).toPrecision(2)} changed ${flipped} of ${tree.leaves} leaves' levels`);
  }

  const free = { ...settings, budgetMode: "limit" as const, splatBudget: 0 };
  selectLevels(tree, center, forward, free, other, distance);
  const limit = selectLevels(tree, center, forward, { ...free, splatBudget: budget }, levels, distance);
  const finer = levels.reduce((n, level, l) => n + (level < other[l] ? 1 : 0), 0);
  if (finer > 0 || (limit > budget && chains.coarsest <= budget)) {
    problems.push(`limit mode: ${finer} leaves finer than by distance, ${limit} selected for a budget of ${budget}`);
  }

  selectLevels(tree, center, forward, free, levels, distance, fovScale(60, 1.6));
  selectLevels(tree, center, forward, free, other, distance, fovScale(100, 1.6));
  const wideFiner = levels.reduce((n, level, l) => n + (other[l] < level ? 1 : 0), 0);
  if (wideFiner > 0) {
    problems.push(`${wideFiner} leaves got a finer level with a wider field of view`);
  }
  return { budget, target, limit, step, moved: flipped };
}

function checkUnderfill(stream: SogLodStream, problems: string[]) {
  const { tree, settings } = stream;
  const { shown, desired, resident } = stream.inspect();
  const levels = Math.max(0, Math.floor(settings.underfillLimit));
  let checked = 0;
  let wrong = 0;
  for (let leaf = 0; leaf < tree.leaves; leaf += 1) {
    if (desired[leaf] < 0) {
      continue;
    }
    for (let level = desired[leaf]; level <= Math.min(tree.levels - 1, desired[leaf] + levels); level += 1) {
      if (resident(leaf, level)) {
        checked += 1;
        wrong += shown[leaf] === level ? 0 : 1;
        break;
      }
    }
  }
  if (wrong > 0) {
    problems.push(`${wrong} of ${checked} leaves do not show the finest resident level in their underfill window`);
  }
  return { levels, checked };
}

const LOOKUP_BUNDLE = defineBundle({ stored: "uint32" });

async function lookupOnGpu(renderer: WebGPURenderer, ranges: GpuArrays, count: number) {
  const reader = new GpuArrayReader(RANGES_BUNDLE).bind(ranges, "ranges");
  const writer = new GpuArrayWriter({
    outputs: { out: LOOKUP_BUNDLE },
    write: (index: TslNode, out) => out.out.stored.assign(rangeLookup(reader, index)),
  });
  const result = new GpuArrays({ renderer, bundles: { out: LOOKUP_BUNDLE }, capacity: count });
  result.write(writer, { at: 0, count });
  const values = (await result.read()).bundles.out.channels.stored.data as Uint32Array;
  result.dispose();
  writer.dispose();
  return values;
}

export async function validate(o: ValidateOptions) {
  const checks: Check[] = [];
  const run = async (name: string, check: () => Promise<Check>) => {
    try {
      checks.push(await check());
    } catch (error) {
      checks.push({ name, ok: false, detail: { error: error instanceof Error ? error.message : String(error) } });
    }
  };
  if (o.shown?.stream) {
    const stream = o.shown.stream;
    stream.paused = true;
    try {
      await run("lod", () => checkLod(o));
    } finally {
      stream.paused = false;
    }
  } else if (o.shown) {
    if (o.reference) {
      await run("reference", () => checkReference(o, o.reference!));
    }
    await run("sh", () => checkSh(o));
    await run("gpuDecode", () => checkGpuDecode(o));
  }
  return { ok: checks.every((check) => check.ok), checks };
}
