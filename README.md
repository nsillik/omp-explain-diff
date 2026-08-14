# omp-explain-diff

`/explain-diff-html` turns a code change — uncommitted working tree, branch, PR, commit range, or file — into a rich, interactive, self-contained HTML page with four sections: **Background**, **Intuition**, **Code**, and an interactive **Quiz**. The page is a single file: all CSS and JavaScript are embedded, it works offline, and it can be shared by opening the file in any browser.

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

- `~/.omp/explain-diffs/YYYY-MM-DD-explanation-<slug>.html`
- Override the directory with the `EXPLAIN_DIFF_OUTPUT_DIR` environment variable.
- Re-running for the same target on the same day overwrites the previous file.

## How it works

1. **Template pre-copy, edit in place.** The command copies the packaged `templates/explanation.html` (all CSS + JS: responsive styling, auto-TOC, interactive quiz) to the dated output file, then starts a turn that edits only the marked content slots — no tokens spent building the page.
2. **Deterministic done-signal.** `scripts/validate.js` checks the finished file (no placeholders, balanced tags, 4 sections, exactly 5 quiz questions) before the turn is done.
3. **Command + skill, one workflow.** The command injects `skills/explain-diff-html/SKILL.md` (target resolution, section guidance, diagram families, quiz contract) into the task prompt; the skill can also be used directly.

## Development

```sh
bun scripts/validate.js <file>        # validate a generated page
bun build src/index.ts --outfile=/dev/null  # syntax check the extension
```
