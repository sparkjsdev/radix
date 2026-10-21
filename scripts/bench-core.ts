// Times src/core in Node: decoding into each layout, encoding with each writer, sorting keys
//
//   npm run bench:core [-- options]
//   --file <path>   a splat file, repeatable (default the samples in CORPUS)
//   --only <part>   load | sort (default both)
//   --rounds <n>    timed sort rounds (default 15)
//   --json <path>   also write the results as JSON
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  SortKeys, SplatFiles, Splats, type ArrayData, type ProgressStage, type SortKeyBits, type SplatFormat, type SplatLayout, type Vec3,
} from "../src/core";

// Local copies of the hosted samples (scripts/data.mjs); splats/ is gitignored
const CORPUS = [
  "splats/butterfly-ai.rdx",
  "splats/ceramic.rdx",
  "splats/sutro-2m.rdx",
  "splats/grace-interior-10m.rdx",
].filter((file) => existsSync(file));
// readFileSync's limit
const MAX_FILE = 2 ** 31 - 1;

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const files = args.flatMap((arg, i) => (args[i - 1] === "--file" ? [arg] : []));
const only = option("--only");
const rounds = Number(option("--rounds") ?? 15);
const jsonPath = option("--json");
const results: Record<string, unknown[]> = { load: [], encode: [], sort: [], quality: [] };

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function table(title: string, header: string[], rows: (string | number)[][]) {
  console.log(`\n${title}\n`);
  console.log(`| ${header.join(" | ")} |`);
  console.log(`|${header.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`);
  for (const row of rows) {
    console.log(`| ${row.join(" | ")} |`);
  }
}

const fixed = (value: number, digits = 1) => value.toFixed(digits);
const short = (file: string) => file.split("/").pop()!.replace(/^fb1e7c73-a486-4247-adde-0bff9865d16d_/, "");

// A stage's time runs from its first progress report to the next stage's
async function timedDecode(bytes: Uint8Array<ArrayBuffer>, name: string, layout: SplatLayout) {
  const stages: Partial<Record<ProgressStage, number>> = {};
  let stage: ProgressStage | undefined;
  let stageStart = performance.now();
  const start = stageStart;
  const { splats: data } = await SplatFiles.decode(bytes, {
    name, layout,
    progress: (_, next) => {
      if (next !== stage) {
        const now = performance.now();
        if (stage) {
          stages[stage] = (stages[stage] ?? 0) + now - stageStart;
        }
        stage = next;
        stageStart = now;
      }
    },
  });
  const end = performance.now();
  if (stage) {
    stages[stage] = (stages[stage] ?? 0) + end - stageStart;
  }
  return { data, ms: end - start, stages };
}

async function benchLoad(file: string) {
  const size = statSync(file).size;
  if (size > MAX_FILE) {
    console.log(`\n${file}: ${(size / 2 ** 30).toFixed(1)} GiB, past readFileSync's 2 GiB (skipped)`);
    return undefined;
  }
  const readStart = performance.now();
  const bytes = new Uint8Array(readFileSync(file)) as Uint8Array<ArrayBuffer>;
  const readMs = performance.now() - readStart;
  const format = SplatFiles.detectFormat(bytes, file);

  const rows: (string | number)[][] = [];
  let ext: ArrayData | undefined;
  for (const layout of ["extSplats", "packedSplats", "covSplats"] as const) {
    // Large files: one run, the default layout only
    const runs = size > 4e8 ? (layout === "extSplats" ? 1 : 0) : size > 1e8 ? 1 : 3;
    const times: number[] = [];
    let stages: Partial<Record<ProgressStage, number>> = {};
    let count = 0;
    for (let run = 0; run < runs; run += 1) {
      const result = await timedDecode(bytes, file, layout);
      times.push(result.ms);
      stages = result.stages;
      count = result.data.count;
      if (layout === "extSplats") {
        ext = result.data;
      }
    }
    if (runs === 0) {
      continue;
    }
    const ms = median(times);
    const stageText = Object.entries(stages).map(([name, value]) => `${name} ${fixed(value!, 0)}`).join(", ");
    rows.push([short(file), format, layout, count.toLocaleString(), fixed(ms, 0), fixed(count / ms / 1000, 1), fixed(size / ms / 1000, 0), stageText]);
    results.load.push({ file, format, layout, count, bytes: size, ms, stages, readMs });
  }
  table(`Decode ${file} (${(size / 2 ** 20).toFixed(0)} MiB, read ${fixed(readMs, 0)} ms)`,
    ["file", "format", "layout", "splats", "ms", "M splats/s", "MB/s", "stages (ms)"], rows);
  return ext;
}

