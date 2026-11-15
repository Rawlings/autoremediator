/**
 * Wire schemas for every option a caller can pass to remediation, as zod.
 *
 * This is the single definition behind the JSON Schemas that MCP tools, OpenAPI paths and CLI help
 * advertise, and behind input validation on those surfaces. Option names follow the canonical
 * naming in AGENTS.md. Fields that cannot travel over a wire (a `PatchGenerator` instance) are
 * SDK-only and deliberately absent.
 */
import { z } from "zod";

import {
  CHANGE_REQUEST_GROUPING_VALUES,
  CHANGE_REQUEST_PROVIDER_VALUES,
  D,
  PACKAGE_MANAGER_VALUES,
  PROVENANCE_SOURCE_VALUES,
  SCAN_FORMAT_VALUES,
  SEVERITY_VALUES,
  constraintsSchema,
  dispositionPolicySchema,
  escalationGraphSchema,
  exploitSignalOverrideSchema,
  patchConfidenceThresholdsSchema,
  pathField,
  supplyChainPolicySchema,
} from "../../infra/policy/schemas.js";
import { PACKAGE_NAME_MAX_LENGTH, PACKAGE_NAME_PATTERN } from "../../shared/package-name.js";
import type { RemediateOptions } from "./types.js";

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
  autoApply: z
    .boolean()
    .optional()
    .describe("Apply the upstream fix and retire the patch when one is available"),
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
      .describe(
        "Git base reference to compare against (e.g. 'HEAD', 'origin/main'). Defaults to 'HEAD'.",
      ),
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
    enrichIntelligence: z
      .boolean()
      .describe("Enrich with live CISA KEV and EPSS intelligence feeds"),
  })
  .partial()
  .strict();

export const getAutonomyOptionsSchema = z
  .object({
    cwd: pathField(D.cwd),
    policy: pathField(D.autonomyOptions),
  })
  .partial()
  .strict();

/** A name that is safe in a registry path and under `node_modules/`; see `isValidPackageName`. */
export const registryPackageName = (): z.ZodString =>
  z
    .string(required("packageName"))
    .min(1, required("packageName"))
    .max(PACKAGE_NAME_MAX_LENGTH)
    .regex(PACKAGE_NAME_PATTERN, "Not a valid npm package name");

export const packageNameSchema = registryPackageName().describe("Package name");

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
      .describe(
        "Verify each item after applying it and take it back out if it fails (default: true)",
      ),
    repair: z
      .boolean()
      .optional()
      .describe(
        "When an upgrade breaks the project's type check or tests, have an agent repair the project's source in an isolated checkout and keep the result only if the verifier accepts it. Default: on when a model is configured; true without a model is an error",
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Language model for repair as "<provider>:<model-id>" (default: AUTOREMEDIATOR_MODEL)',
      ),
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
  .regex(
    ATTEMPT_ID_PATTERN,
    "attemptId must look like attempt_ followed by 12 lowercase letters or digits",
  )
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
type SdkOnly = "patchGenerator" | "ignoreMemory";
type NotOnTheWire = Exclude<keyof RemediateOptions, WireKeys | SdkOnly>;
type NotInTheSdk = Exclude<WireKeys, keyof RemediateOptions>;
export const wireOptionsMatchSdk: [NotOnTheWire, NotInTheSdk] extends [never, never]
  ? true
  : never = true;
