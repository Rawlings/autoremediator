import type { InitChangeSummary } from "../init/types.js";
import type { PackageManager } from "../../platform/types.js";

export type MaintainDecision =
  /** The advisory's package is only a development dependency (or nothing of this project ships it): nothing to say to consumers. */
  | "not-shipped"
  /** The vulnerable code is not in this package's execute path, and the author asserted it. */
  | "not_affected"
  /** This package reaches the vulnerable dependency. */
  | "affected"
  /** Reachability could not rule it out, or it was ruled out but not asserted. */
  | "under_investigation"
  /** The advisory could not be looked up, so nothing was decided. */
  | "unknown";

export interface MaintainOptions {
  /** The package being developed. Default: the current directory. */
  cwd?: string;
  /** Advisory ids (CVE-, GHSA-) to assess. Default: the package manager's audit of this project. */
  advisories?: string[];
  /**
   * The author vouches for what static reachability found. Only with this are advisories whose
   * vulnerable package no source file reaches written as `not_affected`; otherwise `under_investigation`.
   */
  assertNotAffected?: boolean;
  /** A runtime trace (see `trace run`) to add to the static evidence; it can only add reachability. */
  traceFile?: string;
  policy?: string;
  packageManager?: PackageManager;
  offlineIntelligence?: boolean;
  intelligenceSnapshotPath?: string;
  /** The version the next release will have, for the document's product. Default: derived from pending changesets, else the next patch. */
  nextVersion?: string;
  /** Write the changes. Without it, only report them. */
  yes?: boolean;
  source?: "cli" | "sdk" | "mcp" | "openapi";
}

export interface MaintainPackageFinding {
  name: string;
  version: string;
  scope: "production" | "development" | "unreferenced" | "unknown";
  reachability?: "reachable" | "not-reachable" | "unknown";
  reason?: string;
  /** `static`, or `both` when a trace was supplied. */
  evidenceKind?: string;
  runtimeVerdict?: string;
}

export interface MaintainPlanSummary {
  runId?: string;
  planId?: string;
  /** What the plan would change, never applied by `maintain`. */
  items: Array<{ packageName: string; fromVersion: string; toVersion: string }>;
  skipped: number;
}

export interface MaintainAdvisory {
  id: string;
  severity?: string;
  decision: MaintainDecision;
  reason: string;
  packages: MaintainPackageFinding[];
  plan?: MaintainPlanSummary;
}

export interface MaintainResult {
  schemaVersion: "1.0";
  cwd: string;
  package: { name: string; version: string; private: boolean };
  /** The version the VEX statements are written for; absent when it could not be determined. */
  nextVersion?: string;
  usesChangesets: boolean;
  advisories: MaintainAdvisory[];
  changes: InitChangeSummary[];
  /** True when at least one file would change (or did). */
  drift: boolean;
  /** True when files were written. */
  applied: boolean;
  /** Files left alone because they could not be changed safely. */
  conflicts: string[];
  /** Things to know: what was skipped and why. */
  notes: string[];
}
