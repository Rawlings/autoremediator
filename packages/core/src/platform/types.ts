// ---------------------------------------------------------------------------
// Core domain types for autoremediator
// ---------------------------------------------------------------------------

/** A resolved CVE entry with affected npm package info */
export interface CveDetails {
  id: string; // e.g. "CVE-2021-23337"
  summary: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
  cvssScore?: number;
  epss?: {
    score: number;
    percentile: number;
    date?: string;
  };
  kev?: {
    knownExploited: boolean;
    dateAdded?: string;
    dueDate?: string;
    requiredAction?: string;
    knownRansomwareCampaignUse?: string;
  };
  intelligence?: {
    cveServicesEnriched?: boolean;
    gitlabAdvisoryMatched?: boolean;
    certCcMatched?: boolean;
    depsDevEnrichedPackages?: number;
    scorecardProjects?: number;
    vendorAdvisories?: string[];
    commercialFeeds?: string[];
    sourceHealth?: Record<
      string,
      {
        attempted: boolean;
        changed: boolean;
        error?: string;
      }
    >;
  };
  references: string[];
  affectedPackages: AffectedPackage[];
}

/** A single npm package affected by a CVE */
export interface AffectedPackage {
  name: string;
  ecosystem: "npm";
  /** Semver range string for the vulnerable version window, e.g. ">=0.0.0 <4.17.21" */
  vulnerableRange: string;
  /** The first version that is NOT vulnerable (the safe upgrade target) */
  firstPatchedVersion?: string;
  /** Source that provided this entry */
  source: "osv" | "github-advisory";
}

/** A package found in the consumer's project */
export interface InventoryPackage {
  name: string;
  version: string;
  /** "direct" = listed in package.json; "indirect" = transitive dep */
  type: "direct" | "indirect";
}

/** A package that is both installed and matches a vulnerable range */
export interface VulnerablePackage {
  installed: InventoryPackage;
  affected: AffectedPackage;
  /** The resolved safe upgrade version, if one exists on npm */
  safeUpgradeVersion?: string;
}

/** The outcome of a single patch operation */
export type PatchStrategy = "version-bump" | "override" | "patch-file" | "none";

export type DependencyScope = "direct" | "transitive";

export type UnresolvedReason =
  | "constraint-blocked"
  | "indirect-dependency"
  | "install-failed"
  | "major-bump-required"
  | "no-safe-version"
  | "override-apply-failed"
  | "package-json-not-found"
  | "patch-apply-failed"
  | "patch-confidence-too-low"
  | "patch-generation-failed"
  | "patch-validation-failed"
  | "policy-blocked"
  | "requires-llm-fallback"
  | "source-fetch-failed"
  | "validation-failed";

export type PatchStrategyCounts = Partial<Record<PatchStrategy, number>>;

export type DependencyScopeCounts = Partial<Record<DependencyScope, number>>;

export type UnresolvedReasonCounts = Partial<Record<UnresolvedReason, number>>;

export interface PatchResult {
  packageName: string;
  strategy: PatchStrategy;
  fromVersion: string;
  toVersion?: string;
  patchFilePath?: string;
  applied: boolean;
  dryRun: boolean;
  message: string;
  unresolvedReason?: UnresolvedReason;
  validation?: {
    passed: boolean;
    error?: string;
  };
}

export interface CorrelationContext {
  requestId?: string;
  sessionId?: string;
  parentRunId?: string;
}

export interface RemediationConstraints {
  directDependenciesOnly?: boolean;
  preferVersionBump?: boolean;
}

export interface ProvenanceContext {
  actor?: string;
  source?: "cli" | "sdk" | "mcp" | "openapi" | "unknown";
}

/** Top-level options for the remediate() API and CLI */
export interface RemediateOptions extends CorrelationContext {
  /** Working directory of the consumer's project (defaults to process.cwd()) */
  cwd?: string;
  /** Package manager to use (defaults to auto-detect from lockfile) */
  packageManager?: "npm" | "pnpm" | "yarn";
  /** If true, plan and report changes but do not write anything */
  dryRun?: boolean;
  /** If true, run package-manager tests after patching */
  runTests?: boolean;
  /** Override the LLM provider (falls back to env AUTOREMEDIATOR_LLM_PROVIDER) */
  llmProvider?: "openai" | "anthropic" | "local";
  /** Override the model name */
  model?: string;
  /** Optional path to a policy file (.autoremediator.json) */
  policy?: string;
  /** If false, do not write evidence JSON for this run (default: true). */
  evidence?: boolean;
  /** Directory to write .patch files (default: ./patches) */
  patchesDir?: string;
  /** If true, run a non-mutating remediation preview (forces dryRun behavior for mutation tools). */
  preview?: boolean;
  /** Optional deterministic idempotency key for request replay handling. */
  idempotencyKey?: string;
  /** If true, return cached report for matching idempotency key + CVE when available. */
  resume?: boolean;
  /** Optional caller provenance fields for evidence and reporting. */
  actor?: string;
  source?: "cli" | "sdk" | "mcp" | "openapi" | "unknown";
  /** Optional orchestration constraints for result enforcement. */
  constraints?: RemediationConstraints;
}

/** Final report returned by the remediation pipeline */
export interface RemediationReport {
  cveId: string;
  cveDetails: CveDetails | null;
  vulnerablePackages: VulnerablePackage[];
  results: PatchResult[];
  agentSteps: number;
  summary: string;
  evidenceFile?: string;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
  resumedFromCache?: boolean;
}
