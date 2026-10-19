// Radix docs: what the site pages and the reference pages (ref/) share:
// the top bar, the section dots and scroll progress of the long pages,
// reveal on scroll, the reference pages' contents column, and syntax
// highlighting for every code sample. A classic script, not a module, so the
// pages work when opened from disk (file://). A page sets
// <body data-root="" | "../"> (the path to the docs folder) and data-page
// (its path from there, for the top bar); a page outside the docs sets
// data-section (examples; empty for none). It declares no globals,
// so pages keep their own helpers.
/* global document, matchMedia, IntersectionObserver, MutationObserver, NodeFilter, innerHeight, addEventListener */
"use strict";

(() => {
  // The guide: the site pages, shown as a second row of the top bar
  const GUIDE = [
    ["index.html", "Home"],
    ["why.html", "vs Spark"],
    ["bench.html", "Benchmarks"],
    ["ideas.html", "Design ideas"],
    ["model.html", "How it fits"],
    ["data.html", "Data"],
    ["pipeline.html", "Pipeline"],
    ["multi-splat.html", "Multi-splat"],
  ];
  // [section, label, page from the docs folder]
  const SECTIONS = [
    ["guide", "Guide", "index.html"],
    ["examples", "Examples", "../build/examples/index.html"],
    ["reference", "Reference", "ref/overview.html"],
  ];
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.body.dataset.root ?? "";
  const page = document.body.dataset.page ?? "";
  // A page outside the docs names its section (data-section)
  const section = document.body.dataset.section ?? (page.startsWith("ref/") ? "reference" : GUIDE.some(([href]) => href === page) ? "guide" : "");
  const link = (href) => (/^https?:/.test(href) ? href : `${root}${href}`);

  const logo = `<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="6" cy="8" rx="5" ry="3" fill="#f472b6" transform="rotate(-30 6 8)"/><ellipse cx="10" cy="8" rx="5" ry="3" fill="#2dd4bf" fill-opacity=".8" transform="rotate(30 10 8)"/></svg>`;
  const top = document.createElement("nav");
  top.id = "siteTop";
  top.innerHTML = `<div class="bar-row"><a class="brand" href="${root}index.html">${logo}Radix</a>` +
    SECTIONS.map(([id, label, href]) => `<a class="pg${id === section ? " on" : ""}" href="${link(href)}">${label}</a>`).join("") + "</div>" +
    (section === "guide" ? `<div class="bar-row bar-sub">${GUIDE.map(([href, label]) => `<a class="pg${href === page ? " on" : ""}" href="${link(href)}">${label}</a>`).join("")}</div>` : "");
  // Two rows: the sticky offsets (var(--top)) grow with the bar
  document.documentElement.classList.toggle("site-sub", section === "guide");
  document.body.prepend(top);
  if (!$("#progress")) {
    document.body.insertAdjacentHTML("afterbegin", `<div id="progress"></div>`);
  }

  // The long pages: a dot per section, and reveal on scroll
  const sections = $$("section[data-title]");
  const nav = $("#nav");
  if (nav) {
    nav.innerHTML = sections.map((s) => `<a href="#${s.id}" data-id="${s.id}"><span>${s.dataset.title}</span><i></i></a>`).join("");
  }
  const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.12 });
  $$(".reveal").forEach((el) => (reducedMotion ? el.classList.add("in") : io.observe(el)));

  // Reference pages: the heading being read, in the contents column
  const toc = $$(".ref-toc a");
  const heads = toc.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);

  const onScroll = () => {
    const h = document.documentElement;
    $("#progress").style.width = `${(h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) * 100}%`;
    if (nav && sections.length > 0) {
      let current = sections[0].id;
      for (const s of sections) {
        if (s.getBoundingClientRect().top < innerHeight * 0.4) current = s.id;
      }
      $$("a", nav).forEach((a) => a.classList.toggle("on", a.dataset.id === current));
    }
    if (heads.length > 0) {
      let current = heads[0].id;
      for (const el of heads) {
        if (el.getBoundingClientRect().top < innerHeight * 0.25) current = el.id;
      }
      toc.forEach((a) => a.classList.toggle("on", decodeURIComponent(a.hash.slice(1)) === current));
    }
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Code samples. Classes (colors in site.css): k keyword, s string, n number
  // or literal, c comment, t type or class, f function call, p property or
  // object key, o operator or punctuation; other identifiers keep the text
  // color. Text nodes are highlighted in place, so elements a page wraps
  // around lines (hover groups) stay, and a sample a page script rewrites is
  // highlighted again. Reference pages mark their language (pre.lang-ts,
  // pre.lang-sh; no class: plain text); site pages' samples are TypeScript
  // unless marked data-plain.
  const KEYWORDS = new Set(("const let var function return if else for while do of in new class extends implements import from export " +
    "default await async type interface static readonly void typeof instanceof switch case break continue throw try catch finally as " +
    "keyof enum declare abstract private protected public get set yield").split(" "));
  const LITERALS = new Set("true false null undefined this NaN Infinity".split(" "));
  const PRIMITIVES = new Set("number string boolean bigint symbol object unknown any never".split(" "));
  const TOKEN = new RegExp([
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.source,
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/.source,
    /\b(0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/.source,
    /([A-Za-z_$][\w$]*)/.source,
    /(=>|\.\.\.|[=!<>]=?=?|&&|\|\||\?\?|[-+*/%&|^~?:]=?|[{}()[\];,.])/.source,
  ].join("|"), "g");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const span = (cls, text) => (cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text));

  const identifierClass = (code, word, start) => {
    if (KEYWORDS.has(word)) return "k";
    if (LITERALS.has(word) || /^[A-Z][A-Z\d_]+$/.test(word)) return "n";
    if (/^[A-Z]/.test(word) || PRIMITIVES.has(word)) return "t";
    const next = code.slice(start + word.length).match(/^\s*(\S\S?)/)?.[1] ?? "";
    if (next[0] === "(") return "f";
    if (code[start - 1] === "." && code[start - 2] !== ".") return "p";
    if (next[0] === ":" || next === "?:") return "p";
    return "";
  };
  const highlightCode = (code) => {
    let out = "";
    let last = 0;
    for (const m of code.matchAll(TOKEN)) {
      out += esc(code.slice(last, m.index));
      last = m.index + m[0].length;
      out += span(m[1] ? "c" : m[2] ? "s" : m[3] ? "n" : m[4] ? identifierClass(code, m[4], m.index) : "o", m[0]);
    }
    return out + esc(code.slice(last));
  };
  const SHELL = /("[^"]*"|'[^']*')|(^|\s)(--?[\w-]+)|^(\s*)([\w./-]+)|([^"'\s]+|\s+)/g;
  const highlightShell = (code) => code.split("\n").map((line) => {
    const hash = line.search(/(^|\s)#/);
    const body = hash < 0 ? line : line.slice(0, hash);
    const html = body.replace(SHELL, (m, str, sp, flag, lead, cmd) =>
      str ? span("s", str) : flag ? esc(sp) + span("n", flag) : cmd ? esc(lead) + span("f", cmd) : esc(m));
    return html + (hash < 0 ? "" : span("c", line.slice(hash)));
  }).join("\n");

  const HIGHLIGHT = new Set(["k", "s", "n", "c", "t", "f", "p", "o"]);
  const highlighterFor = (pre) => {
    if (pre.hasAttribute("data-plain")) return null;
    const lang = [...pre.classList].find((c) => c.startsWith("lang-"))?.slice(5);
    if (lang) return /^(sh|bash|shell|zsh)$/.test(lang) ? highlightShell : /^(ts|tsx|js|mjs|javascript|typescript|json)$/.test(lang) ? highlightCode : null;
    return pre.closest(".doc") ? null : highlightCode;
  };
  const highlightPre = (pre, highlighter) => {
    // Undo earlier highlighting (the pages' own spans or a previous pass), then tokenize each text node
    for (const el of pre.querySelectorAll("span")) {
      if (el.attributes.length === 1 && HIGHLIGHT.has(el.className)) el.replaceWith(...el.childNodes);
    }
    pre.normalize();
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const text of texts) {
      const template = document.createElement("template");
      template.innerHTML = highlighter(text.data);
      text.replaceWith(template.content);
    }
  };
  const samples = $$("pre").map((pre) => [pre, highlighterFor(pre)]).filter(([, h]) => h);
  const highlighters = new Map(samples);
  const watch = () => samples.forEach(([pre]) => codeObserver.observe(pre, { childList: true, characterData: true, subtree: true }));
  const codeObserver = new MutationObserver((records) => {
    codeObserver.disconnect();
    const changed = new Set(records.map((r) => (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest("pre")));
    changed.forEach((pre) => pre && highlightPre(pre, highlighters.get(pre)));
    codeObserver.takeRecords();
    watch();
  });
  samples.forEach(([pre, h]) => highlightPre(pre, h));
  watch();
})();
