import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const templatePath = join(pkgDir, "templates", "explanation.html");
const skillPath = join(pkgDir, "skills", "explain-diff-html", "SKILL.md");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("explain-diff-html", {
    description:
      "Create a rich interactive HTML explanation of a code change (diff, branch, PR, or commit range).",
    handler: async (args, ctx) => {
      try {
        const outDir =
          process.env.EXPLAIN_DIFF_OUTPUT_DIR ??
          join(homedir(), ".omp", "explain-diffs");
        mkdirSync(outDir, { recursive: true });

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

        const slug = slugify(args);
        const outPath = join(outDir, `${date}-explanation-${slug}.html`);

        const template = readFileSync(templatePath, "utf8");
        writeFileSync(outPath, template.replace("PLACEHOLDER_DATE", date));

        const skillBody = readFileSync(skillPath, "utf8").replace(
          /^---\r?\n[\s\S]*?\r?\n---\r?\n/,
          "",
        );

        ctx.ui.notify(`explain-diff-html: output → ${outPath}`, "info");

        const target = args.trim() || "uncommitted working-tree changes";
        const prompt = `Explain the following code change in a rich, interactive, self-contained HTML page.

Target: ${target}

The output file already exists — it was created by copying the packaged template, which contains all CSS and JavaScript (styling, responsive layout, auto-generated table of contents, interactive quiz). EDIT THE EXISTING FILE IN PLACE with the edit tool. Do NOT create a new file, do NOT rewrite or restyle the CSS/JS, do not add classes or markup outside the marked content slots.

Output file: ${outPath}

Follow the explain-diff-html workflow below. Replace every PLACEHOLDER_* token listed there with your content.

Before finishing, run the validator and fix every failure it reports:
bun ${pkgDir}/scripts/validate.js ${outPath}

--- explain-diff-html workflow ---
${skillBody}`;

        pi.sendUserMessage(prompt);
      } catch (err) {
        ctx.ui.notify(
          "explain-diff-html: " +
            (err instanceof Error ? err.message : String(err)),
          "error",
        );
      }
    },
  });
}

function slugify(args: string): string {
  const base = args.trim().replace(/^#/, "pr-");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "diff";
}
