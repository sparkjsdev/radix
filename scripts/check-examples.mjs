// Loads every ported Spark example (examples/spark/js/examples.ts)
// and the other example pages (examples/{splats,scenes,xr,...}),
// as built into build/examples/, in headless Chrome on both backends
// and checks that each one draws: the page says it is ready (Spark ports:
// window.example.ready or .error, js/page.ts; the others: their console
// handle once the splats are loaded), throws nothing, and its canvas is not
// one flat color. Pages that need WebGPU run on it alone. Every page reads
// its data from GCS (scripts/data.mjs). Needs the library and pages
// built and the repo served:
//
//   npm run build && npm run serve
//   node scripts/check-examples.mjs [--base http://localhost:8000]
//     (the static site: npm run build:site && npm run serve:site,
//     then --base http://localhost:8002)
//     [--gpu webgpu | webgpu-gl] [--only hello-world,glsl,splats] [--timeout 180]
//     [--shots dir]   (a PNG of each page's canvas)
//     [--single]      (the other pages' single-file builds, <name>/<name>.html:
//                     npm run build:single; no Spark ports)
//     [--lcc url]     (the LCC pages' samples from elsewhere; LCC2 ones
//                     from its lcc2/ sibling)
//     [--spz url]     (the SPZ page's samples from elsewhere)
/* global document, window, Image, requestAnimationFrame -- functions run in the page */
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

const lccRoot = option("--lcc");
const spzRoot = option("--spz");

// The LCC walk page, once its scene shows: the walker stands on the ground
// with the eye at its height, and driven 2 m/s toward the nearest wall
// around it stops in front of it (its knee and chest spheres never sink
// into the mesh)
async function checkWalk() {
  const v = window.radixLcc;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 300 && v.walker.state !== "grounded"; i += 1) {
    await wait(100);
  }
  const w = v.walker;
  const c = v.collision();
  if (w.state !== "grounded" || !c) {
    return { ok: false, reason: `walker ${w.state}, collision ${c ? "loaded" : "none"}` };
  }
  const Vector3 = v.camera.position.constructor;
  const scale = v.model.scale.x;
  const toFile = v.model.matrixWorld.clone().invert();
  const eye = v.camera.position.clone().applyMatrix4(toFile);
  const ground = c.set.raycast(eye, w.up.clone().negate(), 100 / scale);
  const height = ground ? ground.t * scale : Infinity;
  if (Math.abs(height - w.settings.eyeHeight) > 0.05) {
    return { ok: false, reason: `eye ${height.toFixed(3)} above the ground, not ${w.settings.eyeHeight}` };
  }
  const radius = w.settings.radius / scale;
  const knee = (w.settings.stepHeight + w.settings.radius) / scale;
  let wall;
  for (let k = 0; k < 16; k += 1) {
    const a = (k / 16) * Math.PI * 2;
    const side = Math.abs(w.up.z) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
    const s = side.clone().cross(w.up).normalize();
    const t = w.up.clone().cross(s).normalize();
    const dir = s.multiplyScalar(Math.cos(a)).add(t.multiplyScalar(Math.sin(a)));
    const hit = c.set.raycast(w.feet.clone().addScaledVector(w.up, knee), dir, 6 / scale);
    if (hit && hit.t > radius * 2 && (!wall || hit.t < wall.t)) {
      wall = { dir, t: hit.t };
    }
  }
  if (!wall) {
    return { ok: true, reason: `eye ${height.toFixed(3)} above the ground (no wall within 6 m)` };
  }
  const start = w.feet.clone();
  let closest = Infinity;
  w.driveFor(wall.dir.clone().transformDirection(v.model.matrixWorld).multiplyScalar(2), (wall.t * scale) / 2 + 1);
  const end = performance.now() + ((wall.t * scale) / 2 + 1.3) * 1000;
  while (performance.now() < end) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    for (const h of [knee, w.settings.eyeHeight / scale - radius]) {
      const center = w.feet.clone().addScaledVector(w.up, h);
      c.set.sphere(center, radius * 2, (p) => (closest = Math.min(closest, Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z))));
    }
  }
  const moved = w.feet.clone().sub(start).dot(wall.dir);
  const ok = closest >= radius * 0.95;
  return { ok, reason: `eye ${height.toFixed(3)} m up; toward a wall ${(wall.t * scale).toFixed(2)} m away, moved ${(moved * scale).toFixed(2)} m, closest ${(closest * scale).toFixed(3)} m (radius ${w.settings.radius})` };
}

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
  ...["golden-hour-bulb", "ember-flame", "halvorsen-bloom", "sakura"].map((preset) => ({
    name: "fractals", path: "fractals/index.html", query: `preset=${preset}&splats=500000`, ready: "window.radixFractals?.ready",
  })),
  { name: "fxedit", path: "fxedit/index.html", query: "", ready: "window.radixFxedit?.ready" },
  { name: "doom", path: "doom/index.html", query: "warp=1,1&nosound", ready: "window.radixDoom?.ready || window.radixDoom?.error" },
  { name: "quake", path: "quake/index.html", query: "map=start&nosound", ready: "window.radixQuake?.ready || window.radixQuake?.error" },
  // LCC scenes (hosted samples): a Portable one with 3 cells and a Quality one
  // (SH); XGRIDS' LCC2 street (.sog), a converted LCC2 scene (.spz, SH); and
  // walking on the temple's collision mesh
  ...["unreal", "sutro", "street", "sutro-spz"].map((scene) => ({
    name: "lcc", path: "lcc/index.html", query: `scene=${scene}${lccRoot ? `&lcc=${lccRoot}` : ""}`, ready: "window.radixLcc?.ready || window.radixLcc?.error",
  })),
  {
    name: "lcc", path: "lcc/index.html", query: `scene=unreal&camera=walk${lccRoot ? `&lcc=${lccRoot}` : ""}`, ready: "window.radixLcc?.ready || window.radixLcc?.error",
    check: checkWalk,
  },
].filter((page) => !only || only.includes(page.name));
const pages = args.includes("--single")
  ? radixPages.map((page) => ({ ...page, path: page.path.replace(/^([^/]+)\/index\.html$/, "$1/$1.html") }))
  : [...sparkPages, ...radixPages];

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"] });
const results = [];
try {
  for (const gpu of backends) {
    for (const { path, query: search, ready, wait, check } of pages.filter((page) => (!page.backends || page.backends.includes(gpu)))) {
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
          // Let a few more frames land (CPU sorts on WebGL2; reveals that
          // start blank), then look at the canvas alone
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
          if (outcome.ok && check) {
            const checked = await page.evaluate(check);
            outcome = { ok: checked.ok, reason: `${outcome.reason}; ${checked.reason}` };
          }
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
