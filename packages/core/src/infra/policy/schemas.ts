/**
 * Schemas and descriptions for the policy file and for the options every surface shares: the value
 * lists, the one-line descriptions that MCP, HTTP and CLI help all print, and the zod schemas for
 * constraints, autonomy, disposition, escalation and exploit-signal policy. The policy-file loader
 * (`policy.ts`) and the wire option schemas (`features/remediate/option-schemas.ts`) both build on
 * this file.
 */
import { z } from "zod";

import type { UnresolvedReason } from "../../shared/types.js";

export const PACKAGE_MANAGER_VALUES = ["npm", "pnpm", "yarn", "bun", "deno"] as const;
export const PROVENANCE_SOURCE_VALUES = ["cli", "sdk", "mcp", "openapi", "unknown"] as const;
export const SCAN_FORMAT_VALUES = ["npm-audit", "yarn-audit", "sarif", "auto"] as const;
export const INSTALL_MODE_VALUES = ["deterministic", "prefer-offline", "standard"] as const;
export const CHANGE_REQUEST_PROVIDER_VALUES = ["github", "gitlab"] as const;
export const CHANGE_REQUEST_GROUPING_VALUES = [
  "all",
  "per-cve",
  "per-package",
  "by-severity",
] as const;
export const ESCALATION_ACTION_VALUES = [
  "open-issue",
  "notify-channel",
  "create-draft-pr",
  "hold-branch",
  "none",
] as const;
export const SEVERITY_VALUES = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

/** Every reason a result can be unresolved, as a runtime list kept in step with the type. */
export const UNRESOLVED_REASON_VALUES = [
  "constraint-blocked",
  "transitive-dependency",
  "transitive-override-unsupported-deno-native",
  "install-failed",
  "major-bump-required",
  "no-safe-version",
  "override-apply-failed",
  "package-json-not-found",
  "patch-apply-failed",
  "patch-confidence-too-low",
  "patch-generation-failed",
  "patch-validation-failed",
  "proof-of-fix-failed",
  "breaking-change-unresolved",
  "policy-blocked",
  "requires-llm-fallback",
  "source-fetch-failed",
  "validation-failed",
] as const satisfies readonly UnresolvedReason[];

// Fails to compile when UnresolvedReason gains a member that the list above is missing.
type MissingReason = Exclude<UnresolvedReason, (typeof UNRESOLVED_REASON_VALUES)[number]>;
export const unresolvedReasonsAreComplete: MissingReason extends never ? true : never = true;

