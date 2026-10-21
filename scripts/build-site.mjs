// Builds the examples and docs into build/site/, a static site that keeps the
// repo's paths so relative links work under any URL prefix
//
//   npm run build:site
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(root, "build/site");
const DOCS = "docs";
const REPO = "https://github.com/sparkjsdev/radix";

// The folders the examples' import maps load from, with the files those modules import
const MODULES = ["three/build", "three/examples/jsm", "lil-gui/dist", "tweakpane/dist", "@tweakpane/plugin-essentials/dist", "elkjs/lib"];

// Repo files the docs link to on GitHub rather than in the site
const SOURCE = /\.(ts|mjs|js|md)$/;

const posix = (file) => file.split(path.sep).join("/");
const isFile = (file) => existsSync(file) && statSync(file).isFile();

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  }));
  return files.flat();
}

async function copy(from) {
  await cp(path.join(root, from), path.join(SITE, from), { recursive: true });
}

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

// Files git tracks and those built from them, such as the ignored docs/ref/ pages, go in the site
function published(file, tracked) {
  if (file.startsWith("build/examples/")) {
    const source = file.slice("build/".length);
    const page = source.match(/^examples\/([^/]+)\/\1\.html$/)?.[1];
    return tracked.has(source) || tracked.has(source.replace(/\.js$/, ".ts")) || (page !== undefined && tracked.has(`examples/${page}/index.html`));
  }
  return tracked.has(file) || /^docs\/ref\/[^/]+\.html$/.test(file);
}

// A page's relative links, skipping template literals and code samples (<pre>)
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

function importMapOf(html) {
  return [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)].flatMap((map) => Object.values(JSON.parse(map[1]).imports ?? {}));
}

execFileSync(process.execPath, [path.join(root, "scripts/build-lib.mjs")], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/build-single.mjs"), "--no-build"], { cwd: root, stdio: "inherit" });
await rm(SITE, { recursive: true, force: true });
await mkdir(SITE, { recursive: true });

const tracked = new Set(git("ls-files", "-z", "--", DOCS, "examples").split("\0").filter(Boolean));
if (tracked.size === 0) {
  throw new Error("git ls-files lists no files in docs/ or examples/: the site is built from a git checkout");
}

await copy("dist");
for (const dir of ["build/examples", DOCS]) {
  for (const file of (await listFiles(path.join(root, dir))).map((file) => posix(path.relative(root, file)))) {
    if (published(file, tracked)) {
      await copy(file);
    }
  }
}
for (const dir of MODULES) {
  await copy(path.join("node_modules", dir));
}

const commit = git("rev-parse", "--short", "HEAD");
const rev = git("rev-parse", "HEAD") || "main";

for (const page of (await listFiles(path.join(SITE, DOCS))).filter((file) => file.endsWith(".html"))) {
  const html = await readFile(page, "utf8");
  const linked = html.replace(/\bhref="([^"#?]+)([^"]*)"/g, (all, link, rest) => {
    if (/^[a-z]+:/i.test(link)) {
      return all;
    }
    const target = posix(path.relative(SITE, path.resolve(path.dirname(page), link)));
    const source = SOURCE.test(target) && !target.startsWith("..") && !target.startsWith("build/") && isFile(path.join(root, target));
    return source ? `href="${REPO}/blob/${rev}/${target}${rest}"` : all;
  });
  await writeFile(page, linked);
}

// The docs' logo links the site's landing page, one folder up, not the docs index
const siteJs = path.join(SITE, DOCS, "site.js");
let siteJsText = await readFile(siteJs, "utf8");
for (const [from, to] of [
  ['<a class="brand" href="${root}index.html">', '<a class="brand" href="${root}../index.html" title="Radix: the repo, getting started, examples and docs">'],
]) {
  if (!siteJsText.includes(from)) {
    throw new Error(`${DOCS}/site.js: no ${from} to rewrite for the site`);
  }
  siteJsText = siteJsText.replace(from, to);
}
await writeFile(siteJs, siteJsText);

// The Spark list's "Radix source" links go to the .ts on GitHub, not the built JS
const sparkIndex = path.join(SITE, "build/examples/spark/index.html");
const built = 'href="./${example.name}/main.js">Radix source</a>';
const sparkHtml = await readFile(sparkIndex, "utf8");
if (!sparkHtml.includes(built)) {
  throw new Error(`build/examples/spark/index.html: no ${built} to point at GitHub`);
}
await writeFile(sparkIndex, sparkHtml.replace(built, `href="${REPO}/blob/${rev}/examples/spark/\${example.name}/main.ts">Radix source</a>`));

const ICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cellipse cx='6' cy='8' rx='5' ry='3' fill='%23f472b6' transform='rotate(-30 6 8)'/%3E%3Cellipse cx='10' cy='8' rx='5' ry='3' fill='%232dd4bf' fill-opacity='.8' transform='rotate(30 10 8)'/%3E%3C/svg%3E">`;

await writeFile(path.join(SITE, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radix (@sparkjsdev/radix): examples and docs</title>
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
<p>3D Gaussian splats in typed-array tables on the CPU and GPU, drawn by three.js's <code>WebGPURenderer</code> on WebGPU or its WebGL2 backend. This site has the example pages and the documentation.</p>

<h2>The code</h2>
<p>The repository is <a href="${REPO}">${REPO.replace(/^https:\/\//, "")}</a>; the library (npm package <code>@sparkjsdev/radix</code>) lives in <code>src/</code>.</p>
<p class="meta">Built from ${commit || "a working copy"} on ${new Date().toISOString().slice(0, 10)}</p>

<h2>Getting started</h2>
<pre class="lang-sh"><code>git clone ${REPO}.git
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
  <a href="build/examples/index.html"><b>Examples</b><span>The example pages (splat viewer, scenes, WebXR, games) and the ports of the SparkJS examples.</span></a>
  <a href="build/examples/spark/index.html"><b>Spark ports</b><span>Every SparkJS 2.3.1 example: ported, partial or blocked, and why.</span></a>
  <a href="${DOCS}/index.html"><b>Documentation</b><span>How Radix works, the API reference, recipes, and the comparison with SparkJS.</span></a>
</div>
</main>
<script src="${DOCS}/site.js"></script>
</body>
</html>
`);

// The single-file builds are not checked: their inline code holds no links
const single = (page) => /^build\/examples\/([^/]+)\/\1\.html$/.test(posix(path.relative(SITE, page)));

const broken = [];
for (const page of (await listFiles(SITE)).filter((file) => file.endsWith(".html") && !file.includes(`${path.sep}node_modules${path.sep}`) && !single(file))) {
  const html = await readFile(page, "utf8");
  const at = (link) => path.resolve(path.dirname(page), decodeURIComponent(link));
  // Links name files (a bucket serves no folder's index.html)
  for (const link of linksOf(html)) {
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
console.log(`Built build/site/: ${(bytes / 1e6).toFixed(1)} MB`);
if (broken.length) {
  console.error(`Broken links in the site:\n  ${broken.join("\n  ")}`);
  process.exit(1);
}
console.log("Preview: npm run serve:site, then http://localhost:8002/");
