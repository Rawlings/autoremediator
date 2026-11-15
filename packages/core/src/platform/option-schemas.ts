/**
 * Wire schemas for every option a caller can pass to remediation, as zod.
 *
 * This is the single definition behind the JSON Schemas that MCP tools, OpenAPI paths and CLI help
 * advertise, and behind input validation on those surfaces. Option names follow the canonical
 * naming in AGENTS.md. Fields that cannot travel over a wire (a `PatchGenerator` instance) are
 * SDK-only and deliberately absent.
 */
import { z } from "zod";

import type { RemediateOptions, UnresolvedReason } from "./types.js";

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
  supplyChainBlockInstallScripts: "Skip versions that define preinstall, install or postinstall scripts",
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
} as const;

const unitInterval = z.number().min(0).max(1);
const D = OPTION_DESCRIPTIONS;

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
    minConfidenceForAutoApply: unitInterval.describe(
      D.dispositionPolicyMinConfidenceForAutoApply,
    ),
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

export const changeRequestOptionsSchema = z
  .object({
    enabled: z.boolean().describe(D.createChangeRequest),
    provider: z.enum(CHANGE_REQUEST_PROVIDER_VALUES).describe(D.changeRequestProvider),
    grouping: z.enum(CHANGE_REQUEST_GROUPING_VALUES).describe(D.changeRequestGrouping),
    repository: z.string().describe(D.changeRequestRepository),
    baseBranch: z.string().describe(D.changeRequestBaseBranch),
    branchPrefix: z.string().describe(D.changeRequestBranchPrefix),
    titlePrefix: z.string().describe(D.changeRequestTitlePrefix),
  })
  .partial()
  .strict();

/** Options shared by every operation that remediates; the wire form of `RemediateOptions`. */
export const remediateOptionsSchema = z
  .object({
    cwd: pathField(D.cwd),
    packageManager: z.enum(PACKAGE_MANAGER_VALUES).describe(D.packageManager),
    dryRun: z.boolean().describe(D.dryRun),
    preview: z.boolean().describe(D.preview),
    simulationMode: z.boolean().describe(D.simulationMode),
    runTests: z.boolean().describe(D.runTests),
    typecheck: z.boolean().describe(D.typecheck),
    supplyChainPolicy: supplyChainPolicySchema.describe(D.supplyChainPolicy),
    model: z.string().describe(D.model),
    patchConfidenceThresholds: patchConfidenceThresholdsSchema.describe(
      D.patchConfidenceThresholds,
    ),
    patchesDir: pathField(D.patchesDir),
    policy: pathField(D.policy),
    evidence: z.boolean().describe(D.evidence),
    requestId: z.string().describe(D.requestId),
    sessionId: z.string().describe(D.sessionId),
    parentRunId: z.string().describe(D.parentRunId),
    idempotencyKey: z.string().describe(D.idempotencyKey),
    resume: z.boolean().describe(D.resume),
    actor: z.string().describe(D.actor),
    source: z.enum(PROVENANCE_SOURCE_VALUES).describe(D.source),
    constraints: constraintsSchema.describe(D.constraints),
    changeRequest: changeRequestOptionsSchema.describe(D.changeRequest),
    exploitSignalOverride: exploitSignalOverrideSchema.describe(D.exploitSignalOverride),
    suppressionsFile: pathField(D.suppressionsFile),
    slaCheck: z.boolean().describe(D.slaCheck),
    skipUnreachable: z.boolean().describe(D.skipUnreachable),
    dispositionPolicy: dispositionPolicySchema.describe(D.dispositionPolicy),
    containmentMode: z.boolean().describe(D.containmentMode),
    campaignMode: z.boolean().describe(D.campaignMode),
    escalationGraph: escalationGraphSchema.describe(D.escalationGraph),
    offlineIntelligence: z.boolean().describe(D.offlineIntelligence),
    intelligenceSnapshotPath: pathField(D.intelligenceSnapshotPath),
    proofOfFix: z.boolean().describe(D.proofOfFix),
    requireProofOfFix: z.boolean().describe(D.requireProofOfFix),
    reproductionTest: pathField(D.reproductionTest),
    breakingChangeRefactor: z.boolean().describe(D.breakingChangeRefactor),
  })
  .partial()
  .strict();

