// Builds each example page but the Spark ports as one HTML file with its code and
// styles inline, build/examples/<name>/<name>.html (data still loads from its URL)
//
//   npm run build:single [-- options]
//   <name> ...   the pages to build (default all)
//   --no-build   skip npm run build first
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "examples");
const BUILT = path.join(root, "build/examples");
const SKIP = new Set(["spark"]);

// Scripts that start a worker from a file beside them, and the global holding its address instead
const COMPANIONS = { "elk-api.js": { global: "ELK_WORKER_URL", file: "elk-worker.min.js" } };

const args = process.argv.slice(2);
if (!args.includes("--no-build")) {
  execFileSync(process.execPath, [path.join(root, "scripts/build-lib.mjs")], { cwd: root, stdio: "inherit" });
}
const asked = args.filter((arg) => !arg.startsWith("--"));
const names = asked.length > 0 ? asked : readdirSync(SOURCE).filter((name) =>
  !SKIP.has(name) && statSync(path.join(SOURCE, name)).isDirectory() &&
  existsSync(path.join(SOURCE, name, "index.html")) && existsSync(path.join(SOURCE, name, "main.ts")));

const blob = (body, type) => `URL.createObjectURL(new Blob([${JSON.stringify(body)}], { type: "${type}" }))`;
const escapeTag = (text, tag) => text.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

async function buildPage(name) {
  const dir = path.join(SOURCE, name);
  let html = readFileSync(path.join(dir, "index.html"), "utf8");
  const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  const imports = map ? JSON.parse(map[1]).imports ?? {} : {};
  // Import-map and HTML addresses are root paths in the sources
  const file = (address) => (address.startsWith("/") ? path.join(root, address) : path.resolve(dir, address));
  const mapped = (specifier) => {
    if (imports[specifier]) {
      return file(imports[specifier]);
    }
    const prefix = Object.keys(imports).filter((key) => key.endsWith("/") && specifier.startsWith(key)).sort((a, b) => b.length - a.length)[0];
    return prefix ? file(imports[prefix] + specifier.slice(prefix.length)) : undefined;
  };
  const resolve = {
    name: "import-map",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const target = mapped(args.path);
        return target ? { path: target } : undefined;
      });
    },
  };

  const bundles = new Map();
  const bundle = (entry) => {
    if (!bundles.has(entry)) {
      bundles.set(entry, esbuild.build({
        entryPoints: [entry], bundle: true, format: "esm", minify: true, write: false, target: "es2022", legalComments: "none",
        plugins: [resolve, inline], logLevel: "error",
      }).then((result) => result.outputFiles[0].text));
    }
    return bundles.get(entry);
  };
  const inline = {
    name: "inline-urls",
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async (args) => {
        if (!args.path.startsWith(SOURCE + path.sep)) {
          return undefined;
        }
        let text = readFileSync(args.path, "utf8");
        for (const [whole, base, ext] of [...text.matchAll(/new URL\(\s*"\.\/([\w./-]+)\.(js|css)"\s*,\s*import\.meta\.url\s*\)/g)]) {
          const target = path.join(path.dirname(args.path), base);
          const body = ext === "css" ? readFileSync(`${target}.css`, "utf8") : await bundle(existsSync(`${target}.ts`) ? `${target}.ts` : `${target}.js`);
          text = text.replace(whole, () => `new URL(${blob(body, ext === "css" ? "text/css" : "text/javascript")})`);
        }
        for (const [whole, specifier] of [...text.matchAll(/import\.meta\.resolve\(\s*"([^"]+)"\s*\)/g)]) {
          const target = mapped(specifier);
          if (!target) {
            throw new Error(`${path.relative(root, args.path)}: import.meta.resolve("${specifier}") is not in the import map`);
          }
          const body = await bundle(target);
          text = text.replace(whole, () => blob(body, "text/javascript"));
        }
        return { contents: text, loader: "ts" };
      });
    },
  };

  const code = await bundle(path.join(dir, "main.ts"));
  html = html
    .replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, "")
    .replace(/<link rel="stylesheet" href="([^"]+)"\s*\/?>/g, (all, href) => `<style>${escapeTag(readFileSync(file(href), "utf8"), "style")}</style>`)
    .replace(/<script src="([^"]+)"><\/script>/g, (all, src) => {
      const companion = COMPANIONS[path.basename(src)];
      const worker = companion ? `<script>window.${companion.global} = ${blob(readFileSync(path.join(path.dirname(file(src)), companion.file), "utf8"), "text/javascript")};</script>\n    ` : "";
      return `${worker}<script>${escapeTag(readFileSync(file(src), "utf8"), "script")}</script>`;
    })
    .replace(/<script type="module" src="\.\/main\.js"><\/script>/, () => `<script type="module">${escapeTag(code, "script")}</script>`);
  if (/type="importmap"|<script[^>]*\ssrc=|<link rel="stylesheet"/.test(html)) {
    throw new Error(`${name}/index.html: an import map, script or stylesheet address is left`);
  }
  const out = path.join(BUILT, name, `${name}.html`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  return `${path.relative(root, out)}: ${(html.length / 1e6).toFixed(2)} MB`;
}

for (const line of await Promise.all(names.map(buildPage))) {
  console.log(line);
}
