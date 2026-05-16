import { readFileSync } from "node:fs";
import type { CveDetails } from "../../platform/types.js";

export interface IntelligenceSnapshot {
  [cveId: string]: CveDetails;
}

export function loadIntelligenceSnapshot(filePath: string): IntelligenceSnapshot {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Intelligence snapshot at ${filePath} must be a JSON object keyed by CVE ID.`);
  }
  return parsed as IntelligenceSnapshot;
}

export function lookupSnapshotCve(snapshot: IntelligenceSnapshot, cveId: string): CveDetails | null {
  return snapshot[cveId.toUpperCase()] ?? snapshot[cveId] ?? null;
}
