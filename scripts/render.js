#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { escapeHtml } from "../src/html.ts";
import { parse } from "parse5";
import { bundledLanguages, codeToHtml } from "shiki";
import { validate } from "./validate.js";

async function highlightCodeBlocks(html) {
  const replacements = [];
  const pending = [parse(html, { sourceCodeLocationInfo: true })];
  while (pending.length) {
    const node = pending.pop();
    if (node.childNodes) pending.push(...node.childNodes);
    if (node.tagName !== "code" || node.parentNode?.tagName !== "pre") continue;
    const classes = (element) => element.attrs.find((attr) => attr.name === "class")?.value.split(/\s+/) ?? [];
    if (classes(node.parentNode).includes("mermaid") || classes(node).includes("mermaid")) continue;
    const language = classes(node).find((name) => name.startsWith("language-"))?.slice(9);
    if (!language || !Object.hasOwn(bundledLanguages, language)) continue;
    if (node.childNodes.some((child) => child.nodeName !== "#text")) {
      throw new Error(`language-${language} code must contain escaped text, not HTML elements`);
    }
    const source = node.childNodes.map((child) => child.value).join("");
    const highlighted = await codeToHtml(source, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
      transformers: [{
        // Keep the author's pre/code wrappers and attributes; emit only tokens.
        root(root) { root.children = root.children[0].children[0].children; },
      }],
    });
    const { startTag, endTag } = node.sourceCodeLocation;
    const marker = node.attrs.some((attr) => attr.name === "data-shiki") ? "" : " data-shiki";
    replacements.push({
      start: startTag.endOffset - 1,
      end: endTag.startOffset,
      value: `${marker}>${highlighted}`,
    });
  }
  // Source offsets remain valid by applying edits from the end of the document.
  replacements.sort((a, b) => b.start - a.start);
  for (const { start, end, value } of replacements) {
    html = html.slice(0, start) + value + html.slice(end);
  }
  return html;
}

// Only validated output replaces a previous explanation. Content cannot choose
// output paths or change the captured template, target, or diffstat.
export async function renderExplanation(snapshotPath, contentPath) {
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
  let html = readFileSync(metadata.templatePath, "utf8").replace(
    /PLACEHOLDER_(TITLE|SUBTITLE|BACKGROUND|INTUITION|CODE|QUIZ)\b/g,
    (_match, slot) => {
      const field = slot.toLowerCase();
      return field === "title" || field === "subtitle" ? escapeHtml(content[field]) : content[field];
    },
  );
  // Reject malformed source before parsing can repair or highlighting can hide it.
  let result = validate(html);
  if (result.failures.length > 0) return { ...result, outputPath: metadata.outputPath };
  html = await highlightCodeBlocks(html);
  result = validate(html);
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
    const { failures, sectionsFound, questionCount, outputPath } = await renderExplanation(snapshotPath, contentPath);
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
