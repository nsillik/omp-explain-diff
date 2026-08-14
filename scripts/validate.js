#!/usr/bin/env bun
// explain-diff-html validator.
// Zero dependencies. Usage: bun scripts/validate.js <file>
// Exit 0 + one-line summary on pass; exit 1 + every failure listed on fail.

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/validate.js <file>");
  process.exit(1);
}

let html;
try {
  html = readFileSync(file, "utf8");
} catch (err) {
  console.error(`[FAIL] cannot read ${file}: ${err.message}`);
  process.exit(1);
}

const failures = [];
const TAG_SET = new Set([
  "div", "section", "pre", "button", "table", "ul", "ol", "li", "p",
  "span", "a", "h1", "h2", "h3", "nav", "main", "header", "footer",
  "details", "summary", "script", "style",
]);
const RAW_TEXT = new Set(["pre", "script", "style"]);

// ---------- check 1: exists and non-empty ----------
if (!html.trim()) {
  failures.push("file is empty");
}

// ---------- check 2: no PLACEHOLDER_ tokens ----------
// Raw-text <pre> bodies may legitimately quote the token; drop them.
const placeholders = html
  .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, "")
  .match(/PLACEHOLDER_[A-Z_]+/g);
if (placeholders) {
  failures.push(
    `placeholder tokens remain: ${[...new Set(placeholders)].join(", ")}`,
  );
}

// ---------- check 3: tag balance ----------
function checkTags(src) {
  const stack = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("</", lt)) {
      const name = readTagName(src, lt + 2);
      if (!name) { i = lt + 2; continue; }
      const lower = name.toLowerCase();
      if (!TAG_SET.has(lower)) { i = lt + 2 + name.length; continue; }
      const top = stack.pop();
      if (!top || top.name !== lower) {
        return `mismatched closing tag </${lower}> (line ${lineAt(src, lt)})`;
      }
      i = lt + 2 + name.length;
      continue;
    }
    const name = readTagName(src, lt + 1);
    if (!name) { i = lt + 1; continue; }
    const lower = name.toLowerCase();
    i = skipTag(src, lt);
    if (!TAG_SET.has(lower)) continue;
    if (RAW_TEXT.has(lower)) {
      const close = findRawClose(src, i, lower);
      if (close === -1) {
        return `unclosed <${lower}> (line ${lineAt(src, lt)})`;
      }
      i = skipTag(src, close);
      continue;
    }
    // self-closing or void-ish: don't push
    if (isSelfClosing(src, lt)) continue;
    stack.push({ name: lower, line: lineAt(src, lt) });
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return `unclosed <${top.name}> (line ${top.line})`;
  }
  return null;
}

function readTagName(src, start) {
  let j = start;
  while (j < src.length && /\s/.test(src[j])) j++;
  let k = j;
  while (k < src.length && /[a-zA-Z0-9-]/.test(src[k])) k++;
  return k > j ? src.slice(j, k) : null;
}

// advance past the full tag, honoring quoted attribute values
function skipTag(src, lt) {
  let quote = null;
  let j = lt + 1;
  while (j < src.length) {
    const ch = src[j];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return j + 1;
    }
    j++;
  }
  return src.length;
}

function isSelfClosing(src, lt) {
  const end = skipTag(src, lt);
  for (let j = end - 2; j >= lt; j--) {
    const ch = src[j];
    if (ch === ">") break;
    if (/\s/.test(ch)) continue;
    return ch === "/";
  }
  return false;
}

function findRawClose(src, from, tag) {
  const needle = `</${tag}`;
  let idx = from;
  while (true) {
    const hit = src.toLowerCase().indexOf(needle.toLowerCase(), idx);
    if (hit === -1) return -1;
    const after = src[hit + needle.length];
    if (after === undefined || /\s|>/.test(after)) return hit;
    idx = hit + needle.length;
  }
}

function lineAt(src, idx) {
  let line = 1;
  for (let j = 0; j < idx && j < src.length; j++) {
    if (src[j] === "\n") line++;
  }
  return line;
}

