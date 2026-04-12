import type { PatchResult, VulnerablePackage } from "../../platform/types.js";

export function buildLocalSummary(
  vulnerablePackages: VulnerablePackage[],
  collectedResults: PatchResult[]
): string {
  const appliedCount = collectedResults.filter((result) => result.applied).length;
  const unresolvedCount = collectedResults.filter((result) => !result.applied && !result.dryRun).length;
  const dryRunCount = collectedResults.filter((result) => result.dryRun).length;

  return `Local mode completed: vulnerable=${vulnerablePackages.length}, applied=${appliedCount}, dryRun=${dryRunCount}, unresolved=${unresolvedCount}`;
}