export const OPTION_DESCRIPTIONS = {
  cveId: "CVE ID, e.g. CVE-2021-23337",
  inputPath: "Absolute path to the scanner output file",
  cwd: "Absolute path to the project root (default: process.cwd())",
  packageManager: "Package manager override (auto-detected by default)",
  dryRun: "If true, plan changes but write nothing",
  preview: "If true, enforce non-mutating preview mode",
  simulationMode:
    "If true, attach deterministic simulation and rebuttal metadata for dry-run or preview execution",
  runTests: "Run package-manager test command after applying fix",
  model:
    'Language model for the patch fallback as "<provider>:<model-id>", e.g. "anthropic:claude-sonnet-5-5" (default: AUTOREMEDIATOR_MODEL)',
  patchConfidenceThresholdLow: "Patch acceptance confidence threshold for low-risk patches (0..1)",
  patchConfidenceThresholdMedium:
    "Patch acceptance confidence threshold for medium-risk patches (0..1)",
  patchConfidenceThresholdHigh:
    "Patch acceptance confidence threshold for high-risk patches (0..1)",
  patchesDir: "Directory to write .patch files (default: ./patches)",
  policy: "Optional path to .github/autoremediator.yml policy file",
  requestId: "Request correlation ID",
  sessionId: "Session correlation ID",
  parentRunId: "Parent run correlation ID",
  idempotencyKey: "Idempotency key for replay-safe execution",
  resume: "Return cached result for matching idempotency key when available",
  actor: "Actor identity for evidence provenance",
  source: "Source system for provenance",
  format: "Scanner format (default: auto)",
  audit: "Run package-manager-native audit command instead of reading a scan file",
  evidence: "Write evidence JSON to .autoremediator/evidence/ (default: true)",
  directDependenciesOnly: "Restrict remediation to direct dependencies only",
  preferVersionBump:
    "Reject override and patch remediation when version-bump-only policy is required",
  installMode: "Install behavior profile: deterministic|prefer-offline|standard",
  installPreferOffline: "Override prefer-offline flag behavior for install commands",
  enforceFrozenLockfile: "Override frozen lockfile behavior for install commands",
  workspace: "Workspace/package selector for scoped remediation in monorepos",
  createChangeRequest: "Enable creation of native pull request / merge request after remediation",
  changeRequestProvider: "Change request provider (github|gitlab|bitbucket|azure-devops)",
  changeRequestGrouping: "Grouping strategy for change requests (all|per-cve|per-package)",
  changeRequestRepository: "Repository slug override for change request creation",
  changeRequestBaseBranch: "Base branch used for change request targeting",
  changeRequestBranchPrefix: "Branch prefix for generated change request branches",
  changeRequestTitlePrefix: "Title prefix for generated change requests",
  includeTransitive: "Include transitive dependencies in the outdated check. Default: false.",
  updateOutdated:
    "Run in update-outdated mode: bump all outdated npm packages without requiring a CVE.",
  kevMandatory:
    "If true, CVEs with active CISA KEV status bypass severity filtering and are treated as mandatory",
  epssThreshold:
    "EPSS probability threshold (0..1) above which a CVE is treated as mandatory regardless of severity",
  suppressionsFile:
    "Path to a YAML file containing additional VEX suppression entries to merge with policy-inline suppressions",
  slaCheck:
    "Compare CVE publication dates against configured SLA windows and include breach records in the report output",
  skipUnreachable:
    "Skip remediation for CVEs where the vulnerable package cannot be reached from any project entry point (requires static import analysis)",
  dispositionPolicy:
    "Autonomous disposition policy controlling when fixes are auto-applied, held, or escalated",
  dispositionPolicyMinConfidenceForAutoApply:
    "Minimum patch confidence (0–1) required for auto-apply disposition",
  dispositionPolicyHoldForTransitive:
    "Hold transitive dependency fixes for human review instead of auto-applying",
  dispositionPolicyEscalateOnSlaBreachSeverities:
    "CVE severities that trigger escalate disposition on SLA breach",
  dispositionPolicyEscalateOnKev: "Escalate disposition for CVEs with active CISA KEV status",
  containmentMode:
    "Roll back applied results whose disposition is hold-for-approval (low confidence, held transitive) so they await approval; urgent escalate fixes (KEV, SLA) are kept",
  campaignMode: "Enable portfolio campaign mode to risk-rank targets before execution",
  escalationGraph: "Optional mapping from unresolved reasons to intended escalation actions",
  offlineIntelligence:
    "Skip all network calls to intelligence sources. Only local inventory and npm-registry version resolution proceed.",
  intelligenceSnapshotPath:
    "Path to a local JSON snapshot of pre-fetched CVE intelligence (keyed by CVE ID) used when offline mode is active.",
  proofOfFix:
    "If true, enforce dual-stage exploit reproduction proof-of-fix verification (assert failure pre-patch, assert pass post-patch)",
  requireProofOfFix: "If true, reject patches and roll back if proof-of-fix verification fails",
  breakingChangeRefactor:
    "Experimental: when a major upgrade breaks type checking, rewrite consumer call sites using built-in codemods (currently rimraf and uuid only); reverted if checks still fail",
  typecheck: "Run the project's type checker after each change and roll back if it fails",
  supplyChainPolicy:
    "Supply-chain trust gate for candidate versions: minimum release age, install scripts, provenance",
  supplyChainMinPublishAgeHours: "Skip versions published more recently than this many hours",
  supplyChainBlockInstallScripts:
    "Skip versions that define preinstall, install or postinstall scripts",
  supplyChainRequireProvenance: "Require a provenance attestation on the chosen version",
  exploitSignalOverride:
    "Treat CVEs with an exploit signal as mandatory regardless of severity: CISA KEV status and/or an EPSS probability above a threshold",
  exploitSignalKevMandatory: "Treat CVEs with active CISA KEV status as mandatory",
  exploitSignalEpssMandatory: "Treat CVEs above the EPSS threshold as mandatory",
  exploitSignalEpssThreshold: "EPSS probability (0..1) above which a CVE is mandatory",
  reproductionTest: "Reproduction test script content or file path used by proof-of-fix",
  traceFile:
    "Path to a trace written by 'autoremediator trace run' (or the autoremediator/trace hook). Adds runtime evidence: whether the traced command loaded the package and, if calls were counted, called the symbol. A package that did not load is not proof that it is unreachable.",
  patchConfidenceThresholds: "Per-risk minimum confidence required to accept a generated patch",
  constraints: "Orchestration constraints that limit how remediation may change the project",
  changeRequest: "Native pull request / merge request creation controls",
  changeRequestEnabled: "Enable creation of native pull request / merge request after remediation",
  autonomy:
    "Earned autonomy: the policy sets a ceiling level (L0 observe, L1 suggest, L2 open pull request, L3 auto-merge-eligible, L4 autonomous with escalation) and the repository's own verified track record sets the level actually in force",
  autonomyCeiling: "Highest autonomy level this repository may ever act at (L0 to L4)",
  autonomyMinVerifiedRuns:
    "Verified runs in the recent window needed for L3 (twice as many for L4). Default 5",
  autonomyWindow:
    "How many of the most recent runs count as recent (a run with several changes is one run). Default 20",
  autonomyMinSuccessRate:
    "Share of recent runs that must be verified successes (0..1) for L3 and L4. Default 0.9",
  autonomyCooldownDays:
    "Days a rollback or verifier failure keeps the level capped (L1 after one, L0 after two). Default 7",
  autonomyRequireTestCoverage:
    "Require that recent verified runs also passed the project's tests (L3) and type check (L4). Default true",
  autonomyOptions: "Path to the project's policy file, whose autonomy key is read",
} as const;