export const scanOptionsSchema = remediateOptionsSchema.extend({
  format: z.enum(SCAN_FORMAT_VALUES).optional().describe(D.format),
  audit: z.boolean().optional().describe(D.audit),
});

export const updateOutdatedOptionsSchema = remediateOptionsSchema
  .omit({ simulationMode: true })
  .extend({ includeTransitive: z.boolean().optional().describe(D.includeTransitive) });

const required = (field: string, kind = "string") => `${field} is required (${kind})`;

export const portfolioTargetSchema = z
  .object({
    cwd: pathField(D.cwd),
    label: z.string().optional().describe("Display label for this target"),
    cveId: z.string().optional().describe(D.cveId),
    inputPath: pathField(D.inputPath).optional(),
    format: z.enum(SCAN_FORMAT_VALUES).optional().describe(D.format),
    audit: z.boolean().optional().describe(D.audit),
    riskHint: z
      .object({
        severity: z.enum(SEVERITY_VALUES).optional(),
        exploitSignal: z.boolean().optional(),
        slaBreached: z.boolean().optional(),
      })
      .strict()
      .optional()
      .describe("Known risk signals used to rank this target when campaignMode is on"),
  })
  .strict();

export const patchArtifactQuerySchema = z
  .object({
    cwd: pathField(D.cwd),
    patchesDir: pathField(D.patchesDir),
    packageManager: z.enum(PACKAGE_MANAGER_VALUES).describe(D.packageManager),
  })
  .partial()
  .strict();

export const reconcileOptionsSchema = patchArtifactQuerySchema.extend({
  autoApply: z.boolean().optional().describe("Apply the upstream fix and retire the patch when one is available"),
  runTests: z.boolean().optional().describe(D.runTests),
});

export const patchFilePathSchema = z
  .string(required("patchFilePath"))
  .min(1, required("patchFilePath"))
  .meta({ "x-path": true })
  .describe("Path to the .patch file");

export const deltaScanOptionsSchema = z
  .object({
    cwd: pathField(D.cwd),
    baseRef: z
      .string()
      .describe("Git base reference to compare against (e.g. 'HEAD', 'origin/main'). Defaults to 'HEAD'."),
    includeUnstaged: z.boolean().describe("Also compare unstaged working-tree changes"),
    packageManager: z.enum(PACKAGE_MANAGER_VALUES).describe(D.packageManager),
  })
  .partial()
  .strict();

export const evaluatePackageOptionsSchema = z
  .object({
    version: z.string().describe("Specific package version to evaluate"),
    packageManager: z.enum(PACKAGE_MANAGER_VALUES).describe(D.packageManager),
    cwd: pathField("Project root whose .npmrc selects the registry (default: process.cwd())"),
    enrichIntelligence: z.boolean().describe("Enrich with live CISA KEV and EPSS intelligence feeds"),
  })
  .partial()
  .strict();

export const packageNameSchema = z
  .string(required("packageName"))
  .min(1, required("packageName"))
  .describe("Package name");

const RUN_ID_PATTERN = /^run_[0-9a-z]{20}$/;
const PLAN_ID_PATTERN = /^plan_[0-9a-f]{16}$/;
export const RUN_STATUS_VALUES = [
  "planned",
  "applying",
  "applied",
  "partial",
  "failed",
  "rolled-back",
] as const;

/** Verification checks in the order they run (cheap and static first). */
export const VERIFY_CHECK_VALUES = [
  "scope",
  "policy",
  "supply-chain",
  "install",
  "vuln-gone",
  "typecheck",
  "tests",
  "proof-of-fix",
] as const;

export const runIdSchema = z
  .string(required("runId"))
  .regex(RUN_ID_PATTERN, "runId must look like run_ followed by 20 lowercase letters or digits")
  .describe("Run id returned by planRemediation");

export const optionalRunIdSchema = z
  .string()
  .regex(RUN_ID_PATTERN, "runId must look like run_ followed by 20 lowercase letters or digits")
  .optional()
  .describe("Run id returned by planRemediation");