const tagError = checkTags(html);
if (tagError) failures.push(`tag balance: ${tagError}`);

// Regex checks below must not match inside <script>/<style>/<pre> bodies
// (raw text: JS comments or code samples may quote markup). Keep the
// tags, drop the contents.
const structural = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    const gt = m.indexOf(">");
    return m.slice(0, gt + 1) + "</script>";
  })
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => {
    const gt = m.indexOf(">");
    return m.slice(0, gt + 1) + "</style>";
  })
  .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, (m) => {
    const gt = m.indexOf(">");
    return m.slice(0, gt + 1) + "</pre>";
  });

// ---------- check 4: one main#content, four sections with h2 ----------
const mains = structural.match(/<\s*main\b[^>]*\bid\s*=\s*["']content["'][^>]*>/gi);
if (!mains || mains.length !== 1) {
  failures.push(`expected exactly one <main id="content">, found ${mains ? mains.length : 0}`);
}

for (const id of ["background", "intuition", "code", "quiz"]) {
  const open = new RegExp(
    `<\\s*section\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`,
    "i",
  );
  const m = open.exec(structural);
  if (!m) {
    failures.push(`missing <section id="${id}">`);
    continue;
  }
  const close = structural.toLowerCase().indexOf("</section>", m.index + m[0].length);
  const body =
    close === -1 ? structural.slice(m.index) : structural.slice(m.index, close);
  if (!/<\s*h2\b/i.test(body)) {
    failures.push(`section ${id} has no <h2>`);
  }
}

// ---------- check 5: quiz contract ----------
const questions = [...structural.matchAll(/<\s*div\b[^>]*\bclass\s*=\s*["'][^"']*\bquiz-question\b[^"']*["'][^>]*>/gi)];
if (questions.length !== 5) {
  failures.push(`expected exactly 5 quiz questions, found ${questions.length}`);
}

questions.forEach((m, qi) => {
  const block = sliceToCloseDiv(structural, m.index);
  const options = [...block.matchAll(/<\s*button\b[^>]*\bclass\s*=\s*["'][^"']*\bquiz-option\b[^"']*["'][^>]*>/gi)];
  if (options.length < 3) {
    failures.push(`question ${qi + 1}: expected at least 3 quiz options, found ${options.length}`);
  }
  const correct = (block.match(/data-correct\s*=\s*["']true["']/gi) || []).length;
  if (correct !== 1) {
    failures.push(`question ${qi + 1}: expected exactly one data-correct="true", found ${correct}`);
  }
  const fb = /<\s*div\b[^>]*\bclass\s*=\s*["'][^"']*\bquiz-feedback\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block);
  if (!fb || !fb[1].trim()) {
    failures.push(`question ${qi + 1}: missing non-empty .quiz-feedback`);
  }
});

// ---------- check 6: mermaid ----------
const mermaidBlocks = structural.match(/<\s*pre\b[^>]*\bclass\s*=\s*["'][^"']*\bmermaid\b[^"']*["'][^>]*>/gi);
if (mermaidBlocks && mermaidBlocks.length > 0) {
  const mermaidScript = structural.match(/<\s*script\b[^>]*\bsrc\s*=\s*["'][^"']*mermaid[^"']*["'][^>]*>/i);
  if (!mermaidScript) {
    failures.push(`${mermaidBlocks.length} mermaid block(s) without a mermaid <script src=...>`);
  }
}

// ---------- check 7: diffstat ----------
const dsMatch = /<\s*details\b[^>]*\bclass\s*=\s*["'][^"']*\bdiffstat\b[^"']*["'][^>]*>([\s\S]*?)<\/details>/i.exec(structural);
if (!dsMatch) {
  failures.push('missing <details class="diffstat"> in header');
} else {
  const inner = dsMatch[1];
  const sum = /<\s*summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
  if (!sum) {
    failures.push('diffstat: missing <summary>');
  } else {
    const statAdd = /class\s*=\s*["'][^"']*\bstat-add\b[^"']*["'][^>]*>([^<]*)</i.exec(sum[1]);
    const statDel = /class\s*=\s*["'][^"']*\bstat-del\b[^"']*["'][^>]*>([^<]*)</i.exec(sum[1]);
    const statFiles = /class\s*=\s*["'][^"']*\bstat-files\b[^"']*["'][^>]*>([^<]*)</i.exec(sum[1]);
    if (!statAdd || !/^\s*\+\d+\s*$/.test(statAdd[1])) {
      failures.push('diffstat: expected <span class="stat-add">+N</span> in summary');
    }
    if (!statDel || !/^\s*-\d+\s*$/.test(statDel[1])) {
      failures.push('diffstat: expected <span class="stat-del">-N</span> in summary');
    }
    if (!statFiles || !/^\s*\d+\s+files?\s*$/.test(statFiles[1])) {
      failures.push('diffstat: expected <span class="stat-files">N files</span> in summary');
    }
    const filesN = statFiles ? parseInt(statFiles[1], 10) : 0;
    const list = /<\s*ul\b[^>]*\bclass\s*=\s*["'][^"']*\bdiffstat-files\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i.exec(inner);
    if (!list) {
      failures.push('diffstat: missing <ul class="diffstat-files">');
    } else {
      const rows = [...list[1].matchAll(/<\s*li\b[^>]*>([\s\S]*?)<\/li>/gi)];
      const binOrSize = /^\s*(?:[+-]\d+|binary|\d+(?:\.\d+)?\s*[kmgt]?i?b?)\s*$/i;
      if (filesN > 0 && rows.length === 0) {
        failures.push('diffstat: expected per-file rows, found none');
      }
      rows.forEach((r, i) => {
        const name = /class\s*=\s*["'][^"']*\bfile-name\b[^"']*["'][^>]*>([\s\S]*?)</i.exec(r[1]);
        const add = /class\s*=\s*["'][^"']*\bfile-add\b[^"']*["'][^>]*>([^<]*)</i.exec(r[1]);
        const del = /class\s*=\s*["'][^"']*\bfile-del\b[^"']*["'][^>]*>([^<]*)</i.exec(r[1]);
        if (!name || !name[1].trim()) {
          failures.push(`diffstat file ${i + 1}: missing .file-name`);
        }
        if (!add || !binOrSize.test(add[1])) {
          failures.push(`diffstat file ${i + 1}: expected .file-add [+N|-N|binary|byte size]`);
        }
        if (!del || !binOrSize.test(del[1])) {
          failures.push(`diffstat file ${i + 1}: expected .file-del [-N|+N|binary|byte size]`);
        }
      });
    }
  }
}

// ---------- summary ----------
const sectionsFound = ["background", "intuition", "code", "quiz"].filter(
  (id) => new RegExp(`<\\s*section\\b[^>]*\\bid\\s*=\\s*["']${id}["']`, "i").test(structural),
).length;

if (failures.length > 0) {
  console.error(`FAIL ${file}:`);
  failures.forEach((f) => console.error(`  - ${f}`));
  console.error(
    `summary: ${sectionsFound}/4 sections, ${questions.length} quiz questions, ${failures.length} failure(s)`,
  );
  process.exit(1);
}

console.log(
  `OK ${file}: ${sectionsFound}/4 sections, ${questions.length} quiz questions, diffstat OK, all checks passed`,
);

// ---------- helpers ----------
// Given the index of an opening <div ...>, return the element text through
// its matching </div>, accounting for nested divs.
function sliceToCloseDiv(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("</div", lt) && /[\s>]/.test(src[lt + 5] || ">")) {
      depth--;
      i = skipTag(src, lt);
      if (depth === 0) return src.slice(openIdx, i);
      continue;
    }
    const name = readTagName(src, lt + 1);
    if (name && name.toLowerCase() === "div" && !isSelfClosing(src, lt)) {
      depth++;
    }
    i = skipTag(src, lt);
  }
  return src.slice(openIdx);
}
