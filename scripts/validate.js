#!/usr/bin/env bun
// explain-diff-html validator.
// Parsing: parse5 (WHATWG-compliant tree builder) for structure checks, plus
// htmlparser2's raw-text-aware tokenizer for strict tag balance — parse5
// silently repairs unbalanced tags. Both consume the original source.
// Usage: bun scripts/validate.js <file>
// Exit 0 + one-line summary on pass; exit 1 + every failure listed on fail.

import { readFileSync } from "node:fs";
import { parse } from "parse5";
import { Tokenizer } from "htmlparser2";

// ---------- DOM helpers (parse5: plain tree, no querySelector) ----------
function childElements(node) {
  return (node.childNodes || []).filter((n) => n.tagName);
}
function walk(node, pred, out = []) {
  if (node.tagName && pred(node)) out.push(node);
  for (const c of childElements(node)) walk(c, pred, out);
  return out;
}
function findElements(root, pred) {
  return walk(root, pred);
}
function attr(el, name) {
  const a = el.attrs.find((x) => x.name === name);
  return a ? a.value : null;
}
function hasClass(el, token) {
  const cls = attr(el, "class");
  return !!cls && cls.split(/\s+/).includes(token);
}
function directText(el) {
  return (el.childNodes || [])
    .filter((n) => n.nodeName === "#text")
    .map((n) => n.value)
    .join("");
}
// Non-empty like the previous `([\s\S]*?)<` capture: any element child or any
// non-whitespace text counts; whitespace-only text does not.
function hasContent(el) {
  return (el.childNodes || []).some(
    (n) => n.tagName || (n.nodeName === "#text" && n.value.trim() !== ""),
  );
}

function ancestor(node, pred) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (parent.tagName && pred(parent)) return parent;
  }
  return null;
}

function isClickableOption(option) {
  if (option.tagName !== "button" || attr(option, "disabled") !== null) return false;
  if (attr(option, "hidden") !== null || attr(option, "inert") !== null) return false;
  return !ancestor(option, (parent) => {
    if (attr(parent, "hidden") !== null || attr(parent, "inert") !== null) return true;
    if (parent.tagName !== "fieldset" || attr(parent, "disabled") === null) return false;
    // A disabled fieldset exempts controls inside its first legend.
    const legend = childElements(parent).find((el) => el.tagName === "legend");
    return !legend || !ancestor(option, (el) => el === legend);
  });
}

