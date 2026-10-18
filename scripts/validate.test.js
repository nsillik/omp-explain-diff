import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./validate.js";

// ---------- helpers ----------
function doc(body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

function question(n, { options = 4, correct = 2, feedback = "<div class=\"quiz-feedback\" hidden>Feedback.</div>" } = {}) {
  const opts = Array.from({ length: options }, (_, i) => {
    const isCorrect = i + 1 === correct;
    return `<button class="quiz-option" data-correct="${isCorrect}">opt ${i + 1}</button>`;
  }).join("");
  return `<div class="quiz-question" data-question>
    <p class="quiz-q">${n}. Q</p>
    <div class="quiz-options">${opts}</div>
    ${feedback}
  </div>`;
}

const QUIZ = [1, 2, 3, 4, 5].map((n) => question(n)).join("");

const DIFFSTAT = `<details class="diffstat">
  <summary><span class="stat-add">+40</span><span class="stat-del">-5</span><span class="stat-files">1 file</span></summary>
  <ul class="diffstat-files"><li><code class="file-name">a.ex</code><span class="file-add">+40</span><span class="file-del">-5</span></li></ul>
</details>`;

function full(extra = "", { diffstat = DIFFSTAT, quiz = QUIZ } = {}) {
  return doc(`
    <main id="content">
      <section id="background"><h2>Background</h2><p>bg</p></section>
      <section id="intuition"><h2>Intuition</h2><p>it</p></section>
      <section id="code"><h2>Code</h2><p>cd</p></section>
      <section id="quiz"><h2>Quiz</h2><div class="quiz" data-quiz>${quiz}</div></section>
    </main>
    ${diffstat}
    ${extra}
  `);
}

function runValidatorCli(html) {
  const directory = mkdtempSync(join(tmpdir(), "explain-diff-validator-"));
  try {
    const file = join(directory, "explanation.html");
    writeFileSync(file, html);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./validate.js", import.meta.url)),
      file,
    ], { encoding: "utf8" });
    if (result.error) throw result.error;
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectRejected(html) {
  expect(runValidatorCli(html).status).toBe(1);
}

// ---------- happy path ----------
test("valid document passes", () => {
  expect(validate(full()).failures).toEqual([]);
});

test("valid document succeeds through the CLI", () => {
  expect(runValidatorCli(full()).status).toBe(0);
});

test("real generated doc passes", () => {
  const html = readFileSync("docs/2026-08-14-explanation-pr-1.html", "utf8");
  expect(validate(html).failures).toEqual([]);
});

// ---------- check 1/2 ----------
test("empty file fails", () => {
  expectRejected("");
});

test("placeholder tokens fail", () => {
  expectRejected(full(`<h1>PLACEHOLDER_TITLE</h1>`));
});

// ---------- check 3: tag balance ----------
test("unclosed div fails", () => {
  expectRejected(full() + "<div>dangling");
});

test("stray closing tag fails", () => {
  expectRejected(full() + "</div>");
});

test("mismatched nesting fails", () => {
  expectRejected(full() + "<div><span></div>");
});

test("unclosed non-whitelisted tag fails (figure)", () => {
  expectRejected(full() + "<figure>orphan");
});

test("code sample with < inside pre passes", () => {
  const { failures } = validate(full(`<pre>if (a < b) return;</pre>`));
  expect(failures).toEqual([]);
});

test("mermaid arrows inside pre pass with a loader", () => {
  expect(validate(full(
    `<pre class="mermaid">graph TD\n  A-->B</pre>` +
      `<script src="https://cdn.jsdelivr.net/npm/pele@1.6.0/dist/pele.global.js"></script>`,
  )).failures).toEqual([]);
});

test("script body quoting markup passes", () => {
  const { failures } = validate(
    full(`<script>const s = '<main id="content">';</script>`),
  );
  expect(failures).toEqual([]);
});

test("quoted greater-than signs in raw-text opening attributes pass", () => {
  expect(validate(full(
    `<script data-label=">">const s = '<main id="content">';</script>` +
      `<style data-label='>'>.x::before { content: "<div>"; }</style>`,
  )).failures).toEqual([]);
});

test("whitespace after raw-text closing names passes", () => {
  expect(validate(full(
    `<script>const s = "<div>";</script \n\t>` +
      `<style>.x::before { content: "<span>"; }</style \t>`,
  )).failures).toEqual([]);
});

test("balanced live markup and escaped code in pre pass", () => {
  expect(validate(full(
    `<pre><code>&lt;div&gt;literal&lt;/div&gt;</code><em>live</em></pre>`,
  )).failures).toEqual([]);
});

test("unbalanced live markup in pre fails", () => {
  expectRejected(full(`<pre><div>live</pre>`));
});

test("duplicate attributes in pre are not stripped", () => {
  expectRejected(full(`<pre><span id="a" id="b">live</span></pre>`));
});

test("raw-text contents cannot manufacture required DOM elements", () => {
  const html = full(`<script>const s = '<section id="code"><h2>Code</h2></section>';</script>`)
    .replace(`<section id="code"><h2>Code</h2><p>cd</p></section>`, "");
  const result = validate(html);
  expectRejected(html);
  expect(result.sectionsFound).toBe(3);
});

test("balance diagnostics retain source lines after multiline raw text", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const prefix = `<script>${newline}const s = "<div>";${newline}</script>${newline}` +
      `<style>${newline}.x { color: red; }${newline}</style>${newline}`;
    const html = full(prefix + `<figure>dangling`);
    const { failures } = validate(html);
    const line = html.slice(0, html.indexOf("<figure>")).split(/\r\n|\r|\n/).length;
    expect(failures.some((failure) => /<figure>/.test(failure) &&
      failure.endsWith(`(line ${line})`))).toBe(true);
  }
});

