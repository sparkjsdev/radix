// Builds examples/ into build/examples/, each .ts file with its types replaced
// by spaces, so no source map is needed, and every other file copied
//
//   npm run build:examples [-- options]
//   --watch   rebuild each file as it changes
import { watch as watchFiles } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = path.join(root, "examples");
export const OUTPUT = path.join(root, "build/examples");

// The browser resolves imports as written, so relative ones name the built .js file
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']*)["']/g;

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  }));
  return files.flat();
}

function outputOf(file) {
  const out = path.join(OUTPUT, path.relative(SOURCE, file));
  return file.endsWith(".ts") ? `${out.slice(0, -3)}.js` : out;
}

// Page-relative import maps work at the server root and under any prefix (scripts/build-site.mjs)
function relativeImportMap(html, out) {
  const up = path.relative(path.dirname(out), root).split(path.sep).join("/") + "/";
  return html.replaceAll('"/node_modules/', `"${up}node_modules/`).replaceAll('"/dist/', `"${up}dist/`).replaceAll('"/build/', `"${up}build/`);
}

async function buildFile(file) {
  const out = outputOf(file);
  await mkdir(path.dirname(out), { recursive: true });
  if (file.endsWith(".html")) {
    await writeFile(out, relativeImportMap(await readFile(file, "utf8"), out));
    return;
  }
  if (!file.endsWith(".ts")) {
    await copyFile(file, out);
    return;
  }
  const source = await readFile(file, "utf8");
  const bad = [...source.matchAll(RELATIVE_IMPORT)].map((match) => match[1]).filter((specifier) => !/\.(js|json|css)$/.test(specifier));
  if (bad.length > 0) {
    throw new Error(`${path.relative(root, file)}: relative imports need the built name (.js): ${bad.join(", ")}`);
  }
  await writeFile(out, stripTypeScriptTypes(source, { mode: "strip", sourceUrl: path.relative(root, file) }));
}

export async function buildExamples() {
  const start = performance.now();
  await rm(OUTPUT, { recursive: true, force: true });
  const files = await listFiles(SOURCE);
  await Promise.all(files.map(buildFile));
  const scripts = files.filter((file) => file.endsWith(".ts")).length;
  console.log(`Built build/examples/: ${scripts} scripts, ${files.length - scripts} other files (${Math.round(performance.now() - start)} ms)`);
}

export async function watchExamples() {
  await buildExamples();
  watchFiles(SOURCE, { recursive: true }, async (_event, name) => {
    if (!name) {
      return;
    }
    const file = path.join(SOURCE, name);
    try {
      const isFile = await stat(file).then((info) => info.isFile(), () => false);
      if (isFile) {
        await buildFile(file);
        console.log(`Built ${path.relative(root, outputOf(file))}`);
      } else {
        await rm(outputOf(file), { recursive: true, force: true });
      }
    } catch (error) {
      console.error(error.message);
    }
  });
  console.log("Watching examples/...");
}

// stripTypeScriptTypes is experimental in Node 24: keep its notice quiet
process.removeAllListeners("warning");
process.on("warning", (warning) => warning.name !== "ExperimentalWarning" && console.warn(warning));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await (process.argv.includes("--watch") ? watchExamples() : buildExamples());
}
