#!/usr/bin/env bun
import { prepareExplanation } from "../src/prepare";

const target = process.argv.slice(2).join(" ").trim();
if (!target) {
  console.error("usage: bun scripts/prepare.ts <target>");
  process.exit(1);
}
try {
  const prepared = await prepareExplanation(process.cwd(), target);
  console.log(prepared.prompt);
} catch (err) {
  console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
