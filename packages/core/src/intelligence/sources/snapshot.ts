import { readFileSync } from "node:fs";
import type { CveDetails } from "../../platform/types.js";

export interface IntelligenceSnapshot {
  [cveId: string]: any;
}

export function loadIntelligenceSnapshot(filePath: string): IntelligenceSnapshot {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Intelligence snapshot at ${filePath} must be a JSON object keyed by CVE ID.`);
  }
  return parsed as IntelligenceSnapshot;
}

export function lookupSnapshotCve(
  snapshot: IntelligenceSnapshot,
  cveId: string,
): CveDetails | null {
  const store =
    (snapshot as Record<string, unknown>).cves &&
    typeof (snapshot as Record<string, unknown>).cves === "object" &&
    !Array.isArray((snapshot as Record<string, unknown>).cves)
      ? ((snapshot as Record<string, unknown>).cves as Record<string, unknown>)
      : (snapshot as Record<string, unknown>);

  const normalizedId = cveId.toUpperCase();
  const rawEntry = (store[normalizedId] ?? store[cveId] ?? store[cveId.toLowerCase()]) as
    | Record<string, any>
    | undefined;

  if (!rawEntry || typeof rawEntry !== "object") return null;

  if (
    typeof rawEntry.id === "string" &&
    Array.isArray(rawEntry.affectedPackages) &&
    typeof rawEntry.summary === "string"
  ) {
    return rawEntry as CveDetails;
  }

  const affectedPackages = Array.isArray(rawEntry.affectedPackages)
    ? rawEntry.affectedPackages
    : rawEntry.packageName
      ? [
          {
            name: rawEntry.packageName,
            ecosystem: "npm",
            vulnerableRange: rawEntry.vulnerableRange ?? "",
            firstPatchedVersion: rawEntry.firstPatchedVersion,
            source: "offline-snapshot",
          },
        ]
      : [];

  const details: CveDetails = {
    id: rawEntry.id ?? rawEntry.cveId ?? normalizedId,
    summary: rawEntry.summary ?? `Offline intelligence details for ${normalizedId}`,
    severity: rawEntry.severity ?? "UNKNOWN",
    references: Array.isArray(rawEntry.references) ? rawEntry.references : [],
    affectedPackages,
    cvssScore: typeof rawEntry.cvssScore === "number" ? rawEntry.cvssScore : undefined,
    epss:
      rawEntry.epss ??
      (typeof rawEntry.epssScore === "number"
        ? { score: rawEntry.epssScore, percentile: rawEntry.epssScore }
        : undefined),
    kev:
      rawEntry.kev ??
      (rawEntry.cisaKev !== undefined ? { knownExploited: Boolean(rawEntry.cisaKev) } : undefined),
  };

  return details;
}
