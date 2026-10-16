// Runs the benchmark page (test/bench/, built into build/test/bench/) in
// headless Chrome over a matrix of configs and writes the results:
// recordings/bench/<label>.json, one PNG per config in
// recordings/bench/<label>/, and a markdown table. Needs npm run build:test
// and npm run serve (the page, --base). The scans load from the hosted
// samples (scripts/data.mjs); the Coit matrices and --matrix sh read local
// files from --splats (<base>/splats/).
//
//   node scripts/bench.mjs [--matrix baseline] [--only <regex>]
//     [--label name] [--compare <label>] [--frames 90] [--headed]
//
//   node scripts/bench.mjs --matrix sh [--file splats/sutro_2m.ply] [--gpu webgpu | webgpu-gl] [--frames 60] [--rounds 3]
//     (radixBench.shBench: the projection with and without spherical
//     harmonics, per splat and through palettes, for one SH3 file)
//
// --compare reports each screenshot's PSNR and largest channel difference
// against the same config in another run. GPU times are timestamp queries
// (WebGPU developer features on: not quantized); wall times wait for the
// GPU after every frame.
/* global window, createImageBitmap, OffscreenCanvas -- functions run in the page */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { RADIX_DATA_URL } from "./data.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const base = option("--base", "http://localhost:8000");
const splatsBase = option("--splats", "http://localhost:8000");
const samples = `${RADIX_DATA_URL}rdx/`;
const matrixName = option("--matrix", "baseline");
const only = option("--only") ? new RegExp(option("--only")) : undefined;
const label = option("--label", `${matrixName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
const compare = option("--compare");
const frames = Number(option("--frames", 180));
const outDir = path.resolve("recordings/bench");

// The files, each with the still view it is measured from (world space,
// after the flip) and how the path moves: "object" orbits the target,
// "scene" looks all around from the camera's place
const FILES = {
  butterfly: { url: `${samples}butterfly-ai.rdx`, kind: "object" },
  // In the middle of the cave, looking along it
  ceramic: { url: `${samples}ceramic.rdx`, kind: "scene", view: { position: [0, 0.6, -2.4], target: [0, 0.5, -5] } },
  // At the tower's foot; the bike by the bench, orbited as it was captured
  sutro: { url: `${samples}sutro-2m.rdx`, kind: "scene", view: { position: [0, 1.5, -1.2], target: [0, 1.5, 0] } },
  bicycle: { url: `${samples}bicycle.rdx`, kind: "object", up: [-0.015, 0.97, 0.244], view: { position: [-3.5, 0.9, 0], target: [0, -0.7, 0] } },
  // In the middle of the nave, about 2.5 above the floor, looking along it
  grace: { url: `${samples}grace-interior-10m.rdx`, kind: "scene", view: { position: [-14, 8, -3], target: [-4, 8, -3] } },
  // Coit Tower, 39M splats: npm run convert:ply -- splats/coit-40m-sh0.ply splats/coit-40m.rdx
  // (an aerial capture, flat: seen from above at an angle, orbiting the middle)
  coit40: { url: `${splatsBase}/splats/coit-40m.rdx`, kind: "object", layout: "packedSplats", view: { position: [0, 1.1, 2.2], target: [0, -0.05, 0.1] } },
  // 92M splats, the same place: past the 256 MiB storage binding baseline
  coit100: { url: `${splatsBase}/splats/coit-100m.rdx`, kind: "object", layout: "packedSplats", view: { position: [0, 1.1, 2.2], target: [0, -0.05, 0.1] } },
};

// Name, backend and config of every run
function matrix(name) {
  const runs = [];
  const add = (file, backend, config, query = "") => {
    const { url, ...preset } = FILES[file];
    const c = { url, frames, ...preset, ...config };
    const parts = [file, backend === "webgpu" ? "wgpu" : "gl", c.mode, c.method ?? "ewa", `${c.bits ?? 24}b`];
    if (c.layout && c.layout !== "extSplats") {
      parts.push(c.layout.replace("Splats", ""));
    }
    if (c.ratio && c.ratio !== 1) {
      parts.push(`x${c.ratio}`);
    }
    if (c.tag) {
      parts.push(c.tag);
    }
    delete c.tag;
    runs.push({ name: parts.join("-"), backend, query, config: c });
  };
  const files = ["butterfly", "ceramic", "sutro", "bicycle", "grace"];
  if (name === "baseline") {
    for (const file of files) {
      for (const bits of [16, 24, 32]) {
        add(file, "webgpu", { mode: "gpu", bits });
        add(file, "webgpu-gl", { mode: "cpu", bits });
      }
      for (const method of ["3dgut", "htgs", "raygs"]) {
        add(file, "webgpu", { mode: "gpu", method });
        add(file, "webgpu-gl", { mode: "cpu", method });
      }
      add(file, "webgpu", { mode: "gpu", layout: "packedSplats" });
      add(file, "webgpu", { mode: "gpu", layout: "covSplats" });
      add(file, "webgpu", { mode: "cpu" });
    }
  } else if (name === "quick") {
    for (const file of ["butterfly", "ceramic"]) {
      add(file, "webgpu", { mode: "gpu" });
      add(file, "webgpu-gl", { mode: "cpu" });
    }
  } else if (name === "default") {
    for (const file of files) {
      add(file, "webgpu", { mode: "gpu" });
      add(file, "webgpu-gl", { mode: "cpu" });
    }
  } else if (name === "methods") {
    for (const file of files) {
      for (const method of ["ewa", "3dgut", "htgs", "raygs"]) {
        add(file, "webgpu", { mode: "gpu", method });
      }
    }
  } else if (name === "overdraw") {
    for (const file of files) {
      for (const method of ["ewa", "3dgut", "htgs", "raygs"]) {
        add(file, "webgpu", { mode: "gpu", method, overdraw: true, frames: 15 });
      }
    }
  } else if (name === "coit100") {
    add("coit100", "webgpu", { mode: "gpu", frames: 9 });
    add("coit100", "webgpu", { mode: "gpu", frames: 30, tag: "adapter-limits" }, "&limits=adapter");
    add("coit100", "webgpu-gl", { mode: "cpu", frames: 9 });
  } else if (name === "coit") {
    for (const bits of [16, 24, 32]) {
      add("coit40", "webgpu", { mode: "gpu", bits });
    }
    add("coit40", "webgpu", { mode: "gpu", method: "3dgut" });
    add("coit40", "webgpu-gl", { mode: "cpu", params: { sortGuard: 0.5 }, tag: "guard0.5" });
  } else if (name === "guard") {
    for (const file of files) {
      for (const sortGuard of [0, 0.5, 0.25]) {
        add(file, "webgpu-gl", { mode: "cpu", params: { sortGuard }, tag: `guard${sortGuard}` });
      }
    }
  } else if (name === "project") {
    for (const file of ["ceramic", "bicycle", "grace"]) {
      for (const layout of ["extSplats", "packedSplats", "covSplats"]) {
        for (const method of ["ewa", "3dgut"]) {
          add(file, "webgpu", { mode: "gpu", layout, method, frames: 30 });
        }
      }
    }
  } else if (name === "debugdraw") {
    for (const file of files) {
      for (const debugDraw of [undefined, "flat", "empty"]) {
        add(file, "webgpu", { mode: "gpu", ...(debugDraw ? { debugDraw, tag: debugDraw } : {}) });
      }
    }
  } else if (name === "minpx") {
    for (const file of files) {
      for (const minPixelRadius of [0, 0.35, 0.5, 1]) {
        add(file, "webgpu", { mode: "gpu", params: { minPixelRadius }, tag: `minpx${minPixelRadius}` });
      }
    }
  } else if (name === "ratio") {
    for (const file of files) {
      for (const ratio of [1, 2]) {
        add(file, "webgpu", { mode: "gpu", ratio, size: [1280, 720] });
      }
    }
  } else {
    throw new Error(`Unknown matrix ${name}`);
  }
  return only ? runs.filter((run) => only.test(run.name)) : runs;
}

const fmt = (value, digits = 2) => (value === undefined || value === null || Number.isNaN(value) ? "" : Number(value).toFixed(digits));

// --matrix sort: radixBench.sortBench, the GPU sort alone
async function sortMain() {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--enable-webgpu-developer-features"] });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/build/test/bench/index.html?gpu=webgpu`);
    await page.waitForFunction(() => "radixBench" in window, null, { timeout: 60000 });
    const counts = option("--counts") ? option("--counts").split(",").map(Number) : undefined;
    const rows = await page.evaluate((options) => window.radixBench.sortBench(options), { counts, valid: Number(option("--valid", 0.9)) });
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, `${label}.json`), JSON.stringify({ label, date: new Date().toISOString(), rows }, null, 2));
    const lines = ["| splats | bits | wall ms | compact | radix | args | GPU total |", "|---:|---:|---:|---:|---:|---:|---:|"];
    for (const r of rows) {
      lines.push(`| ${(r.count / 1e6).toFixed(1)}M | ${r.bits} | ${fmt(r.wallMs)} | ${fmt(r.gpu.compact)} | ${fmt(r.gpu.radix)} | ${fmt(r.gpu.args)} | ${fmt(r.gpu.total)} |`);
    }
    const table = `${lines.join("\n")}\n`;
    await writeFile(path.join(outDir, `${label}.md`), table);
    console.log(table);
  } finally {
    await browser.close();
  }
}

