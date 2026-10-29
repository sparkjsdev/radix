// Runs the GPU test page (test/gpu/, built into build/test/gpu/) in headless
// Chrome on both backends and prints its failures and totals; exits 1 on a
// failure. Needs npm run build:test and npm run serve (--base).
//
//   node scripts/check-test.mjs [--base http://localhost:8000] [--gpu webgpu | webgpu-gl]
/* global document -- functions run in the page */
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const base = option("--base", "http://localhost:8000");
const backends = option("--gpu") ? [option("--gpu")] : ["webgpu", "webgpu-gl"];

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu"] });
let failed = false;
try {
  for (const gpu of backends) {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.log(`  page error: ${error.message}`));
    await page.goto(`${base}/build/test/gpu/index.html?gpu=${gpu}`);
    await page.waitForFunction(() => /\d+\/\d+ passed/.test(document.getElementById("output")?.textContent ?? ""), null, { timeout: 600000 });
    const lines = (await page.evaluate(() => document.getElementById("output").textContent)).split("\n");
    for (const line of lines.filter((l) => l.startsWith("FAIL"))) {
      console.log(`${gpu}: ${line}`);
      failed = true;
    }
    console.log(`${gpu}: ${lines.find((l) => /passed$/.test(l))}`);
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
