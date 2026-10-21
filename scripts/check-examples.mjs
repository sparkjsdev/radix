// Checks in headless Chrome that each built example page and Spark port draws
//
//   npm run build && npm run serve
//   npm run check:examples [-- options]
//   --base <url>      the server (default http://localhost:8000, the site's http://localhost:8002)
//   --gpu <name>      webgpu | webgpu-gl (default both)
//   --only <names>    comma-separated pages, such as hello-world,splats (default all)
//   --timeout <s>     seconds a page has to get ready (default 180)
//   --shots <dir>     also write a PNG of each page's canvas there
//   --single          the single-file builds (npm run build:single) instead, without Spark ports
//   --spz <url>       the SPZ page's samples folder (default the hosted one)
/* global document, window, Image -- functions run in the page */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { EXAMPLES, pagesOf } from "../build/examples/spark/js/examples.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const REPO = "http://localhost:8000";
const base = option("--base", REPO);
const backends = option("--gpu") ? [option("--gpu")] : ["webgpu", "webgpu-gl"];
const only = option("--only")?.split(",");
const timeout = Number(option("--timeout", 180)) * 1000;
const shots = option("--shots");
if (shots) {
  mkdirSync(shots, { recursive: true });
}

const spzRoot = option("--spz");

const SPARK_READY = "window.example?.ready || window.example?.error";
const sparkPages = EXAMPLES
  .filter((example) => (example.status === "ported" || example.status === "partial") && (!only || only.includes(example.name)))
  .flatMap((example) => pagesOf(example).map((page) => ({ path: `spark/${page}`, query: example.smoke?.replace(/^\?/, "") ?? "", ready: SPARK_READY, wait: example.smokeWait })));
const radixPages = [
  { name: "splats", path: "splats/index.html", query: "", ready: "window.radixSplats?.arrays()" },
  ...["seashell-v4", "sparkling-v4", "backpack-v2", "scarf-v3"].map((sample) => ({
    name: "spz", path: "spz/index.html", query: `sample=${sample}${spzRoot ? `&spz=${spzRoot}` : ""}`, ready: "window.radixSpz?.arrays()",
  })),
  ...["multi", "views", "modifiers", "subset", "offline"].map((scene) => ({ name: "scenes", path: "scenes/index.html", query: `scene=${scene}`, ready: "window.radixScenes" })),
  { name: "xr", path: "xr/index.html", query: "", ready: "window.radixXr?.build" },
  { name: "mpm", path: "mpm/index.html", query: "", ready: "window.radixMpm?.ready", backends: ["webgpu"] },
  { name: "fxedit", path: "fxedit/index.html", query: "", ready: "window.radixFxedit?.ready" },
].filter((page) => !only || only.includes(page.name));
const pages = args.includes("--single")
  ? radixPages.map((page) => ({ ...page, path: page.path.replace(/^([^/]+)\/index\.html$/, "$1/$1.html") }))
  : [...sparkPages, ...radixPages];

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"] });
const results = [];
try {
  for (const gpu of backends) {
    for (const { path, query: search, ready, wait } of pages.filter((page) => (!page.backends || page.backends.includes(gpu)))) {
      const query = new URLSearchParams(search);
      query.set("gpu", gpu);
      const url = `${base}/build/examples/${path}?${query}`;
      const label = `${path}${search ? `?${search}` : ""}`;
      const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
      page.on("console", (message) => message.type() === "error" && errors.push(`console: ${message.text().slice(0, 300)}`));
      const start = Date.now();
      let outcome;
      try {
        await page.goto(url);
        await page.waitForFunction(ready, null, { timeout });
        const error = await page.evaluate(() => window.example?.error);
        if (error) {
          outcome = { ok: false, reason: error.split("\n")[0] };
        } else {
          // WebGL2's CPU sort and reveals that start blank take a few more frames
          await page.waitForTimeout(wait ?? 1500);
          await page.evaluate(() => document.querySelectorAll("body > :not(canvas)").forEach((element) => (element.style.visibility = "hidden")));
          const png = await page.locator("canvas").first().screenshot();
          if (shots) {
            writeFileSync(join(shots, `${label.replace(/^spark\//, "").replace(/\/$|\/\?/g, "").replace(/[/.?=]/g, "_")}-${gpu}.png`), png);
          }
          const spread = await page.evaluate(async (b64) => {
            const image = new Image();
            image.src = `data:image/png;base64,${b64}`;
            await image.decode();
            const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            const { data } = context.getImageData(0, 0, image.width, image.height);
            let sum = 0;
            let sumSquares = 0;
            const n = data.length / 4;
            for (let i = 0; i < data.length; i += 4) {
              const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
              sum += y;
              sumSquares += y * y;
            }
            return Math.sqrt(Math.max(0, sumSquares / n - (sum / n) ** 2));
          }, png.toString("base64"));
          outcome = spread > 2 ? { ok: true, reason: `luma spread ${spread.toFixed(1)}` } : { ok: false, reason: `blank canvas (luma spread ${spread.toFixed(2)})` };
        }
      } catch (error) {
        outcome = { ok: false, reason: error.message.split("\n")[0] };
      }
      const seconds = ((Date.now() - start) / 1000).toFixed(1);
      results.push({ gpu, path: label, ...outcome, errors });
      console.log(`${outcome.ok ? "ok  " : "FAIL"} ${gpu.padEnd(9)} ${label.padEnd(38)} ${seconds}s  ${outcome.reason}`);
      errors.slice(0, 5).forEach((line) => console.log(`       ${line}`));
      await page.close();
    }
  }
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} pages drew`);
process.exit(failed.length > 0 ? 1 : 0);
