/** The lines of a remediation summary that single-CVE and scan output share. */
import type { PatchResult, ScanReport } from "../../api/index.js";

type ScopeCounts = ScanReport["dependencyScopeCounts"];
type SlaSummary = ScanReport["slaBreachSummary"];

export function transitiveLines(counts: ScopeCounts): string[] {
  const transitive = counts?.transitive ?? 0;
  if (transitive <= 0) return [];
  return [`  Transitive remediations: ${transitive} (fixed without requiring upstream patch)`];
}

/** How many fixes had to be generated as patches, how sure the model was, and which ranges. */
export function patchGeneratedLines(
  patchFileCount: number,
  results: readonly PatchResult[],
): string[] {
  if (patchFileCount <= 0) return [];
  const patches = results.filter((result) => result.strategy === "patch-file");
  const confidences = patches
    .map((result) => result.confidence)
    .filter((confidence): confidence is number => confidence != null);
  const lines = [`Patch-generated (no upstream fix): ${patchFileCount}`];
  if (confidences.length > 0) {
    const average = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
    lines.push(`  Avg patch confidence: ${average.toFixed(2)}`);
  }
  for (const range of new Set(patches.map((result) => result.vulnerableRange).filter(Boolean))) {
    lines.push(`  Vulnerable range: ${range}`);
  }
  return lines;
}

export function slaBreachLines(summary: SlaSummary): string[] {
  if (summary == null || summary.breachCount <= 0) return [];
  return [
    `SLA breaches: ${summary.breachCount} CVE(s) overdue`,
    ...summary.breaches.map(
      (breach) =>
        `  ${breach.cveId}: ${breach.severity}, ${breach.hoursOverdue}h overdue → ${breach.recommendedAction}`,
    ),
  ];
}
