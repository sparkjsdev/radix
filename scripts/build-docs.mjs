// Converts each docs/<name>.md to docs/ref/<name>.html, with working links when read from disk
//
//   npm run docs [-- options]
//   --check   fail on a broken link or anchor, or an export on no .md page (npm run check:docs)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const DOCS = join(ROOT, "docs");
const REF = join(DOCS, "ref");
const CHECK = process.argv.includes("--check");
const ICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cellipse cx='6' cy='8' rx='5' ry='3' fill='%23f472b6' transform='rotate(-30 6 8)'/%3E%3Cellipse cx='10' cy='8' rx='5' ry='3' fill='%232dd4bf' fill-opacity='.8' transform='rotate(30 10 8)'/%3E%3C/svg%3E`;

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const toPosix = (p) => p.split("\\").join("/");
const isExternal = (url) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");

// Heading ids as GitHub makes them
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
    const n = seen.get(base);
    seen.set(base, n === undefined ? 0 : n + 1);
    return n === undefined ? base : `${base}-${n + 1}`;
  };
}

// The text of inline Markdown, as GitHub slugs it
const plainText = (md) => md
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/`+([^`]*)`+/g, "$1")
  .replace(/\*\*|__|\*|(?<!\w)_|_(?!\w)/g, "")
  .replace(/<[^>]+>/g, "");

// ctx: { href(url) -> url, codeLink(text) -> url | undefined }
function inline(md, ctx) {
  const held = [];
  const hold = (html) => `\uE000${held.push(html) - 1}\uE000`;
  // Code spans first, so nothing inside them is parsed
  let s = md.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, body) => {
    const text = body.length > 1 && body.startsWith(" ") && body.endsWith(" ") ? body.slice(1, -1) : body;
    const code = `<code>${escapeHtml(text)}</code>`;
    const link = ctx.codeLink(text);
    return hold(link ? `<a href="${escapeHtml(link)}">${code}</a>` : code);
  });
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, (_, c) => hold(escapeHtml(c)));
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => hold(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
  // Inline HTML tags the docs use pass through
  s = s.replace(/<\/?(br|sup|sub|kbd|b|i|em|strong)\s*\/?>/gi, (tag) => hold(tag));
  s = escapeHtml(s);
  s = s.replace(/(!?)\[((?:[^\]\uE000]|\uE000\d+\uE000)*)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_, bang, text, url, title) => {
    const href = escapeHtml(ctx.href(url.replace(/&amp;/g, "&")));
    const t = title ? ` title="${title}"` : "";
    return bang ? hold(`<img src="${href}" alt="${text}"${t}>`) : hold(`<a href="${href}"${t}>${text}</a>`);
  });
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?![\w*])/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/ {2,}\n/g, "<br>\n");
  for (let i = 0; i < 4 && s.includes("\uE000"); i++) s = s.replace(/\uE000(\d+)\uE000/g, (_, n) => held[Number(n)]);
  return s;
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const RAW = /^<(div|table|details|figure|section|p|img|svg|canvas|pre|hr)\b/i;
const blank = (l) => /^\s*$/.test(l);
const indentOf = (l) => l.match(/^ */)[0].length;
const startsBlock = (l, next) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || /^\s*>/.test(l) || LIST.test(l) ||
  (l.trim().startsWith("|") && next !== undefined && TABLE_SEP.test(next)) || RAW.test(l.trim());

