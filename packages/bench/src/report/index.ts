/**
 * The generated results pages. `renderReport` maps each page's path (relative to the benchmark
 * package) to its text, from the committed results files and the task definitions only. The guard
 * test compares every committed page to this output, and `writeReport` is how they are written.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { renderModePage } from "./mode-page.ts";
import { renderOverview } from "./overview.ts";
import { renderReadmeBlock, withReadmeBlock } from "./readme-block.ts";
import { renderTasksPage } from "./tasks-page.ts";
import type { ReportInput } from "./types.ts";

export { loadResultFiles } from "./load.ts";
export type { LoadedResult } from "./load.ts";
export { renderReadmeBlock, withReadmeBlock } from "./readme-block.ts";
export type { ReportInput } from "./types.ts";

export function renderReport(input: ReportInput): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set("RESULTS.md", renderOverview(input));
  pages.set("results/tasks.md", renderTasksPage(input.tasks));
  for (const entry of input.results) {
    pages.set(`results/${entry.result.mode}.md`, renderModePage(entry));
  }
  return pages;
}

/** Write every page and the README block; remove generated pages that no longer have data. */
export function writeReport(benchDir: string, readmePath: string, input: ReportInput): string[] {
  const pages = renderReport(input);
  const written: string[] = [];
  for (const [path, text] of pages) {
    const target = join(benchDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written.push(path);
  }
  const resultsDir = join(benchDir, "results");
  for (const name of existsSync(resultsDir) ? readdirSync(resultsDir) : []) {
    if (name.endsWith(".md") && !pages.has(`results/${name}`)) rmSync(join(resultsDir, name));
  }
  const readme = readFileSync(readmePath, "utf8");
  writeFileSync(readmePath, withReadmeBlock(readme, renderReadmeBlock(input)));
  return written;
}
