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
      "Create a rich interactive HTML explanation of a code change. With no arguments, asks which change to explain (uncommitted, commit, PR, or commit vs base).",
    handler: async (args, ctx) => {
      try {
        const target = await resolveTarget(args, ctx.ui);
        if (!target) return;

        const outDir =
          process.env.EXPLAIN_DIFF_OUTPUT_DIR ??
          join(homedir(), ".omp", "explain-diffs");
        mkdirSync(outDir, { recursive: true });

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

        const slug = slugify(target.slug);
        const outPath = join(outDir, `${date}-explanation-${slug}.html`);

        const template = readFileSync(templatePath, "utf8");
        writeFileSync(outPath, template.replace("PLACEHOLDER_DATE", date));

        const skillBody = readFileSync(skillPath, "utf8").replace(
          /^---\r?\n[\s\S]*?\r?\n---\r?\n/,
          "",
        );

        ctx.ui.notify(`explain-diff-html: output → ${outPath}`, "info");

        const prompt = `Explain the following code change in a rich, interactive, self-contained HTML page.

Target: ${target.label}

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

type ResolvedTarget = { label: string; slug: string } | null;

type TargetUi = {
  select(label: string, options: string[]): Promise<string | undefined>;
  input(label: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "error"): void;
};

async function resolveTarget(
  args: string,
  ui: TargetUi,
): Promise<ResolvedTarget> {
  const trimmed = args.trim();
  if (trimmed) return { label: trimmed, slug: trimmed };

  const cancel = (): null => {
    ui.notify("explain-diff-html: cancelled — nothing created", "info");
    return null;
  };

  const choice = await ui.select("What do you want explained?", [
    "Uncommitted changes",
    "A specific commit",
    "A specific PR (GitHub PR #)",
    "A specific commit vs a base revision",
    "Other (type your own)",
  ]);
  if (!choice) return cancel();

  switch (choice) {
    case "Uncommitted changes":
      return { label: "uncommitted working-tree changes", slug: "uncommitted" };
    case "A specific commit": {
      const sha = (await ui.input("Commit (SHA or ref):", "e.g. a1b2c3d") ?? "").trim();
      if (!sha) return cancel();
      return { label: `commit ${sha}`, slug: sha.slice(0, 12) };
    }
    case "A specific PR (GitHub PR #)": {
      const n = (await ui.input("GitHub PR number:", "e.g. 123") ?? "").trim();
      if (!n) return cancel();
      return { label: `#${n}`, slug: `pr-${n}` };
    }
    case "A specific commit vs a base revision": {
      const sha = (await ui.input("Commit (SHA or ref):", "e.g. a1b2c3d") ?? "").trim();
      if (!sha) return cancel();
      const base = (await ui.input("Base revision (branch, tag, or SHA):", "e.g. main") ?? "").trim();
      if (!base) return cancel();
      return { label: `${sha} vs ${base}`, slug: `${sha.slice(0, 12)} vs ${base}` };
    }
    case "Other (type your own)": {
      const text = (await ui.input("What would you like explained? (branch, range, path, or other)", "") ?? "").trim();
      if (!text) return cancel();
      return { label: text, slug: text };
    }
    default:
      return cancel();
  }
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
