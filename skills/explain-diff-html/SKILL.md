---
name: explain-diff-html
description: Use when the user asks for a rich explanation of a code change, diff, branch, or PR. Produces HTML output.
---

# explain-diff-html

Based on a gist by @geoffreylitt: https://gist.github.com/geoffreylitt/a29df1b5f9865506e8952488eac3d524

Produce a rich, interactive, self-contained HTML explanation of a code change with four sections: **Background**, **Intuition**, **Code**, **Quiz**. The page is a single HTML file with embedded CSS and JavaScript — no build step, no external assets (except optional Mermaid via CDN for complex diagrams).

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

- **No args** — uncommitted working tree vs HEAD: `git diff HEAD`, `git status --short`, `git diff --stat HEAD`.
- **`#N` or all-digits** — GitHub PR: `gh pr diff N` + `gh pr view N`. If `gh` is unavailable, fall back to `git diff <default-branch>...<N-branch>`.
- **Branch name** — `git diff <default-branch>...<branch>` (three-dot = merge-base semantics). Default branch = `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to `main`, then `master`.
- **`a..b` / `a...b`** — `git diff <range>`.
- **Existing file path** — `git diff HEAD -- <path>`.
- **Anything else** — `git diff <arg>`; on error, report and stop.

Always also explore the surrounding code — changed files, imports/callers, related tests. The Background section requires it, not just the diff text.

## Editing rules

- Edit the pre-created file **in place** with the edit tool. Never create a new file, never rewrite or restyle the CSS/JS, never add classes or markup outside the marked content slots.
- Replace every marker:
  - `PLACEHOLDER_TITLE` — appears **twice**, in `<title>` and the header `<h1>`; replace **both**.
  - `PLACEHOLDER_SUBTITLE`
  - `PLACEHOLDER_TARGET`
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
Exactly **5** questions, medium difficulty — they require real understanding of the change, not gotchas. Each question is interactive multiple choice with feedback. Use the example question markup shipped in the template as the model:

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
- Replace the example question with your five; keep the structure (`data-question`, 4 options, `data-correct` on each, `quiz-feedback`).

## Style

- Clarity and flow in the spirit of Martin Kleppmann; classic style; smooth transitions between sections.
- **Diagrams**: pick a small number of reusable families from the template. Use `.diagram` data-flow with `.d-node`/`.d-arrow`/`.d-data` for flows; `.ui-mock` for UI changes; `.fig`/`.example` with example data. Include example data. Use HTML lists for lists. **NEVER ASCII diagrams.**
- **Mermaid** is allowed for genuinely complex diagrams (sequence/state/flowchart): write the diagram as a `<pre class="mermaid">` block with Mermaid source — the template loads Mermaid from CDN and renders it client-side. Prefer the HTML families for simple flows and UI mocks (they work offline and match the page style); Mermaid requires network when the page is viewed.
- **Callouts**: `.callout` for key concepts/definitions and important edge cases.
- **Code blocks**: always `<pre>` — the template CSS already sets `white-space: pre-wrap` globally (the gist's pre-wrap pitfall is handled); do not use custom styled divs for code.

## Verification (mandatory before finishing)

If a validator command was given in the task prompt, run it and fix every failure it reports. Otherwise self-check:

- No `PLACEHOLDER_` tokens remain.
- 4 sections with ids `background`, `intuition`, `code`, `quiz`.
- Exactly 5 quiz questions, each with exactly one `data-correct="true"` and feedback.
- Tags balanced.

Report the final absolute file path when done.