// --matrix sh: radixBench.shBench, the cost of SH per encoding
async function shMain() {
  const gpu = option("--gpu", "webgpu");
  const file = option("--file", "splats/sutro_2m.ply");
  const browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--disable-gpu-vsync", "--disable-frame-rate-limit", "--js-flags=--max-old-space-size=16384"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/build/test/bench/index.html?gpu=${gpu}`);
    await page.waitForFunction(() => "radixBench" in window, null, { timeout: 60000 });
    const result = await page.evaluate((options) => window.radixBench.shBench(options), { url: `${splatsBase}/${file}`, frames: Number(option("--frames", 60)), rounds: Number(option("--rounds", 3)) });
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, `${label}.json`), JSON.stringify({ label, date: new Date().toISOString(), ...result }, null, 2));
    const none = result.rows[0];
    const lines = [
      `${file}: ${(result.splats / 1e6).toFixed(2)}M splats, SH${result.degree}, ${result.backend}${result.timestamps ? "" : " (no timestamps)"}`, "",
      "| variant | project GPU ms | vs none | draw GPU ms | wall ms |", "|---|---:|---:|---:|---:|",
    ];
    for (const r of result.rows) {
      lines.push(`| ${r.name} | ${fmt(r.project)} | ${fmt(r.project - none.project)} | ${fmt(r.draw)} | ${fmt(r.wallMs)} |`);
    }
    const table = `${lines.join("\n")}\n`;
    await writeFile(path.join(outDir, `${label}.md`), table);
    console.log(table);
  } finally {
    await browser.close();
  }
}