test("parse diagnostics retain source lines after multiline raw text", () => {
  const extra = `<script>\nconst s = "<div>";\n</script>\n` +
    `<style>\n.x { color: red; }\n</style>\n` +
    `<div id="a" id="b">live</div>`;
  const html = full(extra);
  const line = html.slice(0, html.indexOf(`<div id="a"`)).split("\n").length;
  expect(validate(html).failures.some((failure) =>
    failure.includes(`(line ${line}:`))).toBe(true);
});

test("duplicate attribute fails", () => {
  expectRejected(full(`<div id="a" id="b">x</div>`));
});

test("unclosed comment fails", () => {
  expectRejected(full("<!-- never closed"));
});

test("void elements pass", () => {
  const { failures } = validate(full(`<p>a<br>b<br/>c<img src="x"></p>`));
  expect(failures).toEqual([]);
});

test("non-void self-closing tag fails (unclosed div)", () => {
  expectRejected(full(`<div/>`));
});

// ---------- check 4: sections ----------
test("missing section fails", () => {
  expectRejected(
    full().replace(`<section id="code"><h2>Code</h2><p>cd</p></section>`, ""),
  );
});

test("section without h2 fails", () => {
  expectRejected(
    full().replace(
      `<section id="intuition"><h2>Intuition</h2><p>it</p></section>`,
      `<section id="intuition"><p>no heading</p></section>`,
    ),
  );
});

test("duplicate section headings fail instead of creating duplicate TOC entries", () => {
  expectRejected(full().replace("<p>cd</p>", "<h2>Repeated Code heading</h2><p>cd</p>"));
  expect(validate(full().replace("<p>cd</p>", "<h3>Code detail</h3><p>cd</p>")).failures).toEqual([]);
});

test("two mains fail", () => {
  expectRejected(full(`<main id="content"><p>second</p></main>`));
});

test("data-id does not count as id", () => {
  expectRejected(
    full().replace(
      `<main id="content">`,
      `<main data-id="content">`,
    ),
  );
});

test("comment containing fake markup does not count", () => {
  const { failures } = validate(
    full(`<!-- <main id="content"> -->`),
  );
  expect(failures).toEqual([]);
});

// ---------- check 5: quiz ----------
test("wrong question count fails", () => {
  const quiz = [1, 2, 3, 4].map((n) => question(n)).join("");
  expectRejected(full("", { quiz }));
});

test("too few options fails", () => {
  const quiz = [1, 2, 3, 4, 5].map((n) => question(n, { options: 2 })).join("");
  expectRejected(full("", { quiz }));
});

test("no correct option fails", () => {
  const quiz = [1, 2, 3, 4, 5].map((n) => question(n, { correct: 0 })).join("");
  expectRejected(full("", { quiz }));
});

test("two correct options fail", () => {
  const quiz = [1, 2, 3, 4, 5]
    .map((n) =>
      question(n).replace(
        'data-correct="false">opt 3',
        'data-correct="true">opt 3',
      ),
    )
    .join("");
  expectRejected(full("", { quiz }));
});

test("empty feedback fails", () => {
  const quiz = [1, 2, 3, 4, 5]
    .map((n) => question(n, { feedback: '<div class="quiz-feedback" hidden></div>' }))
    .join("");
  expectRejected(full("", { quiz }));
});

test("feedback with nested div passes", () => {
  const quiz = [1, 2, 3, 4, 5]
    .map((n) =>
      question(n, {
        feedback: '<div class="quiz-feedback" hidden><div>inner</div> text</div>',
      }),
    )
    .join("");
  expect(validate(full("", { quiz })).failures).toEqual([]);
});

test("initial feedback visibility does not change quiz validity", () => {
  const quiz = QUIZ.replaceAll('class="quiz-feedback" hidden', 'class="quiz-feedback"');
  expect(validate(full("", { quiz })).failures).toEqual([]);
});

test("quiz requires one marked container around all questions", () => {
  const valid = full();
  for (const html of [
    valid.replace('class="quiz" data-quiz', 'class="quiz"'),
    valid.replace('class="quiz" data-quiz', 'data-quiz'),
    full(`<div class="quiz" data-quiz></div>`),
    full().replace(`<div class="quiz" data-quiz>${QUIZ}</div>`, QUIZ),
    full().replace(`<div class="quiz" data-quiz>${QUIZ}</div>`,
      `<div class="quiz" data-quiz>${QUIZ.slice(question(1).length)}</div>${question(1)}`),
  ]) {
    expectRejected(html);
  }
});

