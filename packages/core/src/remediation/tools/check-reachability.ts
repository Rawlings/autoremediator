/**
 * Tool: check-reachability
 *
 * Scans project source files (excluding node_modules) for import/require
 * references to a given package name. Returns a ReachabilityAssessment
 * indicating whether the package appears reachable from source code.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "./tool-compat.js";
import { z } from "zod";
import type { ReachabilityAssessment, ReachabilityEvidence } from "../../platform/types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function escapePackageName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(packageName: string): RegExp {
  const escaped = escapePackageName(packageName);
  // Matches: import ... from 'pkg', require('pkg'), require('pkg/subpath'), import('pkg')
  return new RegExp(
    `(?:import\\s[\\s\\S]*?from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*)['"\`]${escaped}(?:[/'"\`/]|$)`,
    "m",
  );
}

function* walkSourceFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (SOURCE_EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) {
      yield full;
    }
  }
}

export function assessPackageReachability(
  cwd: string,
  packageName: string,
): ReachabilityAssessment {
  const pattern = buildPattern(packageName);
  const evidence: ReachabilityEvidence[] = [];
  let scanned = 0;

  for (const filePath of walkSourceFiles(cwd)) {
    scanned++;
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (pattern.test(content)) {
      evidence.push({ filePath, matchType: "import" });
    }
  }

  if (scanned === 0) {
    return {
      packageName,
      status: "unknown",
      reason: `No source files found under ${cwd}`,
      reachabilityBasis: "unknown",
    };
  }

  if (evidence.length > 0) {
    return {
      packageName,
      status: "reachable",
      reason: `Found ${evidence.length} source file(s) referencing '${packageName}'`,
      reachabilityBasis: "import-present",
      evidence,
    };
  }

  return {
    packageName,
    status: "not-reachable",
    reason: `No source files reference '${packageName}'`,
    reachabilityBasis: "import-present",
    evidence: [],
  };
}

export const checkReachabilityTool = defineTool({
  description:
    "Scan project source files for import/require references to a package. Returns reachability status: reachable, not-reachable, or unknown.",
  parameters: z.object({
    cwd: z.string().describe("Project root directory to scan"),
    packageName: z.string().describe("Package name to search for (e.g. 'lodash' or '@babel/core')"),
  }),
  execute({ cwd, packageName }) {
    return assessPackageReachability(cwd, packageName);
  },
});
