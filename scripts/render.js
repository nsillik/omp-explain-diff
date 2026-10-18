#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { escapeHtml } from "../src/html.ts";
import { validate } from "./validate.js";

// Only validated output replaces a previous explanation. Content cannot choose
// output paths or change the captured template, target, or diffstat.
export function renderExplanation(snapshotPath, contentPath) {
  const metadata = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      typeof metadata.templatePath !== "string" || typeof metadata.outputPath !== "string") {
    throw new Error("snapshot.json must provide templatePath and outputPath");
  }
  const content = JSON.parse(readFileSync(contentPath, "utf8"));
  const fields = ["title", "subtitle", "background", "intuition", "code", "quiz"];
  if (!content || typeof content !== "object" || Array.isArray(content) ||
      fields.some((field) => typeof content[field] !== "string") ||
      Object.keys(content).some((field) => !fields.includes(field))) {
    throw new Error("content.json must contain exactly six string fields: " + fields.join(", "));
  }
  const html = readFileSync(metadata.templatePath, "utf8").replace(
    /PLACEHOLDER_(TITLE|SUBTITLE|BACKGROUND|INTUITION|CODE|QUIZ)\b/g,
    (_match, slot) => {
      const field = slot.toLowerCase();
      return field === "title" || field === "subtitle" ? escapeHtml(content[field]) : content[field];
    },
  );
  const result = validate(html);
  if (result.failures.length > 0) return { ...result, outputPath: metadata.outputPath };
  const temporary = metadata.outputPath + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, html, { flag: "wx" });
    renameSync(temporary, metadata.outputPath);
  } finally {
    try { unlinkSync(temporary); } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return { ...result, outputPath: metadata.outputPath };
}

if (import.meta.main) {
  const [snapshotPath, contentPath] = process.argv.slice(2);
  if (!snapshotPath || !contentPath) {
    console.error("usage: bun scripts/render.js <snapshot.json> <content.json>");
    process.exit(1);
  }
  try {
    const { failures, sectionsFound, questionCount, outputPath } = renderExplanation(snapshotPath, contentPath);
    if (failures.length > 0) {
      console.error(`FAIL ${outputPath}:`);
      failures.forEach((failure) => console.error(`  - ${failure}`));
      process.exit(1);
    }
    console.log(`OK ${outputPath}: ${sectionsFound}/4 sections, ${questionCount} quiz questions, diffstat OK, all checks passed`);
  } catch (err) {
    console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
