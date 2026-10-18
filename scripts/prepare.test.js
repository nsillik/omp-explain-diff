import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "parse5";
import { prepareExplanation } from "../src/prepare.ts";
import { renderExplanation } from "./render.js";

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function git(cwd, ...args) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(err);
  return out;
}
async function repository(parent) {
  const root = parent ?? mkdtempSync(join(tmpdir(), "explain generation "));
  if (!parent) temporary.push(root);
  mkdirSync(root, { recursive: true });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "tracked.txt"), "original\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}
function content(title = "Explanation") {
  const quiz = [1, 2, 3, 4, 5].map((n) => `<div class="quiz-question" data-question><p class="quiz-q">Question ${n}</p><div class="quiz-options"><button class="quiz-option" data-correct="true">Right</button><button class="quiz-option" data-correct="false">Wrong</button><button class="quiz-option" data-correct="false">Also wrong</button><button class="quiz-option" data-correct="false">Another wrong</button></div><div class="quiz-feedback" hidden>Why right differs from the alternatives.</div></div>`).join("");
  return { title, subtitle: "A captured change", background: "<p>Background.</p>", intuition: "<p>Intuition.</p>", code: "<pre><code>&lt;div&gt;example&lt;/div&gt;</code></pre>", quiz };
}
function elements(node, tag) {
  const found = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current.tagName === tag) found.push(current);
    if (current.childNodes) stack.push(...current.childNodes);
  }
  return found;
}

test("distinct targets with identical readable slugs do not share or replace output", async () => {
  const root = await repository();
  await git(root, "branch", "feature/a");
  await git(root, "branch", "feature-a");
  const outputDir = join(root, "outputs");
  const first = await prepareExplanation(root, "feature/a", { outputDir });
  writeFileSync(first.outputPath, "Completed first explanation");
  const second = await prepareExplanation(root, "feature-a", { outputDir });
  expect(first.outputPath).not.toBe(second.outputPath);
  expect(readFileSync(first.outputPath, "utf8")).toBe("Completed first explanation");
});

test("same-named repositories sharing an output directory have separate output identities", async () => {
  const parent = mkdtempSync(join(tmpdir(), "explain repositories "));
  temporary.push(parent);
  const one = await repository(join(parent, "one", "repo"));
  const two = await repository(join(parent, "two", "repo"));
  const outputDir = join(parent, "outputs");
  const first = await prepareExplanation(one, "uncommitted", { outputDir });
  const second = await prepareExplanation(two, "uncommitted", { outputDir });
  expect(first.outputPath).not.toBe(second.outputPath);
});

test("rendering uses captured statistics after the working tree changes and escapes text", async () => {
  const root = await repository();
  writeFileSync(join(root, "new.txt"), "first line\n");
  const prepared = await prepareExplanation(root, "uncommitted", { outputDir: join(root, "outputs") });
  writeFileSync(join(root, "new.txt"), "now\nhas\nthree lines\n");
  const title = "A <script> & 'quoted' title";
  writeFileSync(prepared.contentPath, JSON.stringify(content(title)));
  const rendered = await renderExplanation(prepared.snapshotPath, prepared.contentPath);
  expect(rendered.failures).toEqual([]);
  const dom = parse(readFileSync(prepared.outputPath, "utf8"));
  const heading = elements(dom, "h1")[0];
  expect(heading.childNodes.map((node) => node.value ?? "").join("")).toBe(title);
  const added = elements(dom, "span").find((node) => node.attrs.some((attr) => attr.name === "class" && attr.value === "stat-add"));
  expect(added.childNodes[0].value).toBe("+1");
});

test("a failed render preserves the previous valid explanation", async () => {
  const root = await repository();
  const prepared = await prepareExplanation(root, "uncommitted", { outputDir: join(root, "outputs") });
  writeFileSync(prepared.contentPath, JSON.stringify(content("Previous valid explanation")));
  expect((await renderExplanation(prepared.snapshotPath, prepared.contentPath)).failures).toEqual([]);
  const previous = readFileSync(prepared.outputPath, "utf8");
  const invalid = content("Must not publish");
  invalid.quiz = invalid.quiz.replaceAll('data-correct="true"', 'data-correct="TRUE"');
  writeFileSync(prepared.contentPath, JSON.stringify(invalid));
  await renderExplanation(prepared.snapshotPath, prepared.contentPath);
  expect(readFileSync(prepared.outputPath, "utf8")).toBe(previous);
});