async function benchEncode(file: string, data: ArrayData) {
  const rows: (string | number)[][] = [];
  const writers: { label: string; format: SplatFormat; options?: Record<string, unknown> }[] = [
    { label: "ply", format: "ply" },
    { label: "compressed ply", format: "compressed-ply" },
    { label: "spz v3", format: "spz", options: { version: 3 } },
    { label: "spz v2", format: "spz", options: { version: 2 } },
    { label: "rad", format: "rad" },
    { label: "rdx", format: "rdx" },
  ];
  for (const { label, format, options } of writers) {
    const start = performance.now();
    const bytes = await SplatFiles.encode(data, format, options);
    const encodeMs = performance.now() - start;
    const decoded = await timedDecode(bytes, `x.${format}`, "extSplats");
    rows.push([label, (bytes.byteLength / 2 ** 20).toFixed(1), fixed(encodeMs, 0), fixed(data.count / encodeMs / 1000, 2), fixed(decoded.ms, 0), fixed(data.count / decoded.ms / 1000, 1)]);
    results.encode.push({ file, writer: label, bytes: bytes.byteLength, encodeMs, decodeMs: decoded.ms, count: data.count });
  }
  table(`Encode ${short(file)} (${data.count.toLocaleString()} splats), then decode the result to extSplats`,
    ["writer", "MiB", "encode ms", "M splats/s", "decode ms", "M splats/s"], rows);
}

// In float32, as the GPU computes them
function distancesOf(data: ArrayData) {
  const { bundle } = Splats.get(data);
  const count = data.count;
  const centers = new Float32Array(count * 3);
  const c: Vec3 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < count; i += 1) {
    Splats.loadCenter(bundle, i, c);
    centers[i * 3] = c.x;
    centers[i * 3 + 1] = c.y;
    centers[i * 3 + 2] = c.z;
  }
  const step = Math.max(1, Math.floor(count / 100000));
  const lo: number[] = [];
  const hi: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const sample: number[] = [];
    for (let i = 0; i < count; i += step) {
      sample.push(centers[i * 3 + axis]);
    }
    sample.sort((a, b) => a - b);
    lo.push(sample[Math.floor(sample.length * 0.05)]);
    hi.push(sample[Math.floor(sample.length * 0.95)]);
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const camera = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2] + 1.5 * extent];
  const distances = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const x = centers[i * 3] - camera[0];
    const y = centers[i * 3 + 1] - camera[1];
    const z = centers[i * 3 + 2] - camera[2];
    distances[i] = Math.sqrt(x * x + y * y + z * z);
  }
  return distances;
}

type SortFn = (keys: Uint32Array, count: number, ordering: Uint32Array) => number;

// Two LSD passes over digits of lo and hi bits, each key read once per pass
function makeTwoPass(loBits: number, hiBits: number, capacity: number): SortFn {
  const loMask = 2 ** loBits - 1;
  const hiMask = 2 ** hiBits - 1;
  const hLo = new Uint32Array(loMask + 1);
  const hHi = new Uint32Array(hiMask + 1);
  const index = new Uint32Array(capacity);
  const digit = hiBits <= 16 ? new Uint16Array(capacity) : new Uint32Array(capacity);
  return new Function("hLo", "hHi", "index", "digit", `
    return function sort(keys, count, ordering) {
      hLo.fill(0); hHi.fill(0);
      for (let i = 0; i < count; ++i) { const k = keys[i]; hLo[k & ${loMask}]++; hHi[(k >>> ${loBits}) & ${hiMask}]++; }
      const visible = count - hHi[${hiMask}];
      let sum = 0; for (let d = 0; d <= ${loMask}; ++d) { const n = hLo[d]; hLo[d] = sum; sum += n; }
      sum = 0; for (let d = 0; d <= ${hiMask}; ++d) { const n = hHi[d]; hHi[d] = sum; sum += n; }
      for (let i = 0; i < count; ++i) { const k = keys[i]; const p = hLo[k & ${loMask}]++; index[p] = i; digit[p] = (k >>> ${loBits}) & ${hiMask}; }
      for (let j = 0; j < count; ++j) { ordering[hHi[digit[j]]++] = index[j]; }
      return visible;
    };`)(hLo, hHi, index, digit) as SortFn;
}

// Three LSD passes of 8 bits (24-bit keys): smaller histograms, one more pass
function makeThreePass8(capacity: number): SortFn {
  const h0 = new Uint32Array(256);
  const h1 = new Uint32Array(256);
  const h2 = new Uint32Array(256);
  const indexA = new Uint32Array(capacity);
  const indexB = new Uint32Array(capacity);
  const restA = new Uint16Array(capacity);
  const restB = new Uint8Array(capacity);
  return (keys, count, ordering) => {
    h0.fill(0);
    h1.fill(0);
    h2.fill(0);
    for (let i = 0; i < count; i += 1) {
      const k = keys[i];
      h0[k & 0xff] += 1;
      h1[(k >>> 8) & 0xff] += 1;
      h2[(k >>> 16) & 0xff] += 1;
    }
    const visible = count - h2[0xff];
    for (const h of [h0, h1, h2]) {
      let sum = 0;
      for (let d = 0; d < 256; d += 1) {
        const n = h[d];
        h[d] = sum;
        sum += n;
      }
    }
    for (let i = 0; i < count; i += 1) {
      const k = keys[i];
      const p = h0[k & 0xff]++;
      indexA[p] = i;
      restA[p] = k >>> 8;
    }
    for (let j = 0; j < count; j += 1) {
      const r = restA[j];
      const p = h1[r & 0xff]++;
      indexB[p] = indexA[j];
      restB[p] = r >>> 8;
    }
    for (let j = 0; j < count; j += 1) {
      ordering[h2[restB[j]]++] = indexB[j];
    }
    return visible;
  };
}

