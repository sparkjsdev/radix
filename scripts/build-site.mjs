// Builds build/site/: the examples and docs as one static site to preview
// locally or copy to any static host. It
// keeps the repo's paths, so every relative link that works in the repo works
// in the site, under any URL prefix:
//   index.html                 landing page: the repo, getting started, links
//   dist/                      the library bundles
//   build/examples/            the built examples, each page but the Spark
//                              ports also as one file (<name>/<name>.html,
//                              scripts/build-single.mjs)
//   docs/                      the docs
//   src/, examples/ **/*.ts    sources, each with a highlighted <file>.html page
//   scripts/, ...              the other repo files the docs link to (+ .html)
//   node_modules/...           what the examples' import maps load
// Then every relative link, src and import-map address in the site's HTML is
// checked against its files.
//
// The examples read their data from the dated GCS folder in
// scripts/data.mjs (build/data/ is not copied); --data points
// Doom's and Quake's at another address.
//
//   npm run build:site          (runs npm run build first)
//     [-- --data <url>]         (another address for the examples' data)
//   npm run serve:site          http://localhost:8002/
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RADIX_DATA_URL } from "./data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(root, "build/site");
const DOCS = "docs";
const dataArg = process.argv.indexOf("--data");
const DATA_URL = dataArg >= 0 ? new URL(process.argv[dataArg + 1]).href.replace(/\/?$/, "/") : RADIX_DATA_URL;

// What the examples' import maps load (three.webgpu.js imports three.core.js
// beside it; GLTFLoader and TransformControls import their jsm helpers;
// the fx editor loads ELK's API and worker)
const MODULES = ["three/build", "three/examples/jsm", "lil-gui/dist", "tweakpane/dist", "@tweakpane/plugin-essentials/dist", "elkjs/lib"];

// Files shown as highlighted source pages (.md as plain text)
const SOURCE = /\.(ts|mjs|js|md)$/;
const CODE = /\.(ts|mjs|js)$/;

const posix = (file) => file.split(path.sep).join("/");
const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isFile = (file) => existsSync(file) && statSync(file).isFile();

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  }));
  return files.flat();
}

// Copies a repo path (file or folder) to the same path in the site
async function copy(from) {
  await cp(path.join(root, from), path.join(SITE, from), { recursive: true });
}

// The relative links of an HTML page (href, src, import-map addresses and
// inline imports), without query or hash; template literals and code
// samples (<pre>) are skipped
function linksOf(page) {
  const html = page.replace(/<pre[\s>][\s\S]*?<\/pre>/g, "");
  const links = [];
  for (const match of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    links.push(match[1]);
  }
  for (const match of html.matchAll(/\bfrom\s*"(\.{1,2}\/[^"]+)"/g)) {
    links.push(match[1]);
  }
  return links.filter((link) => link && !link.includes("${") && !/^([a-z]+:|#|\/\/)/i.test(link)).map((link) => link.split(/[?#]/)[0]).filter(Boolean);
}

// An HTML page's import-map addresses (those ending in / map a folder)
function importMapOf(html) {
  return [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)].flatMap((map) => Object.values(JSON.parse(map[1]).imports ?? {}));
}

// --- 1. The library, the examples and the docs ---

