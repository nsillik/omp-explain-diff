import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { prepareExplanation } from "./prepare";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("explain-diff-html", {
    description:
      "Create a rich interactive HTML explanation of a code change. With no arguments, asks which change to explain (uncommitted, commit, PR, or commit vs base).",
    handler: async (args, ctx) => {
      try {
        const target = await resolveTarget(args, ctx.ui);
        if (!target) return;

        const prepared = await prepareExplanation(ctx.cwd, target);
        ctx.ui.notify(
          `explain-diff-html: captured change in ${prepared.preparationMs} ms → ${prepared.outputPath}`,
          "info",
        );
        pi.sendUserMessage(prepared.prompt);
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

type TargetUi = {
  select(label: string, options: string[]): Promise<string | undefined>;
  input(label: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "error"): void;
};

async function resolveTarget(
  args: string,
  ui: TargetUi,
): Promise<string | null> {
  const trimmed = args.trim();
  if (trimmed) return trimmed;

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
      return "uncommitted working-tree changes";
    case "A specific commit": {
      const sha = (await ui.input("Commit (SHA or ref):", "e.g. a1b2c3d") ?? "").trim();
      if (!sha) return cancel();
      return `commit ${sha}`;
    }
    case "A specific PR (GitHub PR #)": {
      const input = (await ui.input("GitHub PR number:", "e.g. 123 or #123") ?? "").trim();
      if (!input) return cancel();
      const n = input.replace(/^#/, "");
      if (!/^\d+$/.test(n)) {
        ui.notify("explain-diff-html: PR number must be digits, optionally prefixed with #", "error");
        return null;
      }
      return `#${n}`;
    }
    case "A specific commit vs a base revision": {
      const sha = (await ui.input("Commit (SHA or ref):", "e.g. a1b2c3d") ?? "").trim();
      if (!sha) return cancel();
      const base = (await ui.input("Base revision (branch, tag, or SHA):", "e.g. main") ?? "").trim();
      if (!base) return cancel();
      return `${sha} vs ${base}`;
    }
    case "Other (type your own)": {
      const text = (await ui.input("What would you like explained? (branch, range, path, or other)", "") ?? "").trim();
      if (!text) return cancel();
      return text;
    }
    default:
      return cancel();
  }
}

