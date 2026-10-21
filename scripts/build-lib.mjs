// Builds the library into dist/, then the example and test pages and the docs' reference pages
//
//   npm run build [-- options]
//   --watch      rebuild the library, examples and docs as they change (npm run build:watch)
//   --lib-only   dist/ alone (npm's prepare)
import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
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

// The bundles and their source maps must not name the folder they are built in
async function checkPaths() {
  const named = [];
  for (const file of await readdir("dist")) {
    if ((await readFile(path.join("dist", file), "utf8")).includes(root)) {
      named.push(`dist/${file}`);
    }
  }
  if (named.length > 0) {
    throw new Error(`${named.join(", ")} name the build folder ${root}`);
  }
}

// The package holds the notices of the third-party code in its bundles
async function copyNotices() {
  await mkdir("dist", { recursive: true });
  await copyFile("THIRD_PARTY_NOTICES.txt", "dist/THIRD_PARTY_NOTICES.txt");
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
  // An app's minifier can't shrink the workers' code, a string in the bundle
  plugins: [inlineWorkerPlugin({ minify: true })],
};

const buildDocs = () => execFileSync(process.execPath, ["scripts/build-docs.mjs"], { stdio: "inherit" });

const libOnly = process.argv.includes("--lib-only");

if (process.argv.includes("--watch")) {
  const context = await esbuild.context(options);
  await context.watch();
  await copyNotices();
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
  await copyNotices();
  await checkCore();
  await checkPaths();
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
