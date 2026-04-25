/**
 * Tool: check-reachability
 *
 * Performs static import analysis on the project's source files to determine
 * whether a given npm package is actually imported (reachable) from application
 * code. Returns "reachable", "not-reachable", or "unknown" depending on
 * evidence found.
 *
 * This is a best-effort heuristic: it scans for import/require patterns in
 * TypeScript and JavaScript files under the project root (excluding node_modules
 * and common build output directories). A "not-reachable" result means no
 * evidence of import was found — not that the package is provably unused.
 */
import { defineTool } from "./tool-compat.js";
import { z } from "zod";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { ReachabilityAssessment, ReachabilityEvidence } from "../../platform/types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", ".git", "coverage", ".cache"]);
const MAX_FILES = 500;

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  if (files.length >= MAX_FILES) return files;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectSourceFiles(full, files);
    } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
      files.push(full);
    }
  }
  return files;
}

export function assessPackageReachability(cwd: string, packageName: string): ReachabilityAssessment {
  const files = collectSourceFiles(cwd);
  if (files.length === 0) {
    return {
      packageName,
      status: "unknown",
      reason: "No source files found to scan.",
    };
  }

  // Match bare package name or scoped package in import/require
  // e.g. "packageName", "@scope/packageName"
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:import\\s[^'"]*from\\s['"]${escaped}(?:/[^'"]*)?['"]|require\\(['"` +
    `]${escaped}(?:/[^'"]*)?['"]\\)|from\\s['"]${escaped}(?:/[^'"]*)?['"])`,
    "m"
  );

  const evidence: ReachabilityEvidence[] = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (pattern.test(content)) {
      const relative = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
      const matchType: ReachabilityEvidence["matchType"] = content.includes(`require('${packageName}`)
        || content.includes(`require("${packageName}`)
        ? "require"
        : content.includes(`import(`) ? "dynamic-import"
        : "import";
      evidence.push({ filePath: relative, matchType });
      if (evidence.length >= 3) break; // limit evidence entries
    }
  }

  if (evidence.length > 0) {
    return {
      packageName,
      status: "reachable",
      reason: `Found ${evidence.length} import reference(s) in source files.`,
      reachabilityBasis: "import-present",
      evidence,
    };
  }

  return {
    packageName,
    status: "not-reachable",
    reason: `No import or require of '${packageName}' found in ${files.length} source file(s).`,
  };
}

export const checkReachabilityTool = defineTool({
  description:
    "Assess whether an npm package is statically reachable (imported) from the project's source files. Returns reachable, not-reachable, or unknown.",
  parameters: z.object({
    cwd: z.string().describe("Project root directory"),
    packageName: z.string().describe("The npm package name to search for"),
  }),
  execute: async ({ cwd, packageName }): Promise<ReachabilityAssessment> => {
    return assessPackageReachability(cwd, packageName);
  },
});