async function main() {
  if (matrixName === "sort") {
    return sortMain();
  }
  if (matrixName === "sh") {
    return shMain();
  }
  const runs = matrix(matrixName);
  await mkdir(path.join(outDir, label), { recursive: true });
  const browser = await chromium.launch({
    channel: "chrome",
    headless: !args.includes("--headed"),
    args: ["--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--disable-gpu-vsync", "--disable-frame-rate-limit", "--js-flags=--max-old-space-size=16384"],
  });
  const results = [];
  const pages = new Map();
  try {
    for (const run of runs) {
      const key = `${run.backend}${run.query}`;
      let page = pages.get(key);
      if (!page) {
        page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.on("pageerror", (error) => console.log(`  page error: ${error.message}`));
        page.on("console", (message) => message.type() === "error" && console.log(`  console: ${message.text().slice(0, 300)}`));
        await page.goto(`${base}/build/test/bench/index.html?gpu=${run.backend}${run.query}`);
        await page.waitForFunction(() => "radixBench" in window, null, { timeout: 60000 });
        pages.set(key, page);
      }
      process.stdout.write(`${run.name} ... `);
      try {
        const result = await page.evaluate((config) => window.radixBench.run(config), run.config);
        const size = run.config.size ?? [1920, 1080];
        const shot = path.join(outDir, label, `${run.name}.png`);
        await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: Math.min(1920, size[0]), height: Math.min(1080, size[1]) } });
        const entry = { name: run.name, backend: run.backend, ...result, screenshot: path.relative(outDir, shot) };
        if (compare) {
          entry.compare = await compareImages(page, path.join(outDir, compare, `${run.name}.png`), shot);
        }
        results.push(entry);
        const p = result.parts;
        console.log(`wall ${p.map((part) => fmt(part.wallMs)).join(" / ")} ms, gpu ${p.map((part) => fmt(part.gpu.total)).join(" / ")} ms`);
      } catch (error) {
        console.log(`FAILED: ${error.message.split("\n")[0]}`);
        results.push({ name: run.name, backend: run.backend, config: run.config, error: error.message });
        // A crashed page (out of memory, device lost) is replaced for the next run
        await page.close().catch(() => {});
        pages.delete(key);
      }
      await writeFile(path.join(outDir, `${label}.json`), JSON.stringify({ label, date: new Date().toISOString(), results }, null, 2));
    }
  } finally {
    await browser.close();
  }
  const table = report(results);
  await writeFile(path.join(outDir, `${label}.md`), table);
  console.log(`\n${table}\nWrote recordings/bench/${label}.json, .md and ${label}/*.png`);
}