function benchSort(file: string, data: ArrayData) {
  const count = data.count;
  const distances = distancesOf(data);
  const keys = {} as Record<SortKeyBits, Uint32Array>;
  for (const bits of [16, 24, 32] as const) {
    keys[bits] = Uint32Array.from(distances, (d) => SortKeys.compute(d, bits));
  }

  const variants: { label: string; bits: SortKeyBits; run: SortFn }[] = [];
  for (const bits of [16, 24, 32] as const) {
    variants.push({ label: `SortKeys.sort ${bits}`, bits, run: (k, n, o) => SortKeys.sort({ keys: k, count: n, bits, ordering: o }).visible });
  }
  variants.push({ label: "24: 2x12, one read", bits: 24, run: makeTwoPass(12, 12, count) });
  variants.push({ label: "24: 3x8", bits: 24, run: makeThreePass8(count) });
  variants.push({ label: "24: 11+13", bits: 24, run: makeTwoPass(11, 13, count) });
  variants.push({ label: "32: 2x16, one read", bits: 32, run: makeTwoPass(16, 16, count) });

  // Every variant's order equals SortKeys.sort's
  const reference = {} as Record<SortKeyBits, Uint32Array>;
  const orderings = variants.map(() => new Uint32Array(count));
  const status = variants.map(({ bits, run }, v) => {
    const visible = run(keys[bits], count, orderings[v]);
    reference[bits] ??= orderings[v].slice();
    const expected = reference[bits];
    for (let i = 0; i < visible; i += 1) {
      if (orderings[v][i] !== expected[i]) {
        return `MISMATCH at ${i}`;
      }
    }
    return "ok";
  });

  const times = variants.map(() => [] as number[]);
  const warmup = 3;
  for (let round = 0; round < warmup + rounds; round += 1) {
    for (let k = 0; k < variants.length; k += 1) {
      const v = (k + round) % variants.length;
      const start = performance.now();
      variants[v].run(keys[variants[v].bits], count, orderings[v]);
      if (round >= warmup) {
        times[v].push(performance.now() - start);
      }
    }
  }
  const rows = variants.map(({ label, bits }, v) => {
    const ms = median(times[v]);
    results.sort.push({ file, count, variant: label, bits, ms, status: status[v] });
    return [label, fixed(ms, 2), fixed(count / ms / 1000, 0), status[v]];
  });
  table(`Sort ${short(file)} (${count.toLocaleString()} splats, median of ${rounds})`, ["variant", "ms", "M keys/s", "order"], rows);

  // Neighbours in each width's order whose distances run front to back
  const qualityRows = ([32, 24, 16] as const).map((bits) => {
    const order = reference[bits];
    let inverted = 0;
    let gapMax = 0;
    for (let i = 0; i + 1 < count; i += 1) {
      const far = distances[order[i]];
      const near = distances[order[i + 1]];
      if (far < near) {
        inverted += 1;
        gapMax = Math.max(gapMax, (near - far) / near);
      }
    }
    results.quality.push({ file, bits, inverted: inverted / count, gapMax });
    return [`${bits}`, `${fixed((inverted / count) * 100, 1)}%`, gapMax.toExponential(1)];
  });
  table(`Order quality ${short(file)}`, ["bits", "neighbours out of order", "max relative gap"], qualityRows);
}

if (files.length === 0 && CORPUS.length === 0) {
  throw new Error("No splat files: pass --file <path>, or put the samples in splats/ (see CORPUS)");
}

for (const file of files.length > 0 ? files : CORPUS) {
  let data: ArrayData | undefined;
  if (only !== "sort") {
    data = await benchLoad(file);
    if (data && data.count <= 2_100_000) {
      await benchEncode(file, data);
    }
  } else if (statSync(file).size <= MAX_FILE) {
    data = (await SplatFiles.decode(new Uint8Array(readFileSync(file)) as Uint8Array<ArrayBuffer>, { name: file })).splats;
  }
  if (data && only !== "load") {
    benchSort(file, data);
  }
}

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ date: new Date().toISOString(), node: process.version, results }, null, 2));
  console.log(`\nWrote ${jsonPath}`);
}