test("question elements require the browser contract and cannot nest", () => {
  for (const quiz of [
    QUIZ.replace("data-question", ""),
    QUIZ.replace(question(1), question(1).replace("<div ", "<article ").replace(/\s*<\/div>$/, "</article>")),
    question(1).replace('<div class="quiz-options">', `${question(2)}<div class="quiz-options">`) +
      [3, 4, 5].map((n) => question(n)).join(""),
  ]) {
    expectRejected(full("", { quiz }));
  }
});

test("every option must be an enabled button with a literal correctness value", () => {
  for (const replacement of [
    'data-correct="TRUE"',
    'data-correct=" true "',
    'data-correct="yes"',
    'data-correct',
    'data-correct="true" disabled',
    'data-correct="true" hidden',
    'data-correct="true" inert',
  ]) {
    const quiz = QUIZ.replace('data-correct="true"', replacement);
    expectRejected(full("", { quiz }));
  }
  for (const quiz of [
    QUIZ.replace('data-correct="false"', 'data-correct="FALSE"'),
    QUIZ.replace('data-correct="false"', ""),
    QUIZ.replace('class="quiz-option" data-correct="false"', 'class="quiz-option" data-correct="false" disabled'),
    QUIZ.replace(/<button\b/g, "<span").replaceAll("</button>", "</span>"),
    QUIZ.replace('<div class="quiz-options">', '<fieldset disabled class="quiz-options">')
      .replace("</button></div>", "</button></fieldset>"),
  ]) {
    expectRejected(full("", { quiz }));
  }
});

test("correct markers on non-options do not count", () => {
  const quiz = QUIZ.replace('data-correct="true"', 'data-correct="false"')
    .replace('class="quiz-q"', 'class="quiz-q" data-correct="true"');
  expectRejected(full("", { quiz }));
});

test("disabled fieldset first-legend exception remains clickable", () => {
  const quiz = QUIZ.replace('<div class="quiz-options">', '<fieldset disabled><legend><div class="quiz-options">')
    .replace("</button></div>", "</button></div></legend></fieldset>");
  expect(validate(full("", { quiz })).failures).toEqual([]);
});

// ---------- check 6: mermaid ----------
test("mermaid block without script fails", () => {
  expectRejected(full(`<pre class="mermaid">graph TD\n  A-->B</pre>`));
});

test("mermaid block with Pele script passes", () => {
  const { failures } = validate(
    full(
      `<pre class="mermaid">graph TD\n  A-->B</pre>` +
        `<script src="https://cdn.jsdelivr.net/npm/pele@1.6.0/dist/pele.global.js"></script>`,
    ),
  );
  expect(failures).toEqual([]);
});

test("mermaid block with an explicit Pele lazy loader passes", () => {
  expect(validate(full(
    `<pre class="mermaid">graph TD\n  A-->B</pre>` +
      `<script data-pele-src="https://cdn.jsdelivr.net/npm/pele@1.6.0/dist/pele.global.js">const source = document.currentScript.dataset.peleSrc;</script>`,
  )).failures).toEqual([]);
});

test("incidental Pele script text is not a loader", () => {
  expectRejected(full(
    `<pre class="mermaid">graph TD\n  A-->B</pre>` +
      `<script>const source = "https://cdn.jsdelivr.net/npm/pele@1.6.0/dist/pele.global.js";</script>`,
  ));
});

// ---------- check 7: diffstat ----------
test("missing diffstat fails", () => {
  expectRejected(full("", { diffstat: "" }));
});

test("bad stat-add fails", () => {
  const ds = DIFFSTAT.replace("+40</span>", "+40x</span>");
  expectRejected(full("", { diffstat: ds }));
});

test("bad stat-files fails", () => {
  const ds = DIFFSTAT.replace("1 file</span>", "one file</span>");
  expectRejected(full("", { diffstat: ds }));
});

test("filesN with no rows fails", () => {
  const ds = DIFFSTAT.replace(
    "<li><code class=\"file-name\">a.ex</code><span class=\"file-add\">+40</span><span class=\"file-del\">-5</span></li>",
    "",
  );
  expectRejected(full("", { diffstat: ds }));
});

test("row missing file-name fails", () => {
  const ds = DIFFSTAT.replace('<code class="file-name">a.ex</code>', "");
  expectRejected(full("", { diffstat: ds }));
});

test("binary row passes", () => {
  const ds = `<details class="diffstat">
  <summary><span class="stat-add">+0</span><span class="stat-del">-0</span><span class="stat-files">1 file</span></summary>
  <ul class="diffstat-files"><li><code class="file-name">logo.png</code><span class="file-add">2.3 KB</span><span class="file-del">binary</span></li></ul>
</details>`;
  expect(validate(full("", { diffstat: ds })).failures).toEqual([]);
});

// ---------- summary ----------
test("summary counts match", () => {
  const { failures, sectionsFound, questionCount } = validate(full());
  expect({ failures, sectionsFound, questionCount }).toEqual({
    failures: [],
    sectionsFound: 4,
    questionCount: 5,
  });
});
