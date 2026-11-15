import type { SecretsChecklist } from "./ci-secrets.js";
import type { HistoryReport } from "./history.js";

export interface IncidentOptions {
  /** Project directory (default: process.cwd()). */
  cwd?: string;
  /** Record the rollback as a plan in `.autoremediator/runs/` that `applyPlan` can carry out later. Never applied here. */
  plan?: boolean;
  /** Skip every network lookup: no advisory service, no registry. Needs `package@range`, or an id in `intelligenceSnapshotPath`. */
  offline?: boolean;
  /** Offline intelligence snapshot to resolve an advisory id from. */
  intelligenceSnapshotPath?: string;
  /** Policy file used when recording the plan. */
  policy?: string;
  /** Look through git history for when the versions came and went (default true). */
  history?: boolean;
  /** Most lockfile commits to read from history, newest first (default 500). */
  maxCommits?: number;
  /** Write `incident-report.md` and `incident-report.json` into this directory (created if needed). */
  outputDir?: string;
  /** Provenance recorded on the plan. */
  source?: "cli" | "sdk" | "mcp" | "openapi" | "unknown";
}

/** A package, and the versions of it that are bad. */
export interface AffectedRange {
  name: string;
  range: string;
  firstPatchedVersion?: string;
}

export interface IncidentTarget {
  /** What was asked about, as typed. */
  input: string;
  kind: "advisory" | "package-range";
  advisory?: {
    id: string;
    summary: string;
    source: "osv" | "github-advisory" | "offline-snapshot";
    references: string[];
  };
  affected: AffectedRange[];
}

export interface Occurrence {
  version: string;
  /** The lockfile it was found in. */
  lockfile: string;
  direct: boolean;
  scope: "production" | "development" | "unreferenced";
  /** Workspaces that ask for it directly (`.` is the project itself). */
  workspaces: string[];
  /** Workspace, then each package from it down to this one, as `name@version`. Empty if nothing leads to it. */
  via: string[];
  /** Packages that depend on it directly. */
  dependents: string[];
  /** Whether installing it runs scripts: from the lockfile, else the copy in node_modules, else unknown. */
  installScript: boolean | "unknown";
}

export interface PackageExposure {
  packageName: string;
  range: string;
  /** What package.json declares for it, if it is a direct dependency. */
  declared?: string;
  occurrences: Occurrence[];
  /** Copies in `node_modules` in the affected range, from the installed-package inventory (absent when nothing is installed). */
  installed?: Array<{ version: string; type: "direct" | "transitive" }>;
}

export interface Exposure {
  /** An affected version is in a lockfile, or installed, right now. */
  exposed: boolean;
  lockfiles: string[];
  packages: PackageExposure[];
  notes: string[];
}

export interface RollbackProposal {
  packageName: string;
  fromVersion: string;
  /** The version to go back to; absent when none is known. */
  toVersion?: string;
  /** `version-bump` pins a direct dependency; `override` pins a transitive one with the package manager's override field. */
  strategy: "version-bump" | "override";
  dependencyScope: "direct" | "transitive";
  /** Where `toVersion` came from. */
  basis?: "newest-unaffected" | "last-used-before";
  /** The version the lockfile had just before the affected one first arrived (from git history), if known. */
  lastUsedBefore?: string;
  /** A newer version outside the affected range exists. Not planned: moving forward is a separate decision. */
  newerUnaffected?: string;
  /** Why there is no `toVersion`. */
  reason?: string;
}

export interface Rollback {
  proposals: RollbackProposal[];
  /** Set when `plan: true` recorded the proposals as a run. */
  plan?: { runId: string; planId: string };
  notes: string[];
}

export interface IncidentReport {
  schemaVersion: "1.0";
  generatedAt: string;
  cwd: string;
  target: IncidentTarget;
  exposure: Exposure;
  history?: HistoryReport;
  rollback: Rollback;
  /** The rotation checklist; absent when the package was never in the project. */
  secrets?: SecretsChecklist;
  /** Written when `outputDir` was given. */
  files?: { markdown: string; json: string };
  notes: string[];
}
