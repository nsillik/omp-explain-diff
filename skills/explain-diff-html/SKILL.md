---
name: explain-diff-html
description: Use when the user asks for a rich explanation of a code change, diff, branch, or PR. Produces HTML output.
---

# explain-diff-html

Based on a gist by @geoffreylitt: https://gist.github.com/geoffreylitt/a29df1b5f9865506e8952488eac3d524

Produce a rich, interactive, self-contained HTML explanation of a code change with four sections: **Background**, **Intuition**, **Code**, **Quiz**. The page is a single HTML file with embedded CSS and JavaScript — no build step, no external assets (the one exception: Mermaid loads from a pinned CDN URL with SRI, and only when the page contains a diagram).

## Invocation

The primary path is the `/explain-diff-html` command, which pre-creates the dated output file by copying the packaged template, then hands off to this workflow. Edit that pre-created file in place.

If invoked as a skill directly with **no pre-created output file**:

1. Locate the extension install dir. Candidate paths for the template:
   - `~/.omp/plugins/node_modules/omp-explain-diff/templates/explanation.html`
   - the path passed to `--extension` / the `extensions:` config entry
2. Copy `explanation.html` to `~/.omp/explain-diffs/YYYY-MM-DD-explanation-<slug>.html` (respect `EXPLAIN_DIFF_OUTPUT_DIR` if set), where `<slug>` follows the same rules as the command (lowercase, non-`[a-z0-9]` runs become `-`, `#` prefix becomes `pr-`, max 60 chars, fallback `diff`).
3. Proceed with the workflow below.
4. If the template cannot be found, tell the user to run `/explain-diff-html` and stop.

## Target resolution

The command's task prompt always includes a `Target: <value>` line; match the rules below against that value (they also cover direct skill invocation with an explicit arg). When the skill is invoked directly with **no** target, first ask the user which change to explain — offering the same menu the command offers: Uncommitted changes, A specific commit, A specific PR (GitHub PR #), A specific commit vs a base revision, or Other (free text) — via the `ask` tool, gathering the specific input for the chosen kind, then apply the matching rule; if the user declines, stop.

Match the `Target: <value>` line against these rules **in order** — each rule fires only when its discriminator matches, and ambiguous input is verified before any guess:

1. **Exact label `uncommitted working-tree changes`** (the command's menu label) — uncommitted working tree vs HEAD: `git diff HEAD`, `git status --short`, `git diff --stat HEAD`.
2. **Range `a..b` / `a...b`** — the value contains `..` or `...` (regex `\.\.\.?`, no whitespace) — `git diff <range>`. Check this first; it would otherwise be swallowed by the branch or file rules below.
3. **`#N` or all-digits** — the value matches `#\d+`, or is entirely digits — GitHub PR: `gh pr diff N` + `gh pr view N`. If `gh` is unavailable, fall back to `git diff <default-branch>...<N-branch>`.
4. **`<commit> vs <base>`** — the value matches the explicit form `<ref> vs <ref>` — the commit's changes relative to a base revision with merge-base (PR) semantics, no GitHub: `git diff <base>...<commit>`.
5. **`commit <sha>`** — the value matches the explicit prefix `commit ` followed by a SHA or ref — the changes introduced by one commit: `git diff <sha>^ <sha>`. If `git rev-parse --verify --quiet <sha>^` exits non-zero (root commit, no parent), diff against the empty tree: `git diff $(git hash-object -t tree /dev/null) <sha>`.
6. **Anything else that looks like a ref or SHA** — verify before choosing branch-vs-commit semantics: run `git rev-parse --verify --quiet <value>^{commit}`. If it does not resolve, skip this rule. If it resolves and `git rev-parse --verify --quiet refs/heads/<value>` also succeeds, it's a **branch**: `git diff <default-branch>...<branch>` (three-dot = merge-base semantics). If it resolves as a commit only, treat it as a **bare SHA**: `git diff <sha>^..<sha>` (same root-commit fallback as rule 5). Default branch = `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to `main`, then `master`.
7. **Existing file path** — `test -e <value>` exits 0 — `git diff HEAD -- <path>`.
8. **Nothing above matches** — do not guess; ask the user to disambiguate (branch, commit, range, or file path) and stop until they answer.

Always also explore the surrounding code — changed files, imports/callers, related tests. The Background section requires it, not just the diff text.

## Diffstat

Every page header shows a diffstat — total lines added, lines removed, files changed — and tapping it expands a per-file breakdown. Compute it from the SAME diff used for the target; never invent numbers.

Totals: run the shortstat command matching the resolved target:

- Uncommitted working tree: `git diff --shortstat HEAD`
- `#N` PR: `gh pr view N --json additions,deletions,changedFiles` (fallback: `git diff --shortstat <default-branch>...<N-branch>`)
- Branch: `git diff --shortstat <default-branch>...<branch>`
- `a..b` / `a...b`: `git diff --shortstat <range>`
- `commit <sha>`: `git diff --shortstat <sha>^ <sha>` (with the identical root-commit fallback — diff against the empty tree when `<sha>` has no parent)
- `<commit> vs <base>`: `git diff --shortstat <base>...<commit>`
- File path: `git diff --shortstat HEAD -- <path>`
- Anything else: `git diff --shortstat <arg>`; on error, report and stop.

`git diff --shortstat` prints `N files changed, X insertions(+), Y deletions(-)`, omitting a part when it is zero; if it prints nothing (no changes), all three numbers are 0.

Per-file rows: run the numstat command for the same target (`--numstat` in place of `--shortstat`; for a `#N` PR use `gh pr view N --json files`, reading `path`/`additions`/`deletions`). Each numstat line is `added<TAB>deleted<TAB>path`; a `-` column means the file is binary — write the file's size in bytes in the `.file-add` span (human-readable with a unit, e.g. `2.3 KB`) and the word `binary` in the `.file-del` span. Get the size with `wc -c <path>` for a local/working-tree target, or `git cat-file -s <rev>:<path>` for a branch/PR/range/commit target. An empty numstat output means no rows.

Replace `PLACEHOLDER_DIFFSTAT` with exactly this structure (X, Y, N are the totals; one `<li>` per file; ASCII `-`, no thousands separators, `file` when N is 1, `files` otherwise; rows listed in numstat order):

```html
<details class="diffstat">
  <summary>
    <span class="stat-add">+X</span>
    <span class="stat-del">-Y</span>
    <span class="stat-files">N files</span>
    <span class="diffstat-toggle"></span>
  </summary>
  <ul class="diffstat-files">
    <li><code class="file-name">path/one.ex</code><span class="file-add">+40</span><span class="file-del">-5</span></li>
    <li><code class="file-name">path/two.ex</code><span class="file-add">+12</span><span class="file-del">-2</span></li>
    <li><code class="file-name">assets/logo.png</code><span class="file-add">2.3 KB</span><span class="file-del">binary</span></li>
  </ul>
</details>
```

When there are no changes, keep the structure with `+0`, `-0`, `0 files`, and an empty `<ul class="diffstat-files"></ul>`.

## Editing rules

- Edit the pre-created file **in place** with the edit tool. Never create a new file, never rewrite or restyle the CSS/JS, never add classes or markup outside the marked content slots.
- Replace every marker:
  - `PLACEHOLDER_TITLE` — appears **twice**, in `<title>` and the header `<h1>`; replace **both**.
  - `PLACEHOLDER_SUBTITLE`
  - `PLACEHOLDER_TARGET`
  - `PLACEHOLDER_DIFFSTAT`
  - `PLACEHOLDER_BACKGROUND`
  - `PLACEHOLDER_INTUITION`
  - `PLACEHOLDER_CODE`
  - `PLACEHOLDER_QUIZ`
  - `PLACEHOLDER_DATE` — if not already replaced by the command.
- Use only the template's existing classes: `.callout` (`.key`, `.warn`, `.callout-label`), `.diagram`/`.d-flow`/`.d-node`/`.d-arrow`/`.d-data`/`.d-cap`, `.ui-mock`/`.ui-bar`/`.ui-body`/`.ui-row`/`.ui-label`/`.ui-val`, `.fig`/`.fig-body`/`.fig-cap`, `.example`/`.example-label`, `.quiz`/`.quiz-question`/`.quiz-q`/`.quiz-options`/`.quiz-option`/`.quiz-letter`/`.quiz-feedback`.

## Sections

### Background
Deep beginner background — enough that someone new to the area can follow (a short "if you're new here" note the reader can skip), then the narrow background directly relevant to this change. Draw on the surrounding code you explored, not just the diff text.

### Intuition
The essence of the change: what problem it solves and the mental model that makes it obvious. Use concrete toy-data examples and diagrams liberally.

### Code
A high-level walkthrough of the change, grouped and ordered so it reads understandably — not a line-by-line dump. Reference real symbols from the diff.

### Quiz
Exactly **5** questions, medium difficulty — they require real understanding of the change, not gotchas. Each question is interactive multiple choice with feedback. Use the example question markup below as the model:

```html
<div class="quiz-question" data-question>
  <p class="quiz-q">1. Question text</p>
  <div class="quiz-options">
    <button class="quiz-option" data-correct="false">Option text</button>
    <button class="quiz-option" data-correct="true">Option text</button>
    <button class="quiz-option" data-correct="false">Option text</button>
    <button class="quiz-option" data-correct="false">Option text</button>
  </div>
  <div class="quiz-feedback" hidden>Feedback text.</div>
</div>
```

- Exactly **one** `data-correct="true"` per question.
- Feedback explains why the correct answer is right and why each wrong option fails.
- Replace the example question below with your five; keep the structure (`data-question`, 4 options, `data-correct` on each, `quiz-feedback`).

## Style

- Clarity and flow in the spirit of Martin Kleppmann; classic style; smooth transitions between sections.
- **Diagrams**: pick a small number of reusable families from the template. Use `.diagram` data-flow with `.d-node`/`.d-arrow`/`.d-data` for flows; `.ui-mock` for UI changes; `.fig`/`.example` with example data. Include example data. Use HTML lists for lists. **NEVER ASCII diagrams.**
- **Mermaid** is allowed for genuinely complex diagrams (sequence/state/flowchart): write the diagram as a `<pre class="mermaid">` block with Mermaid source — the template loads Mermaid from a pinned CDN URL (with SRI) only when a diagram is present, and renders it client-side. Prefer the HTML families for simple flows and UI mocks (they work offline and match the page style); Mermaid requires network when the page is viewed.
- **Callouts**: `.callout` for key concepts/definitions and important edge cases.
- **Code blocks**: always `<pre>` — the template CSS already sets `white-space: pre-wrap` globally (the gist's pre-wrap pitfall is handled); do not use custom styled divs for code.

## Verification (mandatory before finishing)

If a validator command was given in the task prompt, run it and fix every failure it reports. Otherwise self-check:

- No `PLACEHOLDER_` tokens remain.
- 4 sections with ids `background`, `intuition`, `code`, `quiz`.
- Exactly 5 quiz questions, each with exactly one `data-correct="true"` and feedback.
- Tags balanced.
- A `<details class="diffstat">` in the header: summary with `+N` / `-N` / `N files`, and a `.diffstat-files` list with one row per file.

Report the final absolute file path when done.
