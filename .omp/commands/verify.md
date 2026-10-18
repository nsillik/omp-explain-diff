---
name: verify
description: Verify capture, generation preparation, rendering, and HTML validation with isolated Git fixtures and a real omp smoke run.
---

# Verify plugin changes

Run before finishing changes to `src/`, `templates/`, `scripts/`, or the generation skill. Do not stage or mutate the user's real Git index for verification. Scratch repositories/output belong in ignored `tmp/` or an OS temporary directory.

## Automated checks

```sh
bun install --frozen-lockfile
bun build --target=bun src/index.ts --outfile=/dev/null
bun test
bun scripts/validate.js docs/2026-08-14-explanation-pr-1.html
```

The Bun target is required for `node:` imports. The tests create disposable repositories and exercise immutable diff capture, untracked/deleted/binary paths, real-index isolation, output identity, shell-quoted paths, browser-aligned quiz validation, source locations, and validate-before-publish behavior. Do not regenerate fixtures using an untracked scratch script.

## Real generation smoke

1. Create a disposable Git repository with one committed source file, then make a small meaningful uncommitted change. Choose an output directory containing spaces.
2. Run the actual `/explain-diff-html uncommitted` command in `omp`, explicitly loading this checkout if necessary. Record wall-clock duration separately from the command's reported preparation duration.
3. Observe that the command captures metadata/patch once, the model writes one six-field content JSON, and `scripts/render.js` reports `OK` before final HTML is published. The model should not read the template or reacquire Git diff/stat data.
4. Run `bun scripts/validate.js <absolute-html-path>` with a properly quoted path. Open the resulting page in a browser for programmatic checks: four TOC entries, five quiz questions, option selection reveals feedback, and a completed quiz shows the score.
5. If Mermaid code changed, include a Mermaid block and verify real diagram rendering. Also verify core interactions remain available while its CDN request is blocked. No-diagram pages should not request the CDN.
6. Remove only the scratch repository/output you created. Preserve the committed example page as a historical artifact; do not silently regenerate it.

## Acceptance

- Automated commands succeed; negative validator scenarios exit 1.
- Untracked and deleted changes are represented without changing the user's index.
- Different target/repository identities do not overwrite one another.
- Invalid content leaves previous valid output unchanged.
- The real command produces a valid interactive page, with observed preparation and end-to-end durations reported separately. Never claim a generation speedup from validator timings alone or compare runs using different models/change sizes as if controlled.