export const planIdSchema = z
  .string()
  .regex(PLAN_ID_PATTERN, "planId must look like plan_ followed by 16 hex digits")
  .optional()
  .describe("Plan id returned by planRemediation (alternative to runId)");

export const applyPlanOptionsSchema = z
  .object({
    cwd: pathField(D.cwd).optional(),
    runId: optionalRunIdSchema,
    planId: planIdSchema,
    itemIds: z
      .array(z.string())
      .optional()
      .describe("Apply only these plan items (default: every item not yet applied)"),
    verify: z
      .boolean()
      .optional()
      .describe("Verify each item after applying it and take it back out if it fails (default: true)"),
    repair: z
      .boolean()
      .optional()
      .describe(
        "When an upgrade breaks the project's type check or tests, have an agent repair the project's source in an isolated checkout and keep the result only if the verifier accepts it. Default: on when a model is configured; true without a model is an error",
      ),
    model: z
      .string()
      .optional()
      .describe('Language model for repair as "<provider>:<model-id>" (default: AUTOREMEDIATOR_MODEL)'),
    maxRepairRounds: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Times the verifier's findings are handed back to the agent per item (default: 3)"),
  })
  .strict();

export const runQuerySchema = z
  .object({ runId: runIdSchema, cwd: pathField(D.cwd).optional() })
  .strict();

export const rollbackRunOptionsSchema = runQuerySchema.extend({
  force: z
    .boolean()
    .optional()
    .describe("Roll back even though the project changed since the run's last step"),
  reinstall: z
    .boolean()
    .optional()
    .describe("Reinstall dependencies from the restored lockfile (default: true)"),
});

const ITEM_ID_PATTERN = /^item_[0-9a-f]{12}$/;
const ATTEMPT_ID_PATTERN = /^attempt_[0-9a-z]{12}$/;

export const itemIdSchema = z
  .string(required("itemId"))
  .regex(ITEM_ID_PATTERN, "itemId must look like item_ followed by 12 hex digits")
  .describe("Plan item id, from the run's plan");

export const attemptIdSchema = z
  .string(required("attemptId"))
  .regex(ATTEMPT_ID_PATTERN, "attemptId must look like attempt_ followed by 12 lowercase letters or digits")
  .describe("Attempt id returned by startAttempt");

export const startAttemptOptionsSchema = z
  .object({ runId: runIdSchema, itemId: itemIdSchema, cwd: pathField(D.cwd).optional() })
  .strict();

export const attemptQuerySchema = z
  .object({ runId: runIdSchema, attemptId: attemptIdSchema, cwd: pathField(D.cwd).optional() })
  .strict();

export const proposePatchOptionsSchema = attemptQuerySchema.extend({
  diff: z
    .string(required("diff"))
    .min(1, required("diff"))
    .describe(
      "A unified diff (as `git diff` prints it) of project source files. Dependency files, CI and config cannot be changed",
    ),
});

export const verifyAttemptOptionsSchema = attemptQuerySchema.extend({
  checks: z
    .array(z.enum(VERIFY_CHECK_VALUES))
    .optional()
    .describe("Run only these checks (default: everything an attempt is judged on)"),
});

export const verifyRunOptionsSchema = runQuerySchema.extend({
  checks: z
    .array(z.enum(VERIFY_CHECK_VALUES))
    .optional()
    .describe("Run only these checks (default: all, in order, stopping at the first failure)"),
  offline: z.boolean().optional().describe("Skip checks that need the network"),
});

export const listRunsOptionsSchema = z
  .object({
    cwd: pathField(D.cwd).optional(),
    status: z.enum(RUN_STATUS_VALUES).optional().describe("Only runs in this state"),
    limit: z.number().int().positive().optional().describe("Return at most this many runs"),
  })
  .strict();

// Compile-time guard: the wire schema and the SDK options type must list the same fields.
type WireKeys = keyof z.input<typeof remediateOptionsSchema>;
type SdkOnly = "patchGenerator";
type NotOnTheWire = Exclude<keyof RemediateOptions, WireKeys | SdkOnly>;
type NotInTheSdk = Exclude<WireKeys, keyof RemediateOptions>;
export const wireOptionsMatchSdk: [NotOnTheWire, NotInTheSdk] extends [never, never] ? true : never =
  true;