// Split a table row on pipes outside code spans
function cells(row) {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out = [];
  let cur = "";
  let ticks = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      ticks = ticks === 0 ? n : ticks === n ? 0 : ticks;
      cur += "`".repeat(n);
      i += n - 1;
      continue;
    }
    if (c === "|" && ticks === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function parseBlocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    let m;
    if ((m = FENCE.exec(line))) {
      const indent = m[1].length;
      const close = new RegExp(`^\\s*${m[2][0] === "`" ? "`" : "~"}{${m[2].length},}\\s*$`);
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
      i++;
      const lang = m[3].toLowerCase();
      // site.js highlights it in the browser, by its lang- class
      out.push(`<pre${lang ? ` class="lang-${lang}"` : ""}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if ((m = HEADING.exec(line))) {
      const level = m[1].length;
      const id = ctx.slug(plainText(m[2]));
      const html = inline(m[2], ctx);
      ctx.headings.push({ level, id, html, text: plainText(m[2]) });
      out.push(`<h${level} id="${escapeHtml(id)}">${html}<a class="anchor" href="#${escapeHtml(id)}">#</a></h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      const style = (k) => (align[k] ? ` style="text-align: ${align[k]}"` : "");
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
      out.push(`<table><thead><tr>${head.map((c, k) => `<th${style(k)}>${inline(c, ctx)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${head.map((_, k) => `<td${style(k)}>${inline(r[k] ?? "", ctx)}</td>`).join("")}</tr>`).join("") + "</tbody></table>");
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      for (; i < lines.length && !blank(lines[i]) && (/^\s*>/.test(lines[i]) || !startsBlock(lines[i], lines[i + 1])); i++) body.push(lines[i].replace(/^\s*> ?/, ""));
      out.push(`<blockquote>${parseBlocks(body, ctx)}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      i = parseList(lines, i, ctx, out);
      continue;
    }
    if (RAW.test(line.trim())) {
      const body = [];
      for (; i < lines.length && !blank(lines[i]); i++) body.push(lines[i]);
      out.push(body.join("\n"));
      continue;
    }
    const para = [line.trim()];
    for (i++; i < lines.length && !blank(lines[i]) && !startsBlock(lines[i], lines[i + 1]); i++) para.push(lines[i].trim());
    out.push(`<p>${inline(para.join("\n"), ctx)}</p>`);
  }
  return out.join("\n");
}

function parseList(lines, i, ctx, out) {
  const first = LIST.exec(lines[i]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const content = base + m[2].length + Math.max(1, m[3].length);
    const body = [m[4]];
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (blank(l)) {
        let j = i;
        while (j < lines.length && blank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= content) { body.push(""); continue; }
        break;
      }
      const ind = indentOf(l);
      if (ind >= content) { body.push(l.slice(content)); continue; }
      const lm = LIST.exec(l);
      if (lm && lm[1].length <= base) break;
      if (lm || ind > base) { body.push(l.slice(Math.min(ind, content))); continue; }
      if (body.at(-1) === "" || startsBlock(l, lines[i + 1])) break;
      body.push(l.trim());
    }
    while (body.at(-1) === "") body.pop();
    if (body.includes("")) loose = true;
    items.push(body);
    let j = i;
    while (j < lines.length && blank(lines[j])) j++;
    if (j > i && j < lines.length) {
      const next = LIST.exec(lines[j]);
      if (next && next[1].length === base && /\d/.test(next[2]) === ordered) { loose = true; i = j; continue; }
    }
  }
  const tag = ordered ? "ol" : "ul";
  const html = items.map((body) => {
    let inner = parseBlocks(body, ctx);
    if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>(?=\n|$)/, "$1");
    return `<li>${inner}</li>`;
  });
  out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>\n${html.join("\n")}\n</${tag}>`);
  return i;
}

const mdNames = readdirSync(DOCS).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
const sources = new Map(mdNames.map((name) => [name, readFileSync(join(DOCS, `${name}.md`), "utf8").replace(/\r\n/g, "\n")]));

// The sidebar: overview.md's "Pages" section, its h3 headings as groups and
// the first .md link of each list item as a page; every other page after them
function sidebarGroups() {
  const lines = sources.get("overview")?.split("\n") ?? [];
  const groups = [];
  let inPages = false;
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence) continue;
    const h = HEADING.exec(line);
    if (h && h[1].length === 2) { inPages = /^pages\b/i.test(plainText(h[2])); continue; }
    if (!inPages) continue;
    if (h && h[1].length === 3) { groups.push({ title: plainText(h[2]), pages: [] }); continue; }
    const link = /^\s*[-*]\s.*?\]\(([\w-]+)\.md(?:#[^)]*)?\)/.exec(line);
    if (link && sources.has(link[1])) {
      if (groups.length === 0) groups.push({ title: "Pages", pages: [] });
      const g = groups.at(-1);
      if (!groups.some((x) => x.pages.includes(link[1]))) g.pages.push(link[1]);
    }
  }
  const listed = new Set(groups.flatMap((g) => g.pages));
  if (sources.has("overview") && !listed.has("overview")) {
    if (groups.length === 0) groups.push({ title: "Pages", pages: [] });
    groups[0].pages.unshift("overview");
    listed.add("overview");
  }
  const rest = mdNames.filter((n) => !listed.has(n));
  if (rest.length) groups.push({ title: "More", pages: rest });
  return groups;
}

// Ignored files, such as splats/, exist in some checkouts only, so ref/ never links them
function gitIgnored(file) {
  try {
    execFileSync("git", ["check-ignore", "-q", file], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

// The path from ref/ to a repo or src/ file named in inline code
function codeLink(text) {
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(text) || !/\.\w+$/.test(text)) return undefined;
  for (const base of [ROOT, SRC]) {
    const file = join(base, text);
    if (existsSync(file) && statSync(file).isFile() && !gitIgnored(file)) return toPosix(relative(REF, file));
  }
  return undefined;
}

// A .md page's link rewritten for ref/: pages to their .html, the rest relative to ref/
function hrefFor(url) {
  if (isExternal(url) || url.startsWith("#")) return url;
  const [path, hash] = url.split(/(?=#)/);
  const target = resolve(DOCS, path);
  if (path.endsWith(".md") && dirname(target) === DOCS && sources.has(basename(target, ".md"))) return `${basename(target, ".md")}.html${hash ?? ""}`;
  return toPosix(relative(REF, target)) + (hash ?? "");
}

function render(name) {
  const ctx = { slug: slugger(), headings: [], href: hrefFor, codeLink };
  const body = parseBlocks(sources.get(name).split("\n"), ctx);
  const h1 = ctx.headings.find((h) => h.level === 1);
  return { body, headings: ctx.headings, title: h1 ? h1.text : name };
}

const pages = new Map(mdNames.map((name) => [name, render(name)]));
const groups = sidebarGroups();
const order = groups.flatMap((g) => g.pages);
const shortTitle = (name) => {
  const t = pages.get(name).title.replace(/^Radix:?\s*/i, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// A link whose text is its target's file name, [views.md](views.md), shows the page's title
const titledLinks = (html) => html.replace(/<a href="([\w-]+)\.html(#[^"]*)?">([\w-]+)\.md(#[^<]*)?<\/a>/g, (link, href, hash, text) =>
  href === text && pages.has(href) ? `<a href="${href}.html${hash ?? ""}">${escapeHtml(shortTitle(href))}</a>` : link);

function pageHtml(name) {
  const { headings, title } = pages.get(name);
  const body = titledLinks(pages.get(name).body);
  const side = groups.map((g) => `<h4>${escapeHtml(g.title)}</h4>` +
    g.pages.map((p) => `<a href="${p}.html"${p === name ? ` class="on"` : ""}>${escapeHtml(shortTitle(p))}</a>`).join("")).join("\n");
  const toc = headings.filter((h) => h.level === 2 || h.level === 3)
    .map((h) => `<a class="h${h.level}" href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>`).join("\n");
  const k = order.indexOf(name);
  const prev = k > 0 ? order[k - 1] : undefined;
  const next = k >= 0 && k < order.length - 1 ? order[k + 1] : undefined;
  const pager = `<div class="pager">${prev ? `<a class="prev" href="${prev}.html"><small>Previous</small>${escapeHtml(shortTitle(prev))}</a>` : "<span></span>"}` +
    `${next ? `<a class="next" href="${next}.html"><small>Next</small>${escapeHtml(shortTitle(next))}</a>` : "<span></span>"}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title.replace(/^Radix:?\s*/i, ""))} · Radix docs</title>
