// ---------------------------------------------------------------------------
// Core domain types for autoremediator
// ---------------------------------------------------------------------------

/**
 * CVSS v3 qualitative severity rating.
 * Anchored to the CVSS v3 standard (none/low/medium/high/critical).
 * Values are uppercase; incoming 'moderate' (npm audit, GitHub Advisory) is normalised to 'MEDIUM'.
 */
export type CveSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

/** A resolved CVE entry with affected npm package info */
export interface CveDetails {
  id: string; // e.g. "CVE-2021-23337"
  summary: string;
  severity: CveSeverity;
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

export type PatchRiskLevel = "low" | "medium" | "high";

export type PatchConfidenceThresholds = Partial<Record<PatchRiskLevel, number>>;

export type PatchMode = "patch-package" | "native-pnpm" | "native-yarn";

export type PatchValidationPhaseName =
  | "diff-format"
  | "patch-write"
  | "manifest-write"
  | "apply"
  | "install"
  | "test"
  | "drift";

export interface PatchValidationPhase {
  phase: PatchValidationPhaseName;
  passed: boolean;
  message?: string;
  error?: string;
}

export interface PatchArtifact {
  schemaVersion: "1.0";
  cveId?: string;
  packageName: string;
  vulnerableVersion: string;
  patchFilePath: string;
  manifestFilePath?: string;
  patchFileName: string;
  patchesDir?: string;
  patchMode?: PatchMode;
  confidence?: number;
  riskLevel?: PatchRiskLevel;
  generatedAt: string;
  files?: string[];
  hunkCount?: number;
  applied: boolean;
  dryRun: boolean;
  validationPhases?: PatchValidationPhase[];
}

export interface PatchArtifactSummary {
  patchFilePath: string;
  manifestFilePath?: string;
  patchFileName: string;
  cveId?: string;
  packageName?: string;
  vulnerableVersion?: string;
  patchMode?: PatchMode;
  confidence?: number;
  riskLevel?: PatchRiskLevel;
  generatedAt?: string;
  files?: string[];
  hunkCount?: number;
  diffValid?: boolean;
}

export interface PatchArtifactInspection extends PatchArtifactSummary {
  exists: boolean;
  diffValid: boolean;
  formatError?: string;
  patchSizeBytes?: number;
  lineCount?: number;
  manifest?: PatchArtifact;
}

export interface PatchArtifactValidationReport {
  patchFilePath: string;
  manifestFilePath?: string;
  exists: boolean;
  manifestFound: boolean;
  diffValid: boolean;
  formatError?: string;
  driftDetected: boolean;
  cveId?: string;
  packageName?: string;
  vulnerableVersion?: string;
  installedVersion?: string;
  inventoryMatch?: boolean;
  validationPhases: PatchValidationPhase[];
}

export interface PatchArtifactQueryOptions {
  cwd?: string;
  patchesDir?: string;
  packageManager?: "npm" | "pnpm" | "yarn";
}

export type UnresolvedReason =
  | "consensus-failed"
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

export interface ReachabilityEvidence {
  filePath: string;
  matchType: "import" | "require" | "dynamic-import" | "manifest";
}

export interface ReachabilityAssessment {
  packageName: string;
  status: "reachable" | "not-reachable" | "unknown";
  reason: string;
  evidence?: ReachabilityEvidence[];
}

export interface AlternativePackageSuggestion {
  packageName: string;
  reason: string;
  confidence: number;
  source: "npm-search";
  npmUrl?: string;
  description?: string;
}

export interface FixExplanation {
  title: string;
  summary: string;
  riskSummary?: string;
  reachabilitySummary?: string;
  recommendedAction?: string;
}

export type ChangeRequestProvider = "github" | "gitlab";

export type ChangeRequestGrouping = "all" | "per-cve" | "per-package";

export interface ChangeRequestOptions {
  enabled?: boolean;
  provider: ChangeRequestProvider;
  grouping?: ChangeRequestGrouping;
  repository?: string;
  baseBranch?: string;
  branchPrefix?: string;
  titlePrefix?: string;
  bodyFooter?: string;
  draft?: boolean;
  pushRemote?: string;
  tokenEnvVar?: string;
}

export interface ChangeRequestResult {
  provider: ChangeRequestProvider;
  grouping: ChangeRequestGrouping;
  repository?: string;
  branchName: string;
  title: string;
  body: string;
  created: boolean;
  draft?: boolean;
  url?: string;
  cveIds: string[];
  packageNames: string[];
  error?: string;
}

export interface PortfolioTarget {
  cwd: string;
  label?: string;
  cveId?: string;
  inputPath?: string;
  format?: "auto" | "npm-audit" | "yarn-audit" | "sarif";
  audit?: boolean;
}

export interface PortfolioTargetResult {
  target: PortfolioTarget;
  status: "ok" | "partial" | "failed";
  remediationReport?: RemediationReport;
  scanReport?: ScanReportLike;
  error?: string;
  changeRequests?: ChangeRequestResult[];
}

export interface PortfolioReport {
  schemaVersion: "1.0";
  status: "ok" | "partial" | "failed";
  generatedAt: string;
  targets: PortfolioTargetResult[];
  successCount: number;
  failedCount: number;
  changeRequests?: ChangeRequestResult[];
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
}

export interface ScanReportLike {
  schemaVersion: "1.0";
  status: "ok" | "partial" | "failed";
  generatedAt: string;
  cveIds: string[];
  successCount: number;
  failedCount: number;
}

export interface PatchResult {
  packageName: string;
  strategy: PatchStrategy;
  fromVersion: string;
  toVersion?: string;
  patchFilePath?: string;
  patchArtifact?: PatchArtifact;
  applied: boolean;
  dryRun: boolean;
  message: string;
  dependencyScope?: DependencyScope;
  confidence?: number;
  riskLevel?: PatchRiskLevel;
  unresolvedReason?: UnresolvedReason;
  reachability?: ReachabilityAssessment;
  alternativeSuggestions?: AlternativePackageSuggestion[];
  fixExplanation?: FixExplanation;
  validation?: {
    passed: boolean;
    error?: string;
  };
  validationPhases?: PatchValidationPhase[];
}

export interface CorrelationContext {
  requestId?: string;
  sessionId?: string;
  parentRunId?: string;
}

export interface RemediationConstraints {
  directDependenciesOnly?: boolean;
  preferVersionBump?: boolean;
  installMode?: "standard" | "prefer-offline" | "deterministic";
  installPreferOffline?: boolean;
  enforceFrozenLockfile?: boolean;
  workspace?: string;
}

export type ModelPersonality = "analytical" | "pragmatic" | "balanced";

export type ProviderSafetyProfile = "strict" | "relaxed";

export interface ProgressEvent {
  stage:
    | "pipeline-start"
    | "model-selected"
    | "agent-step"
    | "pipeline-finish"
    | "patch-fallback"
    | "patch-consensus";
  detail: string;
  at: string;
  provider?: "remote" | "local";
  model?: string;
}

export interface LlmUsageMetrics {
  purpose: "orchestration" | "patch-generation" | "patch-consensus";
  provider: "remote" | "local";
  model: string;
  latencyMs?: number;
  promptChars?: number;
  completionChars?: number;
  estimatedCostUsd?: number;
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
  /** Override the LLM provider (vendor-neutral surface): remote or local. */
  llmProvider?: "remote" | "local";
  /** Override the model name */
  model?: string;
  /** Prompt behavior profile for model-guided orchestration and patch generation. */
  modelPersonality?: ModelPersonality;
  /** Safety posture for confidence and high-risk patch behavior. */
  providerSafetyProfile?: ProviderSafetyProfile;
  /** Require a second-provider agreement for high-risk generated patches. */
  requireConsensusForHighRisk?: boolean;
  /** Override provider used for high-risk consensus verification. */
  consensusProvider?: "remote" | "local";
  /** Override model used for high-risk consensus verification. */
  consensusModel?: string;
  /** Optional per-risk confidence thresholds used for patch acceptance. */
  patchConfidenceThresholds?: PatchConfidenceThresholds;
  /** Enable provider-specific dynamic model routing by prompt/input size. */
  dynamicModelRouting?: boolean;
  /** Input-size threshold used by dynamic model routing when enabled. */
  dynamicRoutingThresholdChars?: number;
  /** Optional SDK callback for progress events during remediation execution. */
  onProgress?: (event: ProgressEvent) => void;
  /** Optional path to a policy file (.github/autoremediator.yml) */
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
  /** Optional native pull request / merge request creation controls. */
  changeRequest?: ChangeRequestOptions;
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
  llmUsage?: LlmUsageMetrics[];
  changeRequests?: ChangeRequestResult[];
}

// ---------------------------------------------------------------------------
// Non-security update types (updateOutdated)
// ---------------------------------------------------------------------------

/** A single package found to be outdated during an updateOutdated run */
export interface OutdatedPackage {
  name: string;
  currentVersion: string;
  wantedVersion: string;
  latestVersion: string;
  isMajorBump: boolean;
  dependencyScope: "direct" | "indirect";
}

/** Options for the updateOutdated() operation */
export interface UpdateOutdatedOptions extends RemediateOptions {
  /** Include indirect/transitive dependencies in the outdated check. Default: false. */
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
}