// ---------- check 3: tag balance ----------
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function checkBalance(src) {
  const failures = [];
  const stack = []; // { name, line }
  let lastOpen = null;

  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\r") {
      if (src[i + 1] === "\n") i++;
      lineStarts.push(i + 1);
    } else if (src[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const tok = new Tokenizer({ xmlMode: false, decodeEntities: false }, {
    onopentagname(start, end) {
      lastOpen = {
        name: src.slice(start, end).toLowerCase(),
        line: lineOf(start),
      };
    },
    onopentagend() {
      if (lastOpen) {
        if (!VOID.has(lastOpen.name)) stack.push(lastOpen);
        lastOpen = null;
      }
    },
    onselfclosingtag() {
      lastOpen = null; // <x/> — self-closing, nothing to balance
    },
    onclosetag(start, end) {
      const name = src.slice(start, end).toLowerCase();
      if (VOID.has(name)) return; // </br> etc. — browsers treat as void
      const top = stack[stack.length - 1];
      if (top && top.name === name) {
        stack.pop();
        return;
      }
      const idx = stack.findLastIndex((s) => s.name === name);
      failures.push(`mismatched closing tag </${name}> (line ${lineOf(start)})`);
      if (idx !== -1) {
        for (let i = stack.length - 1; i > idx; i--) {
          failures.push(`unclosed <${stack[i].name}> (line ${stack[i].line})`);
        }
        stack.length = idx;
      }
    },
    // tokenizer bookkeeping — content is irrelevant to balance
    onattribdata() {}, onattribentity() {}, onattribend() {}, onattribname() {},
    oncdata() {}, oncomment() {}, ondeclaration() {}, onprocessinginstruction() {},
    ontext() {}, ontextentity() {}, onend() {},
  });
  tok.write(src);
  tok.end();

  for (const s of [...stack].reverse()) {
    failures.push(`unclosed <${s.name}> (line ${s.line})`);
  }
  return failures;
}

// ---------- validation ----------
export function validate(html) {
  const failures = [];

  // check 1: exists and non-empty
  if (!html.trim()) {
    failures.push("file is empty");
  }

  // check 2: no PLACEHOLDER_ tokens
  const placeholders = html.match(/PLACEHOLDER_[A-Z_]+/g);
  if (placeholders) {
    failures.push(
      `placeholder tokens remain: ${[...new Set(placeholders)].join(", ")}`,
    );
  }

  // check 3: tag balance — token-level (htmlparser2) + parser errors (parse5).
  // parse5's recovery rules silently repair unbalanced tags, so the tokenizer
  // pass catches unclosed/mismatched tags; parse5 catches the rest (duplicate
  // attributes, malformed comments, unclosed raw-text elements, truncated
  // tags). Doctype errors and raw "<" in prose are tolerated — the previous
  // checker never flagged either.
  const parseErrors = [];
  const doc = parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: (err) => parseErrors.push(err),
  });
  parseErrors
    .sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0))
    .forEach((err) => {
      if (/doctype|invalid-first-character-of-tag-name/.test(err.code)) return;
      failures.push(
        `tag balance: ${err.code} (line ${err.startLine}:${err.startCol})`,
      );
    });
  checkBalance(html).forEach((f) => failures.push(`tag balance: ${f}`));

  // ---------- check 4: one main#content, four sections with h2 ----------
  const mains = findElements(
    doc,
    (el) => el.tagName === "main" && attr(el, "id") === "content",
  );
  if (mains.length !== 1) {
    failures.push(
      `expected exactly one <main id="content">, found ${mains.length}`,
    );
  }

  const SECTION_IDS = ["background", "intuition", "code", "quiz"];
  const sectionsFound = [];
  for (const id of SECTION_IDS) {
    const section = findElements(
      doc,
      (el) => el.tagName === "section" && attr(el, "id") === id,
    )[0];
    if (!section) {
      failures.push(`missing <section id="${id}">`);
      continue;
    }
    sectionsFound.push(id);
    if (findElements(section, (el) => el.tagName === "h2").length !== 1) {
      failures.push(`section ${id}: expected one <h2>; use <h3> for subheadings`);
    }
  }

  // ---------- check 5: quiz contract ----------
  const quizzes = findElements(
    doc,
    (el) => hasClass(el, "quiz") && attr(el, "data-quiz") !== null,
  );
  if (quizzes.length !== 1) {
    failures.push(`expected exactly one .quiz[data-quiz], found ${quizzes.length}`);
  }
  const questions = findElements(doc, (el) => hasClass(el, "quiz-question"));
  if (questions.length !== 5) {
    failures.push(`expected exactly 5 quiz questions, found ${questions.length}`);
  }

  questions.forEach((q, qi) => {
    if (q.tagName !== "div" || attr(q, "data-question") === null) {
      failures.push(`question ${qi + 1}: expected div.quiz-question[data-question]`);
    }
    if (quizzes.length !== 1 || !ancestor(q, (el) => el === quizzes[0])) {
      failures.push(`question ${qi + 1}: must belong to the .quiz[data-quiz] container`);
    }
    if (ancestor(q, (el) => hasClass(el, "quiz-question"))) {
      failures.push(`question ${qi + 1}: quiz questions must not be nested`);
    }
    const options = findElements(q, (el) => hasClass(el, "quiz-option"));
    if (options.length < 3) {
      failures.push(
        `question ${qi + 1}: expected at least 3 quiz options, found ${options.length}`,
      );
    }
    let correct = 0;
    for (const option of options) {
      const clickable = isClickableOption(option);
      const value = attr(option, "data-correct");
      if (!clickable) {
        failures.push(`question ${qi + 1}: .quiz-option must be an enabled, clickable button`);
      }
      if (value !== "true" && value !== "false") {
        failures.push(`question ${qi + 1}: quiz options require literal data-correct="true" or "false"`);
      }
      if (clickable && value === "true") correct++;
    }
    if (correct !== 1) {
      failures.push(
        `question ${qi + 1}: expected exactly one enabled correct option, found ${correct}`,
      );
    }
    const feedback = findElements(q, (el) => hasClass(el, "quiz-feedback"))[0];
    if (!feedback || !hasContent(feedback)) {
      failures.push(`question ${qi + 1}: missing non-empty .quiz-feedback`);
    }
  });

  // ---------- check 6: mermaid ----------
  const mermaidBlocks = findElements(
    doc,
    (el) => el.tagName === "pre" && hasClass(el, "mermaid"),
  );
  if (mermaidBlocks.length > 0) {
    const peleScript = findElements(
      doc,
      (el) =>
        el.tagName === "script" &&
        ((attr(el, "src") ?? "").includes("pele") ||
          (attr(el, "data-pele-src") ?? "").includes("pele")),
    );
    if (peleScript.length === 0) {
      failures.push(
        `${mermaidBlocks.length} mermaid block(s) without a Pele script source`,
      );
    }
  }

  // ---------- check 7: diffstat ----------
  const details = findElements(
    doc,
    (el) => el.tagName === "details" && hasClass(el, "diffstat"),
  )[0];
  if (!details) {
    failures.push('missing <details class="diffstat"> in header');
  } else {
    const summary = findElements(details, (el) => el.tagName === "summary")[0];
    if (!summary) {
      failures.push("diffstat: missing <summary>");
    } else {
      const span = (cls) => findElements(summary, (el) => hasClass(el, cls))[0];
      const statAdd = span("stat-add");
      const statDel = span("stat-del");
      const statFiles = span("stat-files");
      if (!statAdd || !/^\s*\+\d+\s*$/.test(directText(statAdd))) {
        failures.push('diffstat: expected <span class="stat-add">+N</span> in summary');
      }
      if (!statDel || !/^\s*-\d+\s*$/.test(directText(statDel))) {
        failures.push('diffstat: expected <span class="stat-del">-N</span> in summary');
      }
      if (!statFiles || !/^\s*\d+\s+files?\s*$/.test(directText(statFiles))) {
        failures.push('diffstat: expected <span class="stat-files">N files</span> in summary');
      }
      const filesN = statFiles ? parseInt(directText(statFiles), 10) : 0;
      const list = findElements(
        details,
        (el) => el.tagName === "ul" && hasClass(el, "diffstat-files"),
      )[0];
      if (!list) {
        failures.push('diffstat: missing <ul class="diffstat-files">');
      } else {
        const rows = findElements(list, (el) => el.tagName === "li");
        const binOrSize = /^\s*(?:[+-]\d+|binary|\d+(?:\.\d+)?\s*[kmgt]?i?b?)\s*$/i;
        if (filesN > 0 && rows.length === 0) {
          failures.push("diffstat: expected per-file rows, found none");
        }
        rows.forEach((r, i) => {
          const name = findElements(r, (el) => hasClass(el, "file-name"))[0];
          const add = findElements(r, (el) => hasClass(el, "file-add"))[0];
          const del = findElements(r, (el) => hasClass(el, "file-del"))[0];
          if (!name || !hasContent(name)) {
            failures.push(`diffstat file ${i + 1}: missing .file-name`);
          }
          if (!add || !binOrSize.test(directText(add))) {
            failures.push(`diffstat file ${i + 1}: expected .file-add [+N|-N|binary|byte size]`);
          }
          if (!del || !binOrSize.test(directText(del))) {
            failures.push(`diffstat file ${i + 1}: expected .file-del [-N|+N|binary|byte size]`);
          }
        });
      }
    }
  }

  return { failures, sectionsFound: sectionsFound.length, questionCount: questions.length };
}

// ---------- CLI ----------
if (import.meta.main) {
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
  const { failures, sectionsFound, questionCount } = validate(html);
  if (failures.length > 0) {
    console.error(`FAIL ${file}:`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error(
      `summary: ${sectionsFound}/4 sections, ${questionCount} quiz questions, ${failures.length} failure(s)`,
    );
    process.exit(1);
  }
  console.log(
    `OK ${file}: ${sectionsFound}/4 sections, ${questionCount} quiz questions, diffstat OK, all checks passed`,
  );
}
