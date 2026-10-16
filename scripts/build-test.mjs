// Builds the GPU test page (test/gpu/) and the benchmark page (test/bench/)
// into build/test/: each main.ts bundled with three and the library from
// source (the tests deep-import internals, so both must be the same
// modules), beside a copy of its index.html.
//
//   npm run build:test, then npm run serve:
//   http://localhost:8000/build/test/gpu/index.html   (?gpu=webgpu | webgpu-gl, ?run=0)
//   http://localhost:8000/build/test/bench/index.html (scripts/bench.mjs)
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { inlineWorkerPlugin } from "./inline-worker-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["gpu", "bench"];

export async function buildTest() {
  await esbuild.build({
    entryPoints: Object.fromEntries(PAGES.map((page) => [`${page}/main`, path.join(root, `test/${page}/main.ts`)])),
    bundle: true,
    format: "esm",
    outdir: path.join(root, "build/test"),
    alias: { "@sparkjsdev/radix": path.join(root, "src/index.ts") },
    target: "es2022",
    sourcemap: true,
    plugins: [inlineWorkerPlugin()],
    logLevel: "warning",
  });
  for (const page of PAGES) {
    await mkdir(path.join(root, `build/test/${page}`), { recursive: true });
    await copyFile(path.join(root, `test/${page}/index.html`), path.join(root, `build/test/${page}/index.html`));
  }
  console.log("Built build/test/gpu/ and build/test/bench/");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildTest();
}
