import type { InventoryPackage, PatchResult, SbomEntry, SbomStatus } from "../../platform/types.js";

/** Identity of one installed copy; a package can be installed at several versions. */
export function sbomKey(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Build a Software Bill of Materials from the installed package inventory,
 * cross-referencing each package against the vulnerable and remediated sets.
 */
export function buildSbom(
  packages: InventoryPackage[],
  vulnerableKeys: Set<string>,
  results: PatchResult[],
): SbomEntry[] {
  const statusByCopy = new Map<string, SbomStatus>();
  for (const result of results) {
    const key = sbomKey(result.packageName, result.fromVersion);
    if (!vulnerableKeys.has(key)) continue;
    if (result.suppressedBy) {
      statusByCopy.set(key, "suppressed");
    } else if (!result.applied && result.strategy === "none") {
      statusByCopy.set(key, "skipped");
    } else if (result.applied) {
      statusByCopy.set(key, "patched");
    } else {
      statusByCopy.set(key, "unpatched");
    }
  }

  return packages.map((pkg) => {
    const key = sbomKey(pkg.name, pkg.version);
    const isVulnerable = vulnerableKeys.has(key);
    const entry: SbomEntry = {
      name: pkg.name,
      version: pkg.version,
      scope: pkg.type === "direct" ? "direct" : "transitive",
    };
    if (isVulnerable) {
      entry.status = statusByCopy.get(key) ?? "unpatched";
    }
    return entry;
  });
}