// PSNR and the largest channel difference of two PNGs, in the page
async function compareImages(page, before, after) {
  let a;
  try {
    a = await readFile(before);
  } catch {
    return undefined;
  }
  const b = await readFile(after);
  return page.evaluate(async ([a64, b64]) => {
    const pixels = async (b64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [pa, pb] = await Promise.all([pixels(a64), pixels(b64)]);
    if (pa.length !== pb.length) {
      return { psnr: 0, maxDiff: 255 };
    }
    let sum = 0;
    let maxDiff = 0;
    for (let i = 0; i < pa.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const d = pa[i + c] - pb[i + c];
        sum += d * d;
        maxDiff = Math.max(maxDiff, Math.abs(d));
      }
    }
    const mse = sum / ((pa.length / 4) * 3);
    return { psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), maxDiff };
  }, [a.toString("base64"), b.toString("base64")]);
}

function report(results) {
  const lines = [
    "| run | splats | wall still / level / tilted ms | GPU tilted: project | compact | radix | draw | total ms | cpu sort: read + sort + upload ms, lag frames | load s | PSNR | fragments / pixel (covered) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.name} | | FAILED: ${r.error.split("\n")[0].slice(0, 80)} | | | | | | | | | |`);
      continue;
    }
    const overdraw = r.overdraw ? `${fmt(r.overdraw.perPixel, 1)} (${fmt(r.overdraw.perCoveredPixel, 1)})` : "";
    const tilted = r.parts[2];
    const g = tilted.gpu;
    const cpuSort = tilted.sorts ? `${fmt(tilted.readMs, 1)} + ${fmt(tilted.sortMs, 1)} + ${fmt(tilted.uploadMs, 1)}, ${fmt(tilted.latencyFrames, 1)} (${tilted.sorts} sorts)` : "";
    const psnr = r.compare ? `${fmt(r.compare.psnr, 1)} (${r.compare.maxDiff})` : "";
    lines.push(`| ${r.name} | ${(r.splats / 1e6).toFixed(2)}M | ${r.parts.map((p) => fmt(p.wallMs)).join(" / ")} | ${fmt(g.project)} | ${fmt(g.compact)} | ${fmt(g.radix)} | ${fmt(g.draw)} | ${fmt(g.total)} | ${cpuSort} | ${fmt(r.load.loadMs / 1000, 1)} | ${psnr} | ${overdraw} |`);
  }
  return `${lines.join("\n")}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