test("the emitted render command runs with spaces and quotes in paths", async () => {
  const root = await repository();
  const prepared = await prepareExplanation(root, "uncommitted", { outputDir: join(root, "output with 'quote'") });
  writeFileSync(prepared.contentPath, JSON.stringify(content("Quoted paths work")));
  const child = Bun.spawn(["sh", "-c", prepared.renderCommand], { stdout: "pipe", stderr: "pipe" });
  const [, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const dom = parse(readFileSync(prepared.outputPath, "utf8"));
  expect(elements(dom, "h1")[0].childNodes[0].value).toBe("Quoted paths work");
});

test("highlighting preserves escaped code, whitespace, and wrapper attributes", async () => {
  const root = await repository();
  const prepared = await prepareExplanation(root, "uncommitted", { outputDir: join(root, "outputs") });
  const input = content();
  const source = '\nconst markup = "<script>&amp;</script>";\nif (1 < 2) console.log(markup);\n';
  input.background = `<pre id="sample"><code class="language-js" aria-label="Example">${source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code></pre>`;
  const untouched = [
    '<p><code class="language-js">const inline = true;</code></p>',
    '<pre><code>const unlabeled = true;</code></pre>',
    '<pre><code class="language-not-a-language">unknown &lt;code&gt;</code></pre>',
    '<pre class="mermaid"><code class="language-js">graph TD\nA--&gt;B</code></pre>',
  ];
  input.code = untouched.join("");
  writeFileSync(prepared.contentPath, JSON.stringify(input));
  expect((await renderExplanation(prepared.snapshotPath, prepared.contentPath)).failures).toEqual([]);
  const html = readFileSync(prepared.outputPath, "utf8");
  const dom = parse(html);
  const sample = elements(dom, "pre").find((node) => node.attrs.some((attr) => attr.name === "id" && attr.value === "sample"));
  const code = elements(sample, "code")[0];
  const text = (node) => node.nodeName === "#text" ? node.value : (node.childNodes ?? []).map(text).join("");
  expect(text(code)).toBe(source);
  expect(code.attrs).toContainEqual({ name: "aria-label", value: "Example" });
  expect(elements(code, "script")).toEqual([]);
  const styles = elements(code, "span").flatMap((node) => node.attrs.filter((attr) => attr.name === "style").map((attr) => attr.value));
  expect(styles.some((style) => /--shiki-light:#[0-9a-f]+;--shiki-dark:#[0-9a-f]+/i.test(style))).toBe(true);
  for (const original of untouched) expect(html).toContain(original);
});

test("highlighting cannot repair invalid source or replace published output on errors", async () => {
  const root = await repository();
  const prepared = await prepareExplanation(root, "uncommitted", { outputDir: join(root, "outputs") });
  writeFileSync(prepared.contentPath, JSON.stringify(content("Previous")));
  await renderExplanation(prepared.snapshotPath, prepared.contentPath);
  const previous = readFileSync(prepared.outputPath, "utf8");
  const input = content();
  input.code = '<pre><code class="language-html"><div>unescaped</code></pre>';
  writeFileSync(prepared.contentPath, JSON.stringify(input));
  expect((await renderExplanation(prepared.snapshotPath, prepared.contentPath)).failures.some((failure) => failure.includes("tag balance"))).toBe(true);
  expect(readFileSync(prepared.outputPath, "utf8")).toBe(previous);
  input.code = '<pre><code class="language-html"><div>unescaped</div></code></pre>';
  writeFileSync(prepared.contentPath, JSON.stringify(input));
  await expect(renderExplanation(prepared.snapshotPath, prepared.contentPath)).rejects.toThrow("escaped text");
  expect(readFileSync(prepared.outputPath, "utf8")).toBe(previous);
});
