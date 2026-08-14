---
name: verify
description: Run the explain-diff-html plugin verification battery — build syntax check, sample fixture round-trip, positive and negative validator runs.
---

# Verify plugin changes

Run this before finishing any change to `src/`, `templates/`, `scripts/`, or `skills/`.
All scratch output goes to `tmp/` (gitignored). Do not commit anything from `tmp/`.

## Steps

1. **Build syntax check** — extension entry must compile under the bun target:

   ```sh
   bun build --target=bun src/index.ts >/dev/null
   ```

   Plain `bun build` defaults to the browser target and fails on `node:` imports;
   `--target=bun` is required. Exit 0 means the syntax is valid.

2. **Regenerate sample fixtures** — build a valid filled page from the committed
   template, replacing every `PLACEHOLDER_*` marker. If `tmp/make-sample.mjs`
   exists (scratch), run it:

   ```sh
   bun tmp/make-sample.mjs
   ```

   Otherwise generate `tmp/sample.html` and `tmp/mermaid.html` by replacing all
   markers from `templates/explanation.html` with valid content (5 quiz
   questions, each exactly one `data-correct="true"`; a `<details class="diffstat">`
   with `+N`/`-N`/`N files` and per-file rows; a `main id="content"` with the four
   sections). Use the marker structure documented in `skills/explain-diff-html/SKILL.md`.

3. **Positive validator runs** — both must exit 0:

   ```sh
   bun scripts/validate.js tmp/sample.html
   bun scripts/validate.js tmp/mermaid.html
   ```

   Expected: `OK <file>: 4/4 sections, 5 quiz questions, diffstat OK, all checks passed`.

4. **Negative validator run** — a page missing the diffstat must fail with the
   exact message. Create `tmp/no-diffstat.html` from `tmp/sample.html` by
   removing the `<details class="diffstat">...</details>` block, then:

   ```sh
   bun scripts/validate.js tmp/no-diffstat.html
   ```

   Expected: exit 1 listing `missing <details class="diffstat"> in header`.

## Acceptance

- Step 1 exits 0.
- Both positive runs exit 0 with `OK ... all checks passed`.
- Negative run exits 1 and lists the missing-diffstat failure.
- Report the exact exit codes and validator output lines as evidence.