export const unitInterval = z.number().min(0).max(1);

/** Short alias: the schemas below read as `describe(D.cwd)`. */
export const D = OPTION_DESCRIPTIONS;

/**
 * A string that names a filesystem path. The `x-path` keyword lands in the generated JSON Schema, so
 * clients can see which arguments are paths and the path guard knows which fields to confine.
 */
export const pathField = (description: string) =>
  z.string().meta({ "x-path": true }).describe(description);

export const supplyChainPolicySchema = z
  .object({
    minPublishAgeHours: z.number().nonnegative().describe(D.supplyChainMinPublishAgeHours),
    blockInstallScripts: z.boolean().describe(D.supplyChainBlockInstallScripts),
    requireProvenance: z.boolean().describe(D.supplyChainRequireProvenance),
  })
  .partial()
  .strict();

export const constraintsSchema = z
  .object({
    directDependenciesOnly: z.boolean().describe(D.directDependenciesOnly),
    preferVersionBump: z.boolean().describe(D.preferVersionBump),
    installMode: z.enum(INSTALL_MODE_VALUES).describe(D.installMode),
    installPreferOffline: z.boolean().describe(D.installPreferOffline),
    enforceFrozenLockfile: z.boolean().describe(D.enforceFrozenLockfile),
    workspace: z.string().min(1).describe(D.workspace),
    typecheck: z.boolean().describe(D.typecheck),
    requireProofOfFix: z.boolean().describe(D.requireProofOfFix),
    enableBreakingChangeRefactor: z.boolean().describe(D.breakingChangeRefactor),
    supplyChainPolicy: supplyChainPolicySchema.describe(D.supplyChainPolicy),
  })
  .partial()
  .strict();

export const AUTONOMY_LEVEL_VALUES = ["L0", "L1", "L2", "L3", "L4"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVEL_VALUES)[number];

/**
 * The `autonomy` key of the policy file. Only the policy file can set it: the ceiling is a trust
 * decision, so no wire option (MCP, HTTP, CLI flag) can raise it.
 */
export const autonomyPolicySchema = z
  .object({
    ceiling: z.enum(AUTONOMY_LEVEL_VALUES).describe(D.autonomyCeiling),
    minVerifiedRuns: z.number().int().min(1).max(1000).describe(D.autonomyMinVerifiedRuns),
    window: z.number().int().min(1).max(1000).describe(D.autonomyWindow),
    minSuccessRate: unitInterval.describe(D.autonomyMinSuccessRate),
    cooldownDays: z.number().min(0).max(3650).describe(D.autonomyCooldownDays),
    requireTestCoverage: z.boolean().describe(D.autonomyRequireTestCoverage),
  })
  .partial({
    minVerifiedRuns: true,
    window: true,
    minSuccessRate: true,
    cooldownDays: true,
    requireTestCoverage: true,
  })
  .strict()
  .refine((value) => (value.window ?? 20) >= 2 * (value.minVerifiedRuns ?? 5), {
    message: "window must be at least twice minVerifiedRuns, or L4 could never be reached",
    path: ["window"],
  });
export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;

export const patchConfidenceThresholdsSchema = z
  .object({
    low: unitInterval.describe(D.patchConfidenceThresholdLow),
    medium: unitInterval.describe(D.patchConfidenceThresholdMedium),
    high: unitInterval.describe(D.patchConfidenceThresholdHigh),
  })
  .partial()
  .strict();

export const exploitSignalOverrideSchema = z
  .object({
    kev: z.object({ mandatory: z.boolean().describe(D.exploitSignalKevMandatory) }).strict(),
    epss: z
      .object({
        mandatory: z.boolean().describe(D.exploitSignalEpssMandatory),
        threshold: unitInterval.describe(D.exploitSignalEpssThreshold),
      })
      .strict(),
  })
  .partial()
  .strict();

export const dispositionPolicySchema = z
  .object({
    minConfidenceForAutoApply: unitInterval.describe(D.dispositionPolicyMinConfidenceForAutoApply),
    holdForTransitive: z.boolean().describe(D.dispositionPolicyHoldForTransitive),
    escalateOnKev: z.boolean().describe(D.dispositionPolicyEscalateOnKev),
    escalateOnSlaBreachSeverities: z
      .array(z.enum(SEVERITY_VALUES))
      .describe(D.dispositionPolicyEscalateOnSlaBreachSeverities),
  })
  .partial()
  .strict();

const escalationActionSchema = z.enum(ESCALATION_ACTION_VALUES).optional();

/** Maps each unresolved reason to an intended follow-up action; unknown reasons are rejected. */
export const escalationGraphSchema = z
  .object(
    Object.fromEntries(
      UNRESOLVED_REASON_VALUES.map((reason) => [reason, escalationActionSchema]),
    ) as Record<(typeof UNRESOLVED_REASON_VALUES)[number], typeof escalationActionSchema>,
  )
  .strict();
