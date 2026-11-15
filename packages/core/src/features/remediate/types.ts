import type {
  DispositionPolicy,
  EscalationAction,
  EscalationGraph,
  ExploitSignalOverridePolicy,
  PatchConfidenceThresholds,
  PatchRiskLevel,
  RemediationConstraints,
  SupplyChainPolicy,
  VexJustification,
} from "../../infra/policy/types.js";
import type {
  CveSeverity,
  DependencyScope,
  PackageManager,
  PatchStrategy,
  UnresolvedReason,
} from "../../shared/types.js";
import type { AutonomySummary } from "../autonomy/types.js";
import type { ChangeRequestOptions, ChangeRequestResult } from "../change-request/types.js";
import type {
  AlternativePackageSuggestion,
  CveDetails,
  VulnerablePackage,
} from "../intelligence/types.js";
import type { MaintainerVexEvidence, MaintainerVexIgnored } from "../maintainer-vex/types.js";
import type { PatchGenerator } from "../patch/patch-generator.js";
import type { PatchArtifact } from "../patch/types.js";
import type { ReachabilityAssessment } from "../reachability/types.js";
import type { PatchValidationPhase, ProofOfFixVerification } from "../verify/types.js";

export interface SlaBreach {
  cveId: string;
  severity: CveSeverity;
  publishedAt: string; // ISO 8601
  deadlineAt: string; // ISO 8601
  hoursOverdue: number;
}

export interface SlaBreachEntry {
  cveId: string;
  severity: CveSeverity;
  hoursOverdue: number;
  deadlineAt: string;
  recommendedAction: EscalationAction;
}

export interface SlaBreachSummary {
  breachCount: number;
  breaches: SlaBreachEntry[];
}

export type Disposition = "auto-apply" | "simulate-only" | "hold-for-approval" | "escalate";

export interface DispositionSignals {
  exploitSignalTriggered?: boolean;
  slaBreaches?: SlaBreach[];
  dependencyScope?: DependencyScope;
  unresolvedReason?: UnresolvedReason;
  confidence?: number;
  riskLevel?: PatchRiskLevel;
  applied: boolean;
  severity?: CveSeverity;
}

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
  unifiedDiff?: string;
}

export type SimulationRebuttalCode =
  | "unresolved-reason"
  | "policy-blocked"
  | "validation-risk"
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
  unifiedDiff?: string;
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

export interface FixExplanation {
  title: string;
  summary: string;
  riskSummary?: string;
  reachabilitySummary?: string;
  recommendedAction?: string;
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
  /** CVE-affected semver range; populated when no upstream release exists and the fix was LLM-generated, or when version resolution was performed. */
  vulnerableRange?: string;
  riskLevel?: PatchRiskLevel;
  unresolvedReason?: UnresolvedReason;
  reachability?: ReachabilityAssessment;
  alternativeSuggestions?: AlternativePackageSuggestion[];
  fixExplanation?: FixExplanation;
  suppressedBy?: {
    justification: VexJustification;
    notes?: string;
    /** Who the suppression comes from: the project's policy (default) or a maintainer's shipped VEX, trusted by `trustMaintainerVex`. */
    source?: "policy" | "maintainer-vex";
  };
  /** `not_affected` verdicts that installed packages ship for this advisory (OpenVEX in the tarball). Evidence only unless the policy sets `trustMaintainerVex`. */
  maintainerVex?: MaintainerVexEvidence[];
  /** Maintainer VEX statements that were read but not accepted for this result, with the reason. */
  maintainerVexIgnored?: MaintainerVexIgnored[];
  validation?: {
    passed: boolean;
    error?: string;
  };
  validationPhases?: PatchValidationPhase[];
  /** Autonomous outcome classification for this patch result. */
  disposition?: Disposition;
  /** Human-readable reason for the assigned disposition. */
  dispositionReason?: string;
  /** Intended escalation action for unresolved outcomes. */
  escalationAction?: EscalationAction;
  simulation?: ResultSimulation;
  proofOfFix?: ProofOfFixVerification;
  refactoredFiles?: string[];
}

export interface CorrelationContext {
  requestId?: string;
  sessionId?: string;
  parentRunId?: string;
}

export interface LlmUsageMetrics {
  purpose: "patch-generation" | "upgrade-repair";
  model: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
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
  packageManager?: PackageManager;
  /** If true, plan and report changes but do not write anything */
  dryRun?: boolean;
  /** If true, run package-manager tests after patching */
  runTests?: boolean;
  /** If true, run typecheck verification (e.g. tsc --noEmit or npm run typecheck) after patching */
  typecheck?: boolean;
  /** Optional supply chain trust policy for release age, scripts, and provenance */
  supplyChainPolicy?: SupplyChainPolicy;

  /**
   * Language model used for the patch fallback, as `<provider>:<model-id>`
   * (e.g. `anthropic:claude-sonnet-5-5`). Defaults to `AUTOREMEDIATOR_MODEL`.
   * Requires the matching `@ai-sdk/<provider>` package; without a model or `patchGenerator`
   * the patch fallback is reported as unavailable.
   */
  model?: string;
  /** SDK-only: supply the patch generator directly instead of configuring a model. */
  patchGenerator?: PatchGenerator;
  /** Per-risk minimum confidence required to accept a generated patch. */
  patchConfidenceThresholds?: PatchConfidenceThresholds;
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
  /** Override the disposition policy for autonomous outcome classification. */
  dispositionPolicy?: DispositionPolicy;
  /** When true, block results with disposition "escalate" from being applied. */
  containmentMode?: boolean;
  /** When true, portfolio targets are pre-ranked by static risk signals before execution. */
  campaignMode?: boolean;
  /** Optional unresolved-reason-to-action escalation mapping. */
  escalationGraph?: EscalationGraph;
  /** If true, skip all network calls to intelligence sources (OSV, GitHub Advisory, NVD, CISA-KEV, EPSS). Only local inventory and npm-registry version resolution proceed. */
  offlineIntelligence?: boolean;
  /** Path to a local JSON snapshot of pre-fetched CVE intelligence. Used when offlineIntelligence is true to supply CveDetails without network calls. */
  intelligenceSnapshotPath?: string;
  /** If true, execute dual-stage exploit reproduction proof-of-fix verification (assert failure pre-patch, assert pass post-patch). */
  proofOfFix?: boolean;
  /** If true, reject patches and roll back if proof-of-fix verification fails. */
  requireProofOfFix?: boolean;
  /** Optional reproduction test script content or file path. */
  reproductionTest?: string;
  /** If true, attempt agentic call-site refactoring when major version upgrades introduce breaking API changes. */
  breakingChangeRefactor?: boolean;
  /**
   * SDK and CLI only (not accepted over MCP or HTTP, so an agent cannot lift a person's constraint):
   * plan as if the repository's memory were empty, ignoring pinned packages and rejected upgrades.
   */
  ignoreMemory?: boolean;
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
  summary: string;
  evidenceFile?: string;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
  resumedFromCache?: boolean;
  /** `planRemediation` only: the run holding this preview as an applicable plan. */
  runId?: string;
  /** `planRemediation` only: content id of that plan. */
  planId?: string;
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
  /** Set when the policy configures earned autonomy: the level in force and what it says about this result. */
  autonomy?: AutonomySummary;
}
