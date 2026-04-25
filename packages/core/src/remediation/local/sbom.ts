import type { InventoryPackage, PatchResult, SbomEntry, SbomStatus } from "../../platform/types.js";

/**
 * Build a Software Bill of Materials from the installed package inventory,
 * cross-referencing each package against the vulnerable and remediated sets.
 */
export function buildSbom(
  packages: InventoryPackage[],
  vulnerableNames: Set<string>,
  results: PatchResult[]
): SbomEntry[] {
  const statusByPackage = new Map<string, SbomStatus>();
  for (const result of results) {
    if (!vulnerableNames.has(result.packageName)) continue;
    if (result.suppressedBy) {
      statusByPackage.set(result.packageName, "suppressed");
    } else if (!result.applied && result.strategy === "none") {
      statusByPackage.set(result.packageName, "skipped");
    } else if (result.applied) {
      statusByPackage.set(result.packageName, "patched");
    } else {
      statusByPackage.set(result.packageName, "unpatched");
    }
  }

  return packages.map((pkg) => {
    const isVulnerable = vulnerableNames.has(pkg.name);
    const entry: SbomEntry = {
      name: pkg.name,
      version: pkg.version,
      scope: pkg.type === "direct" ? "direct" : "indirect",
    };
    if (isVulnerable) {
      entry.status = statusByPackage.get(pkg.name) ?? "unpatched";
    }
    return entry;
  });
}