execFileSync(process.execPath, [path.join(root, "scripts/build-lib.mjs")], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/build-single.mjs"), "--no-build"], { cwd: root, stdio: "inherit" });
await rm(SITE, { recursive: true, force: true });
await mkdir(SITE, { recursive: true });

await copy("dist");
await copy("build/examples");
await copy(DOCS);
for (const dir of MODULES) {
  await copy(path.join("node_modules", dir));
}

// --- 2. Sources: every .ts of the library and the examples, and what else
// the docs link to ---

const sources = new Set([...await listFiles(path.join(root, "src")), ...await listFiles(path.join(root, "examples"))]
  .map((file) => posix(path.relative(root, file)))
  .filter((file) => file.endsWith(".ts")));

const missing = [];
for (const page of (await listFiles(path.join(root, DOCS))).filter((file) => file.endsWith(".html"))) {
  for (const link of linksOf(await readFile(page, "utf8"))) {
    const target = posix(path.relative(root, path.resolve(path.dirname(page), link)));
    if (target.startsWith("..") || target.startsWith("build/")) {
      continue;
    }
    if (!isFile(path.join(root, target))) {
      missing.push(`${posix(path.relative(root, page))} -> ${link}`);
    } else if (SOURCE.test(target)) {
      sources.add(target);
    } else if (!target.startsWith(`${DOCS}/`)) {
      await copy(target);
    }
  }
}
for (const file of sources) {
  if (!isFile(path.join(SITE, file))) {
    await copy(file);
  }
}

// --- 3. A highlighted page per source, with a tree of all of them ---

// The sources as a folder tree: { name, folders, files }, a folder with one
// subfolder and no files merged into it
function treeOf(files) {
  const top = { name: "", folders: new Map(), files: [] };
  for (const file of [...files].sort()) {
    let node = top;
    for (const part of path.posix.dirname(file).split("/")) {
      if (!node.folders.has(part)) {
        node.folders.set(part, { name: part, folders: new Map(), files: [] });
      }
      node = node.folders.get(part);
    }
    node.files.push(file);
  }
  const merge = (node) => {
    node.folders.forEach(merge);
    if (node.folders.size === 1 && node.files.length === 0 && node.name) {
      const [only] = node.folders.values();
      Object.assign(node, { name: `${node.name}/${only.name}`, folders: only.folders, files: only.files });
    }
  };
  top.folders.forEach(merge);
  return top;
}
const tree = treeOf(sources);
const ICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cellipse cx='6' cy='8' rx='5' ry='3' fill='%23f472b6' transform='rotate(-30 6 8)'/%3E%3Cellipse cx='10' cy='8' rx='5' ry='3' fill='%232dd4bf' fill-opacity='.8' transform='rotate(30 10 8)'/%3E%3C/svg%3E">`;

// Top-level declarations (or Markdown headings) as [line, label]
function outlineOf(file, lines) {
  const outline = [];
  lines.forEach((line, i) => {
    const match = file.endsWith(".md")
      ? line.match(/^#{1,3}\s+(.+)/)
      : line.match(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([\w$]+)/);
    if (match) {
      outline.push([i + 1, match[1]]);
    }
  });
  return outline;
}

// The source an import names, if the site has it: relative paths as the
// build resolves them (.js for .ts in the examples, none for .ts or
// /index.ts in the library), "@sparkjsdev/radix" and "@sparkjsdev/radix/core" as
// the library's indexes
function importTarget(file, specifier) {
  if (specifier === "@sparkjsdev/radix") {
    return "src/index.ts";
  }
  if (specifier === "@sparkjsdev/radix/core") {
    return "src/core/index.ts";
  }
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`].find((candidate) => sources.has(candidate));
}

// A line of escaped code with its import specifiers linked to their source
// pages (comment lines left alone: a link would split the comment)
function linkImports(file, line) {
  if (/^\s*(\/\/|\/\*|\*)/.test(line)) {
    return line;
  }
  return line.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g, (all, before, quote, specifier) => {
    const target = importTarget(file, specifier);
    if (!target) {
      return all;
    }
    const href = path.posix.relative(path.posix.dirname(file), `${target}.html`);
    return `${before}<a class="import" href="${href}" title="${target}">${quote}${specifier}${quote}</a>`;
  });
}

// The built example page a source belongs to, if any
function examplePageOf(file) {
  const match = file.match(/^examples\/(.+)\/[^/]+$/);
  if (!match) {
    return undefined;
  }
  for (let dir = match[1]; dir && dir !== "."; dir = path.posix.dirname(dir)) {
    const page = `build/examples/${dir}/index.html`;
    if (isFile(path.join(SITE, page))) {
      return page;
    }
  }
  return undefined;
}

function sourcePage(file, text) {
  const dir = path.posix.dirname(file);
  const to = (target) => path.posix.relative(dir, target) || path.posix.basename(target);
  const lines = text.replace(/\n$/, "").split("\n");
  const outline = outlineOf(file, lines);
  const example = examplePageOf(file);

  // Folders open down to this file
  const render = (node, prefix) => [...node.folders.values()].map((folder) => {
    const full = prefix ? `${prefix}/${folder.name}` : folder.name;
    const open = `${file}`.startsWith(`${full}/`);
    return `<details${open ? " open" : ""}><summary>${folder.name}</summary>${render(folder, full)}${
      folder.files.map((other) => `<a href="${to(`${other}.html`)}"${other === file ? ' class="on"' : ""}>${path.posix.basename(other)}</a>`).join("")
    }</details>`;
  }).join("");
  const nav = render(tree, "");
  const links = [
    `<a href="${to(file)}">raw</a>`,
    example ? `<a href="${to(example)}">open the example</a>` : "",
    `<a href="${to("build/examples/index.html")}">all examples</a>`,
    `<a href="${to("index.html")}">site home</a>`,
  ].filter(Boolean).join(" · ");
  const gutter = lines.map((_, i) => `<a id="L${i + 1}" href="#L${i + 1}">${i + 1}</a>`).join("\n");
  const code = lines.map((line) => (CODE.test(file) ? linkImports(file, escapeHtml(line)) : escapeHtml(line))).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${path.posix.basename(file)} · Radix sources</title>
${ICON}
<link rel="stylesheet" href="${to(`${DOCS}/site.css`)}">
<style>
  /* Two columns, the code taking the rest of the window (the docs' grid
     stops at 1440px and adds a contents column from 1180px) */
  .ref { max-width: none; grid-template-columns: 260px minmax(0, 1fr); gap: 28px; }
  @media (max-width: 760px) { .ref { grid-template-columns: minmax(0, 1fr); } }
  .ref-side input { width: 100%; box-sizing: border-box; margin-bottom: 10px; padding: 6px 10px; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; font: 13px var(--mono); }
  .ref-side summary { cursor: pointer; color: var(--faint); font: 12px/1.8 var(--mono); white-space: nowrap; }
  .ref-side details details { margin-left: 12px; }
  .ref-side details a { padding-left: 18px; font-family: var(--mono); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .doc .path, .doc .outline { color: var(--faint); font: 13px var(--mono); margin: -10px 0 18px; }
  .doc .outline { margin-top: -12px; line-height: 1.9; }
  .doc .outline a { margin-right: 14px; white-space: nowrap; }
  .code { display: flex; background: #0f131b; border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; }
  .code pre { margin: 0; border: 0; border-radius: 0; background: none; overflow: visible; }
  .code .gutter { text-align: right; user-select: none; border-right: 1px solid var(--line); padding-right: 12px; }
  .gutter a { color: var(--faint); text-decoration: none; }
  .gutter a:target { color: var(--yellow); }
  .code a.import { color: inherit; text-decoration: none; border-radius: 3px; }
  .code a.import:hover { text-decoration: underline; background: #ffffff10; }
</style>
</head>
<!-- Generated from ${file} by scripts/build-site.mjs -->
<body data-root="${dir === DOCS ? "" : `${to(DOCS)}/`}" data-page="" data-section="source">
<div class="ref">
<nav class="ref-side">
<input type="search" placeholder="Filter files" aria-label="Filter files">
${nav}
</nav>
<main class="doc">
<h1>${path.posix.basename(file)}</h1>
<p class="path">${file} · ${links}</p>
${outline.length ? `<p class="outline">${file.endsWith(".md") ? "Headings" : "Exports"}: ${outline.map(([line, label]) => `<a href="#L${line}">${escapeHtml(label)}</a>`).join("")}</p>` : ""}
<div class="code"><pre class="gutter">${gutter}</pre><pre${CODE.test(file) ? ' class="lang-ts"' : ""}><code>${code}</code></pre></div>
</main>
</div>
<script src="${to(`${DOCS}/site.js`)}"></script>
<script>
  // The filter shows the files whose path matches and opens their folders
  const filter = document.querySelector(".ref-side input");
  const files = [...document.querySelectorAll(".ref-side a")];
  const folders = [...document.querySelectorAll(".ref-side details")];
  const initial = folders.map((folder) => folder.open);
  filter.addEventListener("input", () => {
    const text = filter.value.trim().toLowerCase();
    files.forEach((a) => (a.hidden = Boolean(text) && !a.getAttribute("href").toLowerCase().includes(text)));
    folders.forEach((folder, i) => {
      const shown = folder.querySelector("a:not([hidden])") !== null;
      folder.hidden = !shown;
      folder.open = text ? shown : initial[i];
    });
  });
</script>
</body>
</html>
`;
}

for (const file of sources) {
  await writeFile(path.join(SITE, `${file}.html`), sourcePage(file, await readFile(path.join(root, file), "utf8")));
}

// --- 4. Links in the site's copies: sources open their pages ---

const sitePages = (await listFiles(SITE)).filter((file) => file.endsWith(".html") && !file.includes(`${path.sep}node_modules${path.sep}`));
for (const page of sitePages.filter((file) => posix(path.relative(SITE, file)).startsWith(`${DOCS}/`))) {
  const html = await readFile(page, "utf8");
  const linked = html.replace(/\bhref="([^"#?]+)([^"]*)"/g, (all, link, rest) => {
    if (/^[a-z]+:/i.test(link)) {
      return all;
    }
    const target = posix(path.relative(SITE, path.resolve(path.dirname(page), link)));
    return sources.has(target) ? `href="${link}.html${rest}"` : all;
  });
  await writeFile(page, linked);
}

// The docs top bar: the Radix logo goes to the site's landing page (one
// folder up from the docs) rather than the docs index, Source to the
// highlighted sources rather than GitHub
const siteJs = path.join(SITE, DOCS, "site.js");
let siteJsText = await readFile(siteJs, "utf8");
for (const [from, to] of [
  ['<a class="brand" href="${root}index.html">', '<a class="brand" href="${root}../index.html" title="Radix: the repo, getting started, examples, docs and sources">'],
  ['const SOURCE = "https://github.com/sparkjsdev/radix/tree/main/src";', 'const SOURCE = "../src/index.ts.html";'],
]) {
  if (!siteJsText.includes(from)) {
    throw new Error(`${DOCS}/site.js: no ${from} to rewrite for the site`);
  }
  siteJsText = siteJsText.replace(from, to);
}
await writeFile(siteJs, siteJsText);

// The Spark list's "Radix source" links: the source page, not the built JS
const sparkIndex = path.join(SITE, "build/examples/spark/index.html");
const built = 'href="./${example.name}/main.js">Radix source</a>';
const sparkHtml = await readFile(sparkIndex, "utf8");
if (!sparkHtml.includes(built)) {
  throw new Error(`build/examples/spark/index.html: no ${built} to point at the source pages`);
}
await writeFile(sparkIndex, sparkHtml.replace(built, 'href="../../../examples/spark/${example.name}/main.ts.html">Radix source</a>'));

// The examples' built data (build/data/, not copied) from GCS
const dataLine = /^export const DATA_ROOT = .*$/m;
for (const page of ["doom", "quake"]) {
  const dataJs = path.join(SITE, `build/examples/${page}/data.js`);
  const dataJsText = await readFile(dataJs, "utf8");
  if (!dataLine.test(dataJsText)) {
    throw new Error(`build/examples/${page}/data.js: no DATA_ROOT line to point at the hosted data`);
  }
  await writeFile(dataJs, dataJsText.replace(dataLine, `export const DATA_ROOT = ${JSON.stringify(DATA_URL)};`));
}

// --- 5. The landing page ---

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const remote = git("remote", "get-url", "origin") || "https://github.com/sparkjsdev/radix.git";
const repo = remote.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
const commit = git("rev-parse", "--short", "HEAD");

await writeFile(path.join(SITE, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radix (@sparkjsdev/radix): examples, docs and sources</title>
${ICON}
<link rel="stylesheet" href="${DOCS}/site.css">
<style>
  .home { max-width: 880px; margin: 0 auto; padding: 40px 24px 80px; }
  .home .meta { color: var(--faint); font: 13px var(--mono); }
</style>
</head>
<!-- Generated by scripts/build-site.mjs -->
<body data-root="${DOCS}/" data-page="" data-section="">
<main class="doc home">
<h1>Radix</h1>
<p>3D Gaussian splats in typed-array tables on the CPU and GPU, drawn by three.js's <code>WebGPURenderer</code> on WebGPU or its WebGL2 backend. This site has the example pages, the documentation and the sources.</p>

<h2>The code</h2>
<p>The repository is <a href="${repo}">${repo.replace(/^https:\/\//, "")}</a>; the library (npm package <code>@sparkjsdev/radix</code>) lives in <code>src/</code>.</p>
<p class="meta">Built from ${commit || "a working copy"} on ${new Date().toISOString().slice(0, 10)}</p>

<h2>Getting started</h2>
<pre class="lang-sh"><code>git clone ${remote}
cd radix
npm install
npm run build   # dist/, the example pages and the test pages
npm run serve   # http://localhost:8000</code></pre>
<p>Then open:</p>
<ul>
  <li>Examples and Spark ports: <code>http://localhost:8000/build/examples/</code></li>
  <li>Docs: <code>http://localhost:8000/docs/</code></li>
</ul>
<p>To build and preview this site:</p>
<pre class="lang-sh"><code>npm run build:site   # into build/site/
npm run serve:site   # http://localhost:8002/</code></pre>

<h2>On this site</h2>
<div class="next-cards">
  <a href="build/examples/index.html"><b>Examples</b><span>The example pages (splat viewer, scenes, WebXR, games, fractals) and the ports of the SparkJS examples.</span></a>
  <a href="build/examples/spark/index.html"><b>Spark ports</b><span>Every SparkJS 2.3.1 example: ported, partial or blocked, and why.</span></a>
  <a href="${DOCS}/index.html"><b>Documentation</b><span>How Radix works, the API reference, recipes, and the comparison with SparkJS.</span></a>
  <a href="src/index.ts.html"><b>Sources</b><span>The library and example sources, highlighted, with a file tree.</span></a>
</div>
</main>
<script src="${DOCS}/site.js"></script>
</body>
</html>
`);

// --- 6. Check every link of the site's pages (not the single-file builds:
// their inline code holds no links) ---

const single = (page) => /^build\/examples\/([^/]+)\/\1\.html$/.test(posix(path.relative(SITE, page)));

const broken = [];
for (const page of (await listFiles(SITE)).filter((file) => file.endsWith(".html") && !file.includes(`${path.sep}node_modules${path.sep}`) && !single(file))) {
  const html = await readFile(page, "utf8");
  const at = (link) => path.resolve(path.dirname(page), decodeURIComponent(link));
  // Links name files (a bucket serves no folder's index.html); the source
  // pages' import links sit in their code
  const imports = [...html.matchAll(/<a class="import" href="([^"]+)"/g)].map((match) => match[1]);
  for (const link of [...linksOf(html), ...imports]) {
    if (link.endsWith("/") || !isFile(at(link))) {
      broken.push(`${posix(path.relative(SITE, page))} -> ${link}`);
    }
  }
  for (const address of importMapOf(html)) {
    if (!(address.endsWith("/") ? existsSync(at(address)) && statSync(at(address)).isDirectory() : isFile(at(address)))) {
      broken.push(`${posix(path.relative(SITE, page))} -> ${address} (import map)`);
    }
  }
}

let bytes = 0;
for (const file of await listFiles(SITE)) {
  bytes += (await stat(file)).size;
}
console.log(`Built build/site/: ${sources.size} source pages, ${(bytes / 1e6).toFixed(1)} MB`);
if (missing.length) {
  console.warn(`Docs links to files that do not exist (not copied):\n  ${missing.join("\n  ")}`);
}
if (broken.length) {
  console.error(`Broken links in the site:\n  ${broken.join("\n  ")}`);
  process.exit(1);
}
console.log(`Data:    ${DATA_URL}
Preview: npm run serve:site, then http://localhost:8002/`);
