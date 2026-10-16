// Builds src/ into the package's ES modules (three stays external: a
// bundler or the page's import map resolves it; the workers' core module is
// inlined as a minified string, WorkerPool.coreUrl) and their declarations,
// then the example and test pages that import them (scripts/build-examples.mjs,
// scripts/build-test.mjs) and the docs' reference pages (scripts/build-docs.mjs):
//   dist/radix.module.js       the library (import "@sparkjsdev/radix")
//   dist/radix-core.module.js  core/ alone (import "@sparkjsdev/radix/core"):
//                              no imports at all, for Node and pages without
//                              the library
//   dist/types/                the declarations (tsc -p tsconfig.lib.json)
//   build/examples/, build/test/
//   docs/ref/                  the docs' .md pages as HTML
//
//   npm run build [-- --watch]   then npm run serve
//   --lib-only                   dist/ alone (npm's prepare)
import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { inlineWorkerPlugin } from "./inline-worker-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const CORE = "dist/radix-core.module.js";

// The core bundle must stay loadable without an import map
async function checkCore() {
  const imports = (await readFile(CORE, "utf8")).match(/^\s*(import|export)\b[^;]*?\bfrom\s*["'][^"']+["']/gm) ?? [];
  if (imports.length > 0) {
    throw new Error(`${CORE} imports other modules: ${imports.join(", ")}`);
  }
}

function buildTypes() {
  execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.lib.json"], { stdio: "inherit" });
}

const options = {
  entryPoints: { "radix.module": "src/index.ts", "radix-core.module": "src/core/index.ts" },
  bundle: true,
  format: "esm",
  outdir: "dist",
  external: ["three", "three/webgpu", "three/tsl"],
  target: "es2022",
  sourcemap: true,
  // The workers' core module is a string in the bundle: an app's minifier
  // cannot shrink it, so it is minified here
  plugins: [inlineWorkerPlugin({ minify: true })],
};

const buildDocs = () => execFileSync(process.execPath, ["scripts/build-docs.mjs"], { stdio: "inherit" });

const libOnly = process.argv.includes("--lib-only");

if (process.argv.includes("--watch")) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching dist/radix.module.js...");
  const { watchExamples } = await import("./build-examples.mjs");
  await watchExamples();
  buildDocs();
  let timer;
  watch("docs", (_, file) => {
    if (file?.endsWith(".md")) {
      clearTimeout(timer);
      timer = setTimeout(buildDocs, 100);
    }
  });
} else {
  await rm("dist", { recursive: true, force: true });
  await esbuild.build(options);
  await checkCore();
  buildTypes();
  console.log("Built dist/radix.module.js, dist/radix-core.module.js and dist/types/");
  if (!libOnly) {
    const { buildExamples } = await import("./build-examples.mjs");
    const { buildTest } = await import("./build-test.mjs");
    await buildExamples();
    await buildTest();
    buildDocs();
  }
}
