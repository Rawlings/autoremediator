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
  publishedAt?: string; // ISO 8601 date string from OSV
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
  /** "direct" = listed in package.json; "transitive" = nested dependency */
  type: "direct" | "transitive";
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

export interface ExploitSignalOverridePolicy {
  kev?: { mandatory: boolean };
  epss?: { mandatory: boolean; threshold: number };
}

export type PatchMode = "patch-package" | "native-pnpm" | "native-yarn";

export type VexJustification =
  | "not_affected"
  | "fixed"
  | "mitigated"
  | "under_investigation";

export interface VexSuppression {
  cveId: string;
  justification: VexJustification;
  notes?: string;
  expiresAt?: string; // ISO 8601 date string
}

export interface SlaPolicy {
  critical?: number; // hours
  high?: number;
  medium?: number;
  low?: number;
}

export interface SlaBreach {
  cveId: string;
  severity: CveSeverity;
  publishedAt: string; // ISO 8601
  deadlineAt: string;  // ISO 8601
  hoursOverdue: number;
}

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
  /** SHA-256 integrity hash of the patch file content (format: sha256:<hex>) */
  integrity?: string;
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
  integrity?: string;
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
  | "transitive-dependency"
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

export type EscalationAction =
  | "open-issue"
  | "notify-channel"
  | "create-draft-pr"
  | "hold-branch"
  | "none";

export type EscalationGraph = Partial<Record<UnresolvedReason, EscalationAction>>;

/** Typed result from a second-provider consensus verification run. */
export interface ConsensusVerdict {
  agreed: boolean;
  provider: string;
  model: string;
  reason?: string;
  latencyMs?: number;
  estimatedCostUsd?: number;
}

export type Disposition = "auto-apply" | "simulate-only" | "hold-for-approval" | "escalate";

export interface DispositionPolicy {
  minConfidenceForAutoApply?: number;
  holdForTransitive?: boolean;
  escalateOnSlaBreachSeverities?: CveSeverity[];
  escalateOnKev?: boolean;
}

export interface DispositionSignals {
  exploitSignalTriggered?: boolean;
  slaBreaches?: SlaBreach[];
  dependencyScope?: DependencyScope;
  unresolvedReason?: UnresolvedReason;
  confidence?: number;
  riskLevel?: PatchRiskLevel;
  regressionDetected?: boolean;
  consensusFailed?: boolean;
  applied: boolean;
  severity?: CveSeverity;
}

export type PatchStrategyCounts = Partial<Record<PatchStrategy, number>>;

export type DependencyScopeCounts = Partial<Record<DependencyScope, number>>;

export type UnresolvedReasonCounts = Partial<Record<UnresolvedReason, number>>;

export type DispositionCounts = Partial<Record<Disposition, number>>;

export type EscalationCounts = Partial<Record<EscalationAction, number>>;

export type SimulationMutationTarget =
  | "package-manifest"
  | "lockfile"
  | "patch-file"
  | "patch-manifest"
  | "install-state"
  | "test-command";

export interface SimulationMutation {
  target: SimulationMutationTarget;
  reason: string;
  path?: string;
}

export type SimulationRebuttalCode =
  | "unresolved-reason"
  | "policy-blocked"
  | "consensus-failed"
  | "validation-risk"
  | "regression-risk"
  | "low-confidence"
  | "high-risk-patch"
  | "transitive-target"
  | "escalation-planned"
  | "exploit-signal"
  | "sla-breach"
  | "tests-not-run";

export interface SimulationRebuttalFinding {
  code: SimulationRebuttalCode;
  severity: "info" | "warning" | "high";
  message: string;
  sourceSignals: string[];
}

export interface ResultSimulation {
  mode: "dry-run" | "preview";
  wouldMutate: boolean;
  plannedMutations: SimulationMutation[];
  rebuttalFindings: SimulationRebuttalFinding[];
}

export interface SimulationSummary {
  mode: "dry-run" | "preview";
  resultCount: number;
  wouldMutateCount: number;
  nonMutatingCount: number;
  rebuttalResultCount: number;
  plannedMutationCounts?: Partial<Record<SimulationMutationTarget, number>>;
  rebuttalCounts?: Partial<Record<SimulationRebuttalCode, number>>;
}

export interface ReachabilityEvidence {
  filePath: string;
  matchType: "import" | "require" | "dynamic-import" | "manifest";
}

export interface ReachabilityAssessment {
  packageName: string;
  status: "reachable" | "not-reachable" | "unknown";
  reason: string;
  reachabilityBasis?: "import-present" | "symbol-present" | "call-path-found" | "unknown";
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
  riskHint?: {
    severity?: CveSeverity;
    exploitSignal?: boolean;
    slaBreached?: boolean;
  };
}

export interface PortfolioTargetResult {
  target: PortfolioTarget;
  status: "ok" | "partial" | "failed";
  threatRank?: number;
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
  suppressedBy?: { justification: VexJustification; notes?: string };
  /** True when a post-apply inventory re-check finds the package is still in the vulnerable range. */
  regressionDetected?: boolean;
  validation?: {
    passed: boolean;
    error?: string;
  };
  validationPhases?: PatchValidationPhase[];
  /** Autonomous outcome classification for this patch result. */
  disposition?: Disposition;
  /** Human-readable reason for the assigned disposition. */
  dispositionReason?: string;
  /** Verdict from second-provider consensus gate, if one was executed. */
  consensusVerdict?: ConsensusVerdict;
  /** Intended escalation action for unresolved outcomes. */
  escalationAction?: EscalationAction;
  simulation?: ResultSimulation;
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
  /** If true, add deterministic simulation metadata for dry-run and preview execution contexts. */
  simulationMode?: boolean;
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
  /** Exploit-signal gate: treat KEV/EPSS-flagged CVEs as mandatory regardless of severity filtering. */
  exploitSignalOverride?: ExploitSignalOverridePolicy;
  /** Path to a YAML file containing additional VEX suppression entries to merge with policy-inline suppressions. */
  suppressionsFile?: string;
  /** Compare CVE publication dates against configured SLA windows. */
  slaCheck?: boolean;
  /** Skip remediation for CVEs where the vulnerable package cannot be reached from any project entry point. */
  skipUnreachable?: boolean;
  /** After applying a fix, re-check the inventory to verify the package version is no longer in the vulnerable range. */
  regressionCheck?: boolean;
  /** Override the disposition policy for autonomous outcome classification. */
  dispositionPolicy?: DispositionPolicy;
  /** When true, block results with disposition "escalate" from being applied. */
  containmentMode?: boolean;
  /** When true, portfolio targets are pre-ranked by static risk signals before execution. */
  campaignMode?: boolean;
  /** Optional unresolved-reason-to-action escalation mapping. */
  escalationGraph?: EscalationGraph;
}

export type SbomStatus = "patched" | "unpatched" | "skipped" | "suppressed";

export interface SbomEntry {
  name: string;
  version: string;
  scope: "direct" | "transitive";
  /** CVE IDs that affect this package in the current run, if any */
  cveIds?: string[];
  /** Remediation outcome for this package */
  status?: SbomStatus;
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
  exploitSignalTriggered?: boolean;
  slaBreaches?: SlaBreach[];
  /** Software Bill of Materials — installed packages with CVE and remediation status */
  sbom?: SbomEntry[];
  /** Counts of autonomous disposition outcomes across all results in this report. */
  dispositionCounts?: DispositionCounts;
  /** Counts of intended escalation actions across all results in this report. */
  escalationCounts?: EscalationCounts;
  simulationSummary?: SimulationSummary;
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
