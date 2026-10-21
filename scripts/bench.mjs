// Times the benchmark page (test/bench/) in headless Chrome, with WebGPU
// developer features on so that GPU timestamps are not quantized
//
//   npm run build:test && npm run serve
//   npm run bench [-- options]
//   --base <url>        the server (default http://localhost:8000)
//   --label <name>      the results' name in recordings/bench/ (default <matrix>-<date and time>)
//   --matrix <name>     baseline (default) | quick | default | methods |
//                       overdraw | guard | project | debugdraw | minpx | ratio
//   --only <regex>      the runs whose names match (default all)
//   --frames <n>        frames per run (default 180)
//   --compare <label>   each screenshot's PSNR and largest channel difference against that run's
//   --headed            a visible browser
//   --matrix sort       the GPU sort alone, with
//     --counts <n,...>  splat counts (default the page's)
//     --valid <f>       the fraction of valid keys (default 0.9)
//   --matrix sh         the cost of SH per encoding, with
//     --gpu <name>      webgpu (default) | webgpu-gl
//     --frames <n>      frames per variant (default 60)
//     --rounds <n>      passes over all variants (default 3)
/* global window, createImageBitmap, OffscreenCanvas -- functions run in the page */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { RADIX_DATA_URL, radixUrl } from "./data.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const base = option("--base", "http://localhost:8000");
const samples = `${RADIX_DATA_URL}rdx/`;
const matrixName = option("--matrix", "baseline");
const only = option("--only") ? new RegExp(option("--only")) : undefined;
const label = option("--label", `${matrixName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
const compare = option("--compare");
const frames = Number(option("--frames", 180));
const outDir = path.resolve("recordings/bench");

// Still views are in world space, after the flip. An "object" path orbits the
// target, a "scene" path looks all around from the camera.
const FILES = {
  butterfly: { url: `${samples}butterfly-ai.rdx`, kind: "object" },
  // In the middle of the cave, looking along it
  ceramic: { url: `${samples}ceramic.rdx`, kind: "scene", view: { position: [0, 0.6, -2.4], target: [0, 0.5, -5] } },
  // At the tower's foot
  sutro: { url: `${samples}sutro-2m.rdx`, kind: "scene", view: { position: [0, 1.5, -1.2], target: [0, 1.5, 0] } },
  // In the middle of the nave, about 2.5 above the floor, looking along it
  grace: { url: `${samples}grace-interior-10m.rdx`, kind: "scene", view: { position: [-14, 8, -3], target: [-4, 8, -3] } },
};

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
  const files = ["butterfly", "ceramic", "sutro", "grace"];
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
  } else if (name === "guard") {
    for (const file of files) {
      for (const sortGuard of [0, 0.5, 0.25]) {
        add(file, "webgpu-gl", { mode: "cpu", params: { sortGuard }, tag: `guard${sortGuard}` });
      }
    }
  } else if (name === "project") {
    for (const file of ["ceramic", "grace"]) {
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

async function shMain() {
  const gpu = option("--gpu", "webgpu");
  const url = `${radixUrl("rdx-sh")}sutro-2m.rdx`;
  const browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--disable-gpu-vsync", "--disable-frame-rate-limit", "--js-flags=--max-old-space-size=16384"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/build/test/bench/index.html?gpu=${gpu}`);
    await page.waitForFunction(() => "radixBench" in window, null, { timeout: 60000 });
    const result = await page.evaluate((options) => window.radixBench.shBench(options), { url, frames: Number(option("--frames", 60)), rounds: Number(option("--rounds", 3)) });
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, `${label}.json`), JSON.stringify({ label, date: new Date().toISOString(), ...result }, null, 2));
    const none = result.rows[0];
    const lines = [
      `sutro-2m.rdx: ${(result.splats / 1e6).toFixed(2)}M splats, SH${result.degree}, ${result.backend}${result.timestamps ? "" : " (no timestamps)"}`, "",
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