<link rel="icon" href="${ICON}">
<link rel="stylesheet" href="../site.css">
</head>
<!-- Generated from docs/${name}.md by scripts/build-docs.mjs; edit the .md -->
<body data-root="../" data-page="ref/${name}.html">
<div class="ref">
<nav class="ref-side">
${side}
</nav>
<main class="doc">
${body}
${pager}
<p class="source">Source: <a href="../${name}.md">docs/${name}.md</a></p>
</main>
<nav class="ref-toc">
<h4>On this page</h4>
${toc}
</nav>
</div>
<script src="../site.js"></script>
</body>
</html>
`;
}

const outputs = new Map(mdNames.map((name) => [`${name}.html`, pageHtml(name)]));
const problems = [];

mkdirSync(REF, { recursive: true });
for (const file of readdirSync(REF)) if (file.endsWith(".html") && !outputs.has(file)) rmSync(join(REF, file));
for (const [file, html] of outputs) {
  const path = join(REF, file);
  if (!existsSync(path) || readFileSync(path, "utf8") !== html) writeFileSync(path, html);
}

const idsOf = new Map();
function ids(file) {
  if (!idsOf.has(file)) {
    let set;
    if (file.startsWith(REF + "/") && outputs.has(basename(file))) set = new Set(pages.get(basename(file, ".html")).headings.map((h) => h.id));
    else if (file.endsWith(".md") && dirname(file) === DOCS && pages.has(basename(file, ".md"))) set = new Set(pages.get(basename(file, ".md")).headings.map((h) => h.id));
    else if (file.endsWith(".html") && existsSync(file)) set = new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    else set = new Set();
    idsOf.set(file, set);
  }
  return idsOf.get(file);
}

// Links to the built example pages are checked against their sources
const BUILT_EXAMPLES = join(ROOT, "build/examples");
function sourceOf(target) {
  return target.startsWith(BUILT_EXAMPLES + "/") ? join(ROOT, "examples", relative(BUILT_EXAMPLES, target)).replace(/\.js$/, ".ts") : target;
}

function checkLink(from, url, base) {
  if (!url || isExternal(url) || url.includes("${")) return;
  const [path, hash] = url.startsWith("#") ? ["", url] : url.split(/(?=#)/);
  const target = sourceOf(path ? resolve(base, path) : from);
  const where = toPosix(relative(ROOT, from));
  if (path && !existsSync(target) && !(target.startsWith(REF + "/") && outputs.has(basename(target)))) {
    problems.push(`${where}: ${url} does not exist`);
    return;
  }
  if (hash && hash.length > 1 && (target.endsWith(".md") || target.endsWith(".html"))) {
    const id = decodeURIComponent(hash.slice(1));
    if (!ids(target).has(id)) problems.push(`${where}: ${url} has no #${id}`);
  }
}

