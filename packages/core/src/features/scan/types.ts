import type { CveSeverity } from "../../shared/types.js";

/** A single dependency change detected between git base and working tree */
export interface DeltaDependencyChange {
  packageName: string;
  changeType: "added" | "upgraded" | "downgraded" | "removed";
  oldVersion?: string;
  newVersion?: string;
  dependencyType:
    | "dependencies"
    | "devDependencies"
    | "peerDependencies"
    | "optionalDependencies"
    | "transitive";
  manifestPath: string;
}

/** A vulnerability finding associated with a delta dependency change */
export interface DeltaFinding {
  packageName: string;
  cveId: string;
  severity: CveSeverity;
  summary: string;
  deltaType: "introduced" | "resolved" | "unaffected";
  installedVersion?: string;
  safeUpgradeVersion?: string;
  inCisaKev?: boolean;
  epssScore?: number;
}

/** Options for scanDelta() */
export interface DeltaScanOptions {
  cwd?: string;
  baseRef?: string;
  includeUnstaged?: boolean;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "deno";
}

/** Report returned by scanDelta() */
export interface DeltaScanReport {
  schemaVersion: "1.0";
  status: "ok" | "degraded" | "improved" | "neutral";
  baseRef: string;
  targetRef: string;
  changedManifests: string[];
  dependencyChanges: DeltaDependencyChange[];
  introducedFindings: DeltaFinding[];
  resolvedFindings: DeltaFinding[];
  netRiskVerdict: "improved" | "neutral" | "degraded";
  summary: string;
  generatedAt: string;
}
