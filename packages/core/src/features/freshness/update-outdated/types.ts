import type { RemediationConstraints } from "../../../infra/policy/types.js";
import type { ChangeRequestResult } from "../../change-request/types.js";
import type {
  CorrelationContext,
  ProvenanceContext,
  RemediateOptions,
} from "../../remediate/types.js";

/** A single package found to be outdated during an updateOutdated run */
export interface OutdatedPackage {
  name: string;
  currentVersion: string;
  wantedVersion: string;
  latestVersion: string;
  isMajorBump: boolean;
  dependencyScope: "direct" | "transitive";
}

/** Options for the updateOutdated() operation */
export interface UpdateOutdatedOptions extends Omit<RemediateOptions, "simulationMode"> {
  /** Include transitive dependencies in the outdated check. Default: false. */
  includeTransitive?: boolean;
}

/** Report returned by updateOutdated() */
export interface UpdateOutdatedReport {
  schemaVersion: "1.0";
  status: "ok" | "partial" | "failed";
  generatedAt: string;
  outdatedPackages: OutdatedPackage[];
  successCount: number;
  failedCount: number;
  skippedCount: number;
  errors: Array<{ packageName: string; message: string }>;
  evidenceFile?: string;
  patchCount: number;
  constraints?: RemediationConstraints;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  changeRequests?: ChangeRequestResult[];
}