for (const name of mdNames) {
  const from = join(DOCS, `${name}.md`);
  let inFence = false;
  for (const line of sources.get(name).split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence) continue;
    const text = line.replace(/`[^`]*`/g, "");
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) checkLink(from, m[1], DOCS);
  }
}
for (const file of readdirSync(DOCS).filter((f) => f.endsWith(".html"))) {
  const from = join(DOCS, file);
  const html = readFileSync(from, "utf8");
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    if (m[1].startsWith("#") && !ids(from).has(m[1].slice(1))) continue; // anchors made by the page's script
    checkLink(from, m[1], DOCS);
  }
}

if (CHECK) {
  // Names in inline code, and in the code blocks
  const documented = new Set();
  const addNames = (text) => (text.match(/[A-Za-z_$][\w$]*/g) ?? []).forEach((n) => documented.add(n));
  for (const name of mdNames) {
    const prose = sources.get(name).replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\s*\2[`~]*\s*$/gm, (_, _indent, _fence, code) => {
      addNames(code);
      return "";
    });
    for (const m of prose.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/g)) addNames(m[2]);
  }
  for (const layer of ["core", "gpu", "wgpu", "worker", "render", "controls"]) {
    const index = readFileSync(join(SRC, layer, "index.ts"), "utf8");
    for (const m of index.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
      for (const raw of m[2].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
        if (name && !documented.has(name)) problems.push(`${layer}/index.ts: ${name} is on no .md page`);
      }
    }
  }
}

if (problems.length) {
  console.log(problems.join("\n"));
  console.log(`${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  if (CHECK) process.exit(1);
}
console.log(`wrote ${outputs.size} pages to ${toPosix(relative(ROOT, REF))}/${CHECK ? ", links and exports checked" : ""}`);
