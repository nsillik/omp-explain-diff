# omp-explain-diff

`/explain-diff-html` turns a code change — uncommitted working tree, branch, PR, commit range, or file — into a rich, interactive, self-contained HTML page with four sections: **Background**, **Intuition**, **Code**, and an interactive **Quiz**. CSS and core JavaScript are embedded and work offline; optional Mermaid diagrams load a pinned CDN dependency.

Based on a gist by [@geoffreylitt](https://gist.github.com/geoffreylitt/a29df1b5f9865506e8952488eac3d524).

License: MIT (see [LICENSE](LICENSE)).

## Install

Pick one:

- `omp plugin link <repo-path>` — user scope; enables the `/explain-diff-html` command and skill discovery via `omp-plugins`.
- Marketplace: `/marketplace add <repo-path>`, then `/marketplace install omp-explain-diff@omp-explain-diff`.
- `extensions:` config entry pointing at the repo, or `omp --extension <repo>`.

Dropping the repo into `~/.omp/agent/extensions/` loads the command but **not** the sibling skill — prefer link/config/marketplace.

## Usage

| Command | Explains |
|---|---|
| `/explain-diff-html` | asks which change to explain: uncommitted, commit, PR, or commit vs base |
| `/explain-diff-html <branch>` | branch vs default branch |
| `/explain-diff-html #123` | GitHub PR #123 |
| `/explain-diff-html a..b` | commit range |
| `/explain-diff-html <path>` | changes to a file |

## Output

- `~/.omp/explain-diffs/YYYY-MM-DD-explanation-<repo>-<target>-<identity>.html`
- Override the directory with the `EXPLAIN_DIFF_OUTPUT_DIR` environment variable; relative paths resolve from the invoking directory.
- The identity includes the canonical repository path and complete target, so different repositories and targets with the same readable slug cannot overwrite each other.
- A successful same-target render on the same day replaces its previous page. Failed capture, generation, or validation leaves the previous page intact.
- Captured patch, metadata, template, and generated content JSON are retained under `.snapshots/` in the output directory. These artifacts are not required to view or share the HTML. Their generated ignore file excludes them from subsequent Git captures.

## Example

A real generated page — the explanation of the PR that added interactive target selection:

[2026-08-14-explanation-pr-1.html](https://htmlpreview.github.io/?https://github.com/nsillik/omp-explain-diff/blob/main/docs/2026-08-14-explanation-pr-1.html)

GitHub serves raw files as `text/plain`, so a direct link would show source; the `htmlpreview.github.io` wrapper fetches the raw file and renders the full page — styles, auto-TOC, and interactive quiz included — in the browser. The file itself lives in [`docs/`](docs/2026-08-14-explanation-pr-1.html) and can be opened directly from a local checkout.

## How it works

1. **Capture once.** Resolve the target to immutable Git objects, including nonignored untracked files and tracked deletions for working-tree targets. A temporary index leaves the real index unchanged. Statistics and binary sizes come from those same captured objects, not separate live working-tree or PR queries. GitHub PRs use resolved base/head revisions; without `gh`, a matching published PR merge ref must establish the base. If that metadata is unavailable, preparation fails explicitly rather than guessing a default-branch diff.
2. **Prepare deterministic content.** Compute output identity and diffstat in code, then fill date, target, and diffstat in a captured template. The model never needs to read or reproduce the page's CSS/JavaScript.
3. **Generate once.** A concise workflow asks the model to read the captured patch, inspect only relevant surrounding code, and write one JSON object: `title`, `subtitle`, `background`, `intuition`, `code`, and `quiz`. No repeated target acquisition or diffstat computation.
4. **Validate before publishing.** `scripts/render.js` escapes plain-text title/subtitle, fills HTML content slots, validates the original document and browser quiz contract, then atomically publishes the result. Failed validation reports source locations without replacing an existing explanation.

### Generation time

The command reports deterministic preparation time before starting the model turn. That is **not** end-to-end generation time: model/provider latency, change size, required context research, and output length still matter. The generation workflow avoids broad repository audits, template reads, and multiple drafts; it retains all changed files in the captured patch.

Observed smoke measurements on 2026-10-18 (Apple Silicon, Bun 1.4.2; one JavaScript file, +6/-1):

| Phase | Observed duration |
|---|---:|
| Deterministic preparation, median of 7 runs | 65 ms |
| Actual interactive `omp` command through HTML publication, one fresh-session run | approximately 67 seconds |

The interactive run used GPT-6.1 Sol with low thinking effort and passed rendering on the first attempt. These are small-change measurements, not a controlled before/after comparison or a latency guarantee for large changes.

Direct skill invocation runs `scripts/prepare.ts` and uses the same capture/render pipeline rather than a second set of Git instructions.

## Development

```sh
bun install --frozen-lockfile
bun test                            # disposable Git fixtures + validator/render regressions
bun scripts/validate.js <file>       # validate a generated page
bun build --target=bun src/index.ts --outfile=/dev/null
```
