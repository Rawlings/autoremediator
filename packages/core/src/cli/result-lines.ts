import type { PatchResult } from "../platform/types.js";

const MAX_LINES = 25;

function describe(result: PatchResult): string {
  const target = result.toVersion ? `${result.fromVersion} → ${result.toVersion}` : result.fromVersion;
  const how = [result.strategy !== "none" ? result.strategy : undefined, result.dependencyScope]
    .filter(Boolean)
    .join(", ");
  const suffix = how ? ` (${how})` : "";

  if (result.suppressedBy) {
    return `- ${result.packageName} ${result.fromVersion}: not changed, suppressed as ${result.suppressedBy.justification}`;
  }
  if (result.applied) {
    return `✔ ${result.packageName} ${target}${suffix}: fixed`;
  }
  if (result.dryRun) {
    return `○ ${result.packageName} ${target}${suffix}: would fix (dry run)`;
  }
  const reason = result.unresolvedReason ?? "unresolved";
  return `✘ ${result.packageName} ${result.fromVersion}: not fixed, ${reason}${
    result.message ? `. ${result.message}` : ""
  }`;
}

/**
 * One line per package for the text output, so a run reads as "what changed and what did not"
 * rather than a set of counters. A package hit by several advisories is listed once.
 */
export function formatResultLines(results: readonly PatchResult[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const result of results) {
    const line = describe(result);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  if (lines.length <= MAX_LINES) return lines;
  const hidden = lines.length - MAX_LINES;
  return [
    ...lines.slice(0, MAX_LINES),
    `… and ${hidden} more (use --output-format json for the full report)`,
  ];
}
