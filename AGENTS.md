# AGENTS.md — omp-explain-diff working rules

Rules for working in this repo, learned from past sessions.

## Tooling

- Syntax-checking `src/index.ts`: always `bun build --target=bun src/index.ts`.
  Plain `bun build` defaults to the browser target and fails on `node:` imports
  (e.g. `node:url`). `--target=bun` is a flag-only fix; the extension code is untouched.
- `tmp/` is gitignored scratch — never commit it; safe to create or regenerate fixtures there.

## Browser verification

- The active session model has no vision: `inspect_image` rejects screenshots.
  Verify rendered state programmatically — `checkVisibility()`, `elementFromPoint`,
  computed styles, layout probes — instead of screenshots.
- A tab's frame detaches on navigation. After `tab.goto`, re-observe or re-open
  before `evaluate`/`screenshot`; never reuse the pre-navigation frame handle.

## Showing output

- When the user asks to see the generated HTML output, open it with the `open`
  command (macOS) on the absolute output file path. Don't drive a browser demo
  and don't paste the whole file.
