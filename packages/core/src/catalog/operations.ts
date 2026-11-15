import { z } from "zod";

import { stripUntrustedChangeRequestFields } from "../api/change-request/index.js";
import { HOOK_MANAGERS, HOOK_NAMES } from "../api/hooks/types.js";
import type {
  PortfolioTarget,
  RemediateOptions,
  ScanOptions,
  UpdateOutdatedOptions,
} from "../api/index.js";
import { AGENT_HOSTS } from "../api/init/types.js";
import {
  applyPlanOptionsSchema,
  attemptQuerySchema,
  proposePatchOptionsSchema,
  startAttemptOptionsSchema,
  verifyAttemptOptionsSchema,
  listRunsOptionsSchema,
  rollbackRunOptionsSchema,
  runQuerySchema,
  deltaScanOptionsSchema,
  evaluatePackageOptionsSchema,
  getAutonomyOptionsSchema,
  OPTION_DESCRIPTIONS,
  packageNameSchema,
  pathField,
  patchArtifactQuerySchema,
  patchFilePathSchema,
  portfolioTargetSchema,
  reconcileOptionsSchema,
  remediateOptionsSchema,
  scanOptionsSchema,
  updateOutdatedOptionsSchema,
  verifyRunOptionsSchema,
} from "../platform/option-schemas.js";
import { PACKAGE_VERSION } from "../version.js";
import { defineOperation, type Operation, type OperationContext } from "./define-operation.js";
import { EVIDENCE_PACK_OPERATIONS } from "./evidence-pack-operations.js";
import { FRESHNESS_OPERATIONS } from "./freshness-operations.js";
import { INCIDENT_OPERATIONS } from "./incident-operations.js";
import { MAINTAINER_VEX_OPERATIONS } from "./maintainer-vex-operations.js";
import { MEMORY_OPERATIONS } from "./memory-operations.js";
import { POLICY_OPERATIONS } from "./policy-operations.js";
import { PROVE_OPERATIONS } from "./prove-operations.js";
import { RADAR_OPERATIONS } from "./radar-operations.js";
import { RESPONSES } from "./responses.js";

const cveId = z.string("cveId is required (string)").min(1, "cveId is required (string)");
const exactVersion = z
  .string("an exact version is required (string)")
  .regex(
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/,
    "must be an exact semver version such as 4.17.21",
  );
const inputPath = z
  .string("inputPath is required (string)")
  .min(1, "inputPath is required (string)")
  .meta({ "x-path": true })
  .describe(OPTION_DESCRIPTIONS.inputPath);
const targets = z
  .array(portfolioTargetSchema, "targets is required (array)")
  .describe("Repositories to remediate, each by CVE id, scan file or audit");

/** Options as the SDK expects them: untrusted change-request fields removed, provenance set. */
function sdkOptions<T extends { source?: string }>(wire: T, context: OperationContext): T {
  const cleaned = stripUntrustedChangeRequestFields(wire);
  return { ...cleaned, source: cleaned.source ?? context.source };
}

const { dryRun: _dryRun, preview: _preview, ...planOptionShape } = remediateOptionsSchema.shape;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const READ_ONLY_NETWORK = { ...READ_ONLY, openWorldHint: true } as const;
/** Changes the project (unless `dryRun`), so a host should ask before calling it. */
const MUTATING = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
/** Undoes a run: edits the project, but only by restoring what the run changed. */
const ROLLBACK = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
/** Computes a preview; writes only its own evidence record. */
const PLANNING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: "health",
    title: "Health check",
    description:
      "Health check tool that returns server readiness status, version, registered tool count, and the list of available capability names.",
    input: z.object({}).strict(),
    annotations: READ_ONLY,
    response: RESPONSES.health,
    mcp: true,
    handler: async (_input, context) => ({
      ...(await context.api.healthFn()),
      version: PACKAGE_VERSION,
      toolCount: context.operationNames.length,
      capabilities: context.operationNames,
    }),
  }),
  defineOperation({
    name: "init",
    title: "Set up a project",
    description:
      "Set the project up for Autoremediator and the coding agents it uses: policy file, .gitignore, MCP configuration per agent host, agent instructions. Reports what it would change unless yes is set. Command line and SDK only.",
    input: z
      .object({
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
        hosts: z
          .array(z.enum(AGENT_HOSTS))
          .optional()
          .describe(
            "Agent hosts to configure. Default: those found in the project, else those installed.",
          ),
        ci: z
          .boolean()
          .optional()
          .describe("Also write a weekly remediation workflow for GitHub Actions."),
        policy: z
          .boolean()
          .optional()
          .describe("Write the policy file when missing. Default true."),
        guard: z
          .boolean()
          .optional()
          .describe(
            "Also install guard hooks for Claude Code, Cursor and Copilot, and a pnpmfile for pnpm projects, so package installs are checked first. Default false.",
          ),
        agentsMd: z
          .boolean()
          .optional()
          .describe("Add an Autoremediator section to AGENTS.md. Default true."),
        yes: z.boolean().optional().describe("Write the changes. Without it, only report them."),
        check: z.boolean().optional().describe("Report drift only; never write."),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    response: RESPONSES.init,
    mcp: false,
    handler: (options, context) => context.api.initFn(options),
  }),
  defineOperation({
    name: "installHooks",
    title: "Install git hooks",
    description:
      "Install, remove or check git hooks that run Autoremediator: pre-push blocks a push whose lockfile changes make the project less safe, post-merge prints a one-line advisory. Detects husky, lefthook, the pre-commit framework or plain git hooks and writes a marked block, never overwriting what it cannot merge. Reports what it would change unless yes is set. Command line and SDK only.",
    input: z
      .object({
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
        hooks: z
          .array(z.enum(HOOK_NAMES))
          .optional()
          .describe("Hooks to handle. Default: pre-push and post-merge."),
        manager: z
          .enum(HOOK_MANAGERS)
          .optional()
          .describe(
            "Hook manager to write for. Default: detected (husky, lefthook, pre-commit, else git).",
          ),
        uninstall: z.boolean().optional().describe("Remove the hooks Autoremediator installed."),
        yes: z.boolean().optional().describe("Write the changes. Without it, only report them."),
        check: z.boolean().optional().describe("Report drift only; never write."),
        allowSharedHooksPath: z
          .boolean()
          .optional()
          .describe(
            "Write into a hooks folder outside the repository (a global core.hooksPath shared with other repositories). Default: report it as a conflict.",
          ),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    response: RESPONSES.installHooks,
    mcp: false,
    handler: (options, context) => context.api.installHooksFn(options),
  }),
  defineOperation({
    name: "remediate",
    title: "Remediate a CVE",
    description:
      "Remediate a single CVE in a Node.js project. Looks up the CVE, scans the project inventory, and applies a version bump or generates a patch file. Returns a RemediationReport.",
    input: z
      .object({ cveId: cveId.describe(OPTION_DESCRIPTIONS.cveId), ...remediateOptionsSchema.shape })
      .strict(),
    annotations: MUTATING,
    response: RESPONSES.remediationReport,
    mcp: true,
    http: { method: "POST", path: "/remediate", positional: ["cveId"] },
    handler: ({ cveId: id, ...options }, context) =>
      context.api.remediateFn(id, sdkOptions(options, context) as RemediateOptions),
  }),
  defineOperation({
    name: "planRemediation",
    title: "Preview a remediation",
    description:
      "Generate a non-mutating remediation preview for a single CVE in a Node.js project. Returns a RemediationReport with planned results.",
    input: z
      .object({ cveId: cveId.describe(OPTION_DESCRIPTIONS.cveId), ...planOptionShape })
      .strict(),
    annotations: PLANNING,
    response: RESPONSES.remediationReport,
    mcp: true,
    http: { method: "POST", path: "/plan-remediation", positional: ["cveId"] },
    handler: ({ cveId: id, ...options }, context) =>
      context.api.planRemediationFn(id, sdkOptions(options, context) as RemediateOptions),
  }),
  defineOperation({
    name: "remediateFromScan",
    title: "Remediate from a scan file",
    description:
      "Parse an npm/pnpm/yarn/bun audit JSON or SARIF scan file, extract all CVE IDs, and remediate each one. Returns a ScanReport.",
    input: z.object({ inputPath, ...scanOptionsSchema.shape }).strict(),
    annotations: MUTATING,
    response: RESPONSES.scanReport,
    mcp: true,
    http: { method: "POST", path: "/remediate-from-scan", positional: ["inputPath"] },
    handler: ({ inputPath: path, ...options }, context) =>
      context.api.remediateFromScanFn(path, sdkOptions(options, context) as ScanOptions),
  }),
  defineOperation({
    name: "remediatePortfolio",
    title: "Remediate a portfolio",
    description:
      "Run CVE or scan remediation across multiple targets and return an aggregated PortfolioReport.",
    input: z.object({ targets, ...remediateOptionsSchema.shape }).strict(),
    annotations: MUTATING,
    response: RESPONSES.portfolioReport,
    mcp: true,
    http: { method: "POST", path: "/remediate-portfolio", positional: ["targets"] },
    handler: ({ targets: list, ...options }, context) =>
      context.api.remediatePortfolioFn(
        list as PortfolioTarget[],
        sdkOptions(options, context) as RemediateOptions,
      ),
  }),
  defineOperation({
    name: "listPatchArtifacts",
    title: "List patch artifacts",
    description:
      "List stored patch artifacts in the configured patches directory. Returns patch summaries with manifest metadata when available.",
    input: patchArtifactQuerySchema,
    annotations: READ_ONLY,
    response: RESPONSES.patchSummaries,
    mcp: true,
    http: { method: "POST", path: "/patches/list", positional: [] },
    handler: (options, context) => context.api.listPatchArtifactsFn(options),
  }),
  defineOperation({
    name: "inspectPatchArtifact",
    title: "Inspect a patch artifact",
    description: "Inspect a stored .patch file and its optional manifest metadata.",
    input: z
      .object({ patchFilePath: patchFilePathSchema, ...patchArtifactQuerySchema.shape })
      .strict(),
    annotations: READ_ONLY,
    response: RESPONSES.patchInspection,
    mcp: true,
    http: { method: "POST", path: "/patches/inspect", positional: ["patchFilePath"] },
    handler: ({ patchFilePath, ...options }, context) =>
      context.api.inspectPatchArtifactFn(patchFilePath, options),
  }),
  defineOperation({
    name: "validatePatchArtifact",
    title: "Validate a patch artifact",
    description:
      "Validate a stored patch artifact against its manifest and the current dependency inventory.",
    input: z
      .object({ patchFilePath: patchFilePathSchema, ...patchArtifactQuerySchema.shape })
      .strict(),
    annotations: READ_ONLY,
    response: RESPONSES.patchValidation,
    mcp: true,
    http: { method: "POST", path: "/patches/validate", positional: ["patchFilePath"] },
    handler: ({ patchFilePath, ...options }, context) =>
      context.api.validatePatchArtifactFn(patchFilePath, options),
  }),
  defineOperation({
    name: "reconcilePatchArtifacts",
    title: "Reconcile patch artifacts",
    description:
      "Check each stored patch against upstream advisories and report which are obsolete because a fixed release now exists. With autoApply, bump to the fixed version and retire the patch.",
    input: reconcileOptionsSchema,
    annotations: MUTATING,
    response: RESPONSES.patchReconciliation,
    mcp: true,
    http: { method: "POST", path: "/patches/reconcile", positional: [] },
    handler: (options, context) => context.api.reconcilePatchArtifactsFn(options),
  }),
  defineOperation({
    name: "applyPlan",
    title: "Apply a plan",
    description:
      "Apply the plan from a planRemediation run (by runId or planId). The project's manifests and lockfiles are snapshotted first, each item is recorded as it is attempted and verified, and the run can be resumed or rolled back. Refused if the project, lockfiles or policy changed since the plan was made. If an upgrade breaks the project's checks and a model is configured, an agent repairs the project's source in an isolated checkout and the result is kept only if the verifier accepts it. Model-generated patches are not part of a plan.",
    input: applyPlanOptionsSchema,
    annotations: MUTATING,
    response: RESPONSES.runReport,
    mcp: true,
    http: { method: "POST", path: "/runs/apply", positional: ["runId", "planId"] },
    handler: ({ maxRepairRounds, ...options }, context) =>
      context.api.applyPlanFn({
        ...options,
        ...(maxRepairRounds ? { repairBudget: { maxRepairRounds } } : {}),
      }),
  }),
  defineOperation({
    name: "resumeRun",
    title: "Resume a run",
    description:
      "Continue a run that was interrupted or ended partial or failed, skipping items already applied. Refused if the project changed since the run's last completed step.",
    input: runQuerySchema,
    annotations: MUTATING,
    response: RESPONSES.runReport,
    mcp: true,
    http: { method: "POST", path: "/runs/resume", positional: ["runId"] },
    handler: (options, context) => context.api.resumeRunFn(options),
  }),
  defineOperation({
    name: "rollbackRun",
    title: "Roll back a run",
    description:
      "Undo a run by restoring the manifests, lockfiles and patch files it changed from the snapshot taken before its first change. Refused if the project changed since the run's last step, unless force is set. Run your package manager's install afterwards to refresh node_modules.",
    input: rollbackRunOptionsSchema,
    annotations: ROLLBACK,
    response: RESPONSES.rollbackReport,
    mcp: true,
    http: { method: "POST", path: "/runs/rollback", positional: ["runId"] },
    handler: (options, context) => context.api.rollbackRunFn(options),
  }),
  defineOperation({
    name: "verifyRun",
    title: "Verify a run",
    description:
      "Judge a run's project as it is now with deterministic checks, cheapest first, stopping at the first failure: scope (only dependency files changed), policy, supply-chain gate, frozen install, advisories no longer matching installed packages, then type check, tests and the reproduction test when requested. No model is consulted. The result is stored with the run.",
    input: verifyRunOptionsSchema,
    annotations: PLANNING,
    response: RESPONSES.verification,
    mcp: true,
    http: { method: "POST", path: "/runs/verify", positional: ["runId"] },
    handler: (options, context) => context.api.verifyRunFn(options),
  }),
  defineOperation({
    name: "startAttempt",
    title: "Start an attempt",
    description:
      "Open an isolated checkout of the project with one plan item's upgrade applied and installed, so you can make the project work with it. Returns the checkout path (edit files there, or send diffs with proposePatch) and what the verifier found wrong. The project itself is not touched. Finish with finalizeAttempt, or abandonAttempt.",
    input: startAttemptOptionsSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    response: RESPONSES.attemptView,
    mcp: true,
    http: { method: "POST", path: "/attempts/start", positional: ["runId", "itemId"] },
    handler: (options, context) => context.api.startAttemptFn(options),
  }),
  defineOperation({
    name: "proposePatch",
    title: "Apply a patch to an attempt",
    description:
      "Apply a unified diff to an open attempt's checkout. Only project source (.js/.ts and variants) may change, the patch must be plain text and apply cleanly. Verify with verifyAttempt afterwards.",
    input: proposePatchOptionsSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    response: RESPONSES.attemptView,
    mcp: true,
    http: { method: "POST", path: "/attempts/patch", positional: ["runId", "attemptId", "diff"] },
    handler: (options, context) => context.api.proposePatchFn(options),
  }),
  defineOperation({
    name: "verifyAttempt",
    title: "Verify an attempt",
    description:
      "Run the verifier on an open attempt's checkout: scope, policy, supply chain, advisories, and the project's type check, tests and reproduction test when requested. Returns what is wrong, if anything, so you can fix it. It is the same judge that decides finalizeAttempt.",
    input: verifyAttemptOptionsSchema,
    annotations: PLANNING,
    response: RESPONSES.attemptView,
    mcp: true,
    http: { method: "POST", path: "/attempts/verify", positional: ["runId", "attemptId"] },
    handler: (options, context) => context.api.verifyAttemptFn(options),
  }),
  defineOperation({
    name: "finalizeAttempt",
    title: "Finalize an attempt",
    description:
      "Put an open attempt's change in the project. The checkout is verified once more; if it passes, the change is applied as a patch, checked again in the project and removed if that fails. Returns finalized: false, with what is wrong, when it does not verify. Roll back later with rollbackRun.",
    input: attemptQuerySchema,
    annotations: MUTATING,
    response: RESPONSES.attemptView,
    mcp: true,
    http: { method: "POST", path: "/attempts/finalize", positional: ["runId", "attemptId"] },
    handler: (options, context) => context.api.finalizeAttemptFn(options),
  }),
  defineOperation({
    name: "abandonAttempt",
    title: "Abandon an attempt",
    description:
      "Throw an open attempt away: its checkout is removed and nothing reaches the project.",
    input: attemptQuerySchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    response: RESPONSES.attemptView,
    mcp: true,
    http: { method: "POST", path: "/attempts/abandon", positional: ["runId", "attemptId"] },
    handler: (options, context) => context.api.abandonAttemptFn(options),
  }),
  defineOperation({
    name: "getRun",
    title: "Get a run",
    description:
      "Return a run's record, its plan, the outcome of each attempted item, and its step ledger with a check that the ledger has not been altered.",
    input: runQuerySchema,
    annotations: READ_ONLY,
    response: RESPONSES.runDetails,
    mcp: true,
    http: { method: "POST", path: "/runs/get", positional: ["runId"] },
    handler: (options, context) => context.api.getRunFn(options),
  }),
  defineOperation({
    name: "listRuns",
    title: "List runs",
    description: "List recorded runs in a project, newest first, optionally filtered by status.",
    input: listRunsOptionsSchema,
    annotations: READ_ONLY,
    response: RESPONSES.runList,
    mcp: true,
    http: { method: "POST", path: "/runs/list", positional: [] },
    handler: (options, context) => context.api.listRunsFn(options),
  }),
  defineOperation({
    name: "updateOutdated",
    title: "Update outdated packages",
    description:
      "Bump all outdated npm packages to their latest versions without requiring a CVE ID. Respects policy (allowMajorBumps) and supports dry-run. Returns an UpdateOutdatedReport.",
    input: updateOutdatedOptionsSchema,
    annotations: MUTATING,
    response: RESPONSES.updateOutdatedReport,
    mcp: true,
    http: { method: "POST", path: "/update-outdated", positional: [] },
    handler: (options, context) =>
      context.api.updateOutdatedFn(sdkOptions(options, context) as UpdateOutdatedOptions),
  }),
  defineOperation({
    name: "toVex",
    title: "Convert a report to VEX",
    description:
      "Convert a ScanReport or RemediationReport to a CycloneDX VEX document (1.5 by default; specVersion 1.6 adds affects by purl and schema-valid justifications). Returns a compliance-ready vulnerability exploitability exchange record binding remediation evidence to SBOM vulnerability entries.",
    input: z
      .object({
        report: z
          .record(z.string(), z.unknown(), "report is required (object)")
          .describe(
            "A ScanReport or RemediationReport object returned by remediate, planRemediation, or remediateFromScan.",
          ),
        toolVersion: z
          .string()
          .optional()
          .describe("Optional tool version to embed in the VEX document metadata."),
        specVersion: z
          .enum(["1.5", "1.6"])
          .optional()
          .describe(
            "CycloneDX version to emit. Default 1.5. 1.6 adds affects by purl and uses justifications the CycloneDX schema defines.",
          ),
      })
      .strict(),
    annotations: READ_ONLY,
    response: RESPONSES.vexDocument,
    mcp: true,
    http: { method: "POST", path: "/vex", positional: ["report"] },
    handler: ({ report, toolVersion, specVersion }, context) =>
      context.api.toVexFn(
        report as unknown as Parameters<typeof context.api.toVexFn>[0],
        toolVersion || specVersion
          ? { ...(toolVersion ? { toolVersion } : {}), ...(specVersion ? { specVersion } : {}) }
          : undefined,
      ),
  }),
  defineOperation({
    name: "submitRemediateJob",
    title: "Submit a remediation job",
    description:
      "Submit a single-CVE remediation as a background async job. Returns a JobHandle immediately with a jobId. Use pollJob to check status and retrieve the result.",
    input: z
      .object({ cveId: cveId.describe(OPTION_DESCRIPTIONS.cveId), ...remediateOptionsSchema.shape })
      .strict(),
    annotations: MUTATING,
    response: RESPONSES.jobHandle,
    mcp: true,
    http: { method: "POST", path: "/jobs/remediate", positional: ["cveId"], status: 202 },
    handler: ({ cveId: id, ...options }, context) =>
      context.api.submitRemediateJobFn(id, sdkOptions(options, context) as RemediateOptions),
  }),
  defineOperation({
    name: "submitScanJob",
    title: "Submit a scan remediation job",
    description:
      "Submit a scan-file remediation as a background async job. Returns a JobHandle immediately. Use pollJob to check status.",
    input: z.object({ inputPath, ...scanOptionsSchema.shape }).strict(),
    annotations: MUTATING,
    response: RESPONSES.jobHandle,
    mcp: true,
    http: { method: "POST", path: "/jobs/scan", positional: ["inputPath"], status: 202 },
    handler: ({ inputPath: path, ...options }, context) =>
      context.api.submitScanJobFn(path, sdkOptions(options, context) as ScanOptions),
  }),
  defineOperation({
    name: "submitPortfolioJob",
    title: "Submit a portfolio job",
    description:
      "Submit a portfolio remediation as a background async job. Returns a JobHandle immediately. Use pollJob to check status.",
    input: z.object({ targets, ...remediateOptionsSchema.shape }).strict(),
    annotations: MUTATING,
    response: RESPONSES.jobHandle,
    mcp: true,
    http: { method: "POST", path: "/jobs/portfolio", positional: ["targets"], status: 202 },
    handler: ({ targets: list, ...options }, context) =>
      context.api.submitPortfolioJobFn(
        list as PortfolioTarget[],
        sdkOptions(options, context) as RemediateOptions,
      ),
  }),
  defineOperation({
    name: "pollJob",
    title: "Poll a job",
    description:
      "Poll the status of a submitted background job. Returns the full AsyncRemediationJob including result when status is 'done' or error when 'failed'.",
    input: z
      .object({
        jobId: z
          .string("jobId is required (string)")
          .min(1, "jobId is required (string)")
          .describe("Job ID returned by submitRemediateJob, submitScanJob, or submitPortfolioJob."),
      })
      .strict(),
    annotations: READ_ONLY,
    response: RESPONSES.job,
    mcp: true,
    http: { method: "GET", path: "/jobs/:jobId", pathParam: "jobId" },
    handler: ({ jobId }, context) => context.api.pollJobFn(jobId),
  }),
  defineOperation({
    name: "checkReachability",
    title: "Check reachability",
    description:
      "Scan project source files using oxc-parser AST call-graph tracing to check if a package or vulnerable symbol is reachable and invoked. With traceFile, adds runtime evidence from a traced test run.",
    input: z
      .object({
        packageName: packageNameSchema.describe(
          "Target package name to trace in project source files.",
        ),
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
        symbol: z
          .string()
          .optional()
          .describe(
            "Optional specific vulnerable function or export symbol to verify in call graph.",
          ),
        traceFile: pathField(OPTION_DESCRIPTIONS.traceFile).optional(),
      })
      .strict(),
    annotations: READ_ONLY,
    response: RESPONSES.reachability,
    mcp: true,
    http: { method: "POST", path: "/reachability", positional: ["packageName"] },
    handler: ({ packageName, cwd, symbol, traceFile }, context) =>
      context.api.checkReachabilityFn({ packageName, cwd, symbol, traceFile }),
  }),
  defineOperation({
    name: "evaluatePackage",
    title: "Evaluate a package",
    description:
      "Pre-flight security evaluator for npm packages. Queries OSV, CISA KEV, and FIRST EPSS telemetry before installation.",
    input: z
      .object({
        packageName: packageNameSchema.describe("Package name to evaluate."),
        ...evaluatePackageOptionsSchema.shape,
      })
      .strict(),
    annotations: READ_ONLY_NETWORK,
    response: RESPONSES.packageEvaluation,
    mcp: true,
    http: { method: "POST", path: "/packages/evaluate", positional: ["packageName"] },
    handler: ({ packageName, ...options }, context) =>
      context.api.evaluatePackageFn(packageName, options),
  }),
  defineOperation({
    name: "guardPackage",
    title: "Guard a package install",
    description:
      "Judge an npm package before it is installed: does it exist, is it known malware (OSV), does it imitate a popular package, is the release inside the cooldown, did it gain install scripts or lose provenance, does it have known vulnerabilities. Returns allow, warn or block with the findings and a safer alternative. Call this before adding any dependency. Installs nothing.",
    input: z
      .object({
        spec: z
          .string("spec is required (string)")
          .min(1, "spec is required (string)")
          .max(300)
          .describe(
            "Package to check, as you would pass it to npm install: name, name@range or @scope/name@range.",
          ),
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
        minPublishAgeHours: z
          .number()
          .min(0)
          .max(24 * 365)
          .optional()
          .describe(
            "Block releases younger than this many hours. Default 72; 0 turns the check off.",
          ),
        offline: z.boolean().optional().describe("Skip the OSV malware and advisory lookups."),
      })
      .strict(),
    annotations: READ_ONLY_NETWORK,
    response: RESPONSES.guardReport,
    mcp: true,
    http: { method: "POST", path: "/packages/guard", positional: ["spec"] },
    handler: ({ spec, ...options }, context) => context.api.guardPackageFn(spec, options),
  }),
  defineOperation({
    name: "getAutonomy",
    title: "Get the autonomy level",
    description:
      "Report the autonomy level a repository is at: the ceiling its policy sets (L0 observe, L1 suggest, L2 open pull request, L3 auto-merge eligible, L4 autonomous with escalation), the level its own verified track record has earned, the lower of the two, the evidence (verified runs, rollbacks, verifier failures, whether tests and type check were part of verification), every past promotion and demotion with the event behind it, and what the next promotion needs. Read-only. Reports configured: false when the policy has no autonomy key.",
    input: getAutonomyOptionsSchema,
    annotations: READ_ONLY,
    response: RESPONSES.autonomyStatus,
    mcp: true,
    http: { method: "POST", path: "/autonomy", positional: [] },
    handler: (options, context) => context.api.getAutonomyFn(options),
  }),
  defineOperation({
    name: "analyzeDependencies",
    title: "Analyse dependencies for removal",
    description:
      "Find what the project could stop depending on: declared dependencies nothing uses (certainly-unused, probably-unused or used-indirectly, each with its reason), micro-packages a Node built-in now replaces (checked against the project's declared Node range), the same package installed at several versions with who pulls each and whether a dedupe stays within range, and a 0-100 attack-surface score with its breakdown. Reads the project, lockfile and installed packages; needs no network and changes nothing.",
    input: z.object({ cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional() }).strict(),
    annotations: READ_ONLY,
    response: RESPONSES.dietReport,
    mcp: true,
    http: { method: "POST", path: "/packages/diet", positional: [] },
    handler: ({ cwd }, context) => context.api.analyzeDependenciesFn({ cwd }),
  }),
  defineOperation({
    name: "removeUnusedDependencies",
    title: "Remove unused dependencies",
    description:
      "Remove only the dependencies analyzeDependencies calls certainly-unused through the package manager (npm or pnpm), then verify the result (scope, policy, frozen install, and the type check and tests when asked) and restore everything if any check fails. Never touches probably-unused dependencies, replaceable packages or duplicates. Command line and SDK only.",
    input: z
      .object({
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
        policy: pathField(OPTION_DESCRIPTIONS.policy).optional(),
        runTests: z
          .boolean()
          .optional()
          .describe("Run the project's tests as part of verification. Default false."),
        typecheck: z
          .boolean()
          .optional()
          .describe("Type-check as part of verification. Default true."),
      })
      .strict(),
    annotations: MUTATING,
    response: RESPONSES.dietApply,
    mcp: false,
    handler: (options, context) => context.api.removeUnusedDependenciesFn(options),
  }),
  defineOperation({
    name: "scanDelta",
    title: "Scan a git delta",
    description:
      "Git-aware delta vulnerability scanner. Identifies new CVEs introduced by uncommitted edits (vs HEAD) or branch differences (vs base branch).",
    input: deltaScanOptionsSchema,
    annotations: READ_ONLY_NETWORK,
    response: RESPONSES.deltaScan,
    mcp: true,
    http: { method: "POST", path: "/delta-scan", positional: [] },
    handler: (options, context) => context.api.scanDeltaFn(options),
  }),
  defineOperation({
    name: "listRecipes",
    title: "List recipes",
    description:
      "List the recipes available to the project: what earlier agent repairs learned about adopting a dependency's new version, kept as data (the project's committed .autoremediator/recipes, policy recipe packages, packages shipping their own). Filter by package and versions; pass recipeId for one recipe's full hunks. Read-only; recipes are never executed.",
    input: z
      .object({
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
        packageName: z
          .string()
          .min(1)
          .max(214)
          .optional()
          .describe("Only recipes for this package"),
        fromVersion: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("With toVersion: mark which recipes apply to upgrading from this version"),
        toVersion: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("With fromVersion: the version upgraded to"),
        recipeId: z.string().min(1).max(300).optional().describe("Include this recipe in full"),
      })
      .strict(),
    annotations: READ_ONLY,
    response: RESPONSES.recipeListing,
    mcp: true,
    http: { method: "POST", path: "/recipes/list", positional: [] },
    handler: (options, context) => context.api.listRecipesFn(options),
  }),
  defineOperation({
    name: "applyRecipe",
    title: "Apply a recipe to an attempt",
    description:
      "Apply a recipe to an open attempt's checkout and judge it: its hunks must match the project's source exactly (no fuzz), the resulting diff goes through the same validation as proposePatch, and the verifier decides. If it does not pass, the recipe is undone and the checkout is as it was. Recipe ids come from listRecipes or startAttempt.",
    input: attemptQuerySchema.extend({
      recipeId: z
        .string("recipeId is required (string)")
        .min(1)
        .max(300)
        .describe("Recipe id from listRecipes or startAttempt"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    response: RESPONSES.attemptView,
    mcp: true,
    http: {
      method: "POST",
      path: "/attempts/recipe",
      positional: ["runId", "attemptId", "recipeId"],
    },
    handler: (options, context) => context.api.applyRecipeFn(options),
  }),
  defineOperation({
    name: "bisectLockfile",
    title: "Bisect a lockfile change",
    description:
      "Find which package update in the lockfile difference between a good and a bad git ref makes a shell command fail (a dependency published a bad release, CI broke with no code change). Installs both refs and subsets of the updates in isolated git worktrees, runs the command in them, narrows down with delta debugging, and returns the culprit (or the smallest set that fails only together) with the evidence and a plan that pins it back. Runs the given shell command with the caller's privileges, and package install scripts unless ignoreScripts is set. Command line and SDK only.",
    input: z
      .object({
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
        good: z
          .string("good is required (string)")
          .min(1, "good is required (string)")
          .max(300)
          .describe("Git ref (commit, tag or branch) where the command passes."),
        bad: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe(
            "Git ref where the command fails. Default HEAD. The committed state is used, not the working tree.",
          ),
        command: z
          .string("command is required (string)")
          .min(1, "command is required (string)")
          .max(4000)
          .describe(
            "Shell command to run after installing; exit code 0 means pass. It runs in a checkout, never in the project directory.",
          ),
        timeoutSeconds: z
          .number()
          .positive()
          .max(86_400)
          .optional()
          .describe(
            "Kill the command after this many seconds and count it as failing. Default 600.",
          ),
        maxSteps: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Evaluate at most this many candidate states, not counting the good and bad refs. Default 30.",
          ),
        packageManager: z
          .enum(["npm", "pnpm", "yarn"])
          .optional()
          .describe("Package manager. Default: from the lockfile at the bad ref."),
        ignoreScripts: z
          .boolean()
          .optional()
          .describe(
            "Pass --ignore-scripts to every install so package install scripts do not run.",
          ),
        apply: z
          .boolean()
          .optional()
          .describe(
            "Apply the recommended pin to the project through the run machinery. Without it the pin is only planned.",
          ),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    response: RESPONSES.bisectReport,
    mcp: false,
    handler: (options, context) => context.api.bisectLockfileFn(options),
  }),
  defineOperation({
    name: "assessUpgrade",
    title: "Assess an upgrade",
    description:
      "How likely is upgrading an npm package from one version to another to break this project? Downloads both versions, compares their public API (declaration files, else JavaScript exports), engines, module format, exports map and peer dependencies, then intersects the changes with the project's own usage. Returns a High, Medium or Low rating with the affected file:line call sites and the reasons. Deterministic and explainable; a heuristic that cannot see types for untyped packages. Changes nothing.",
    input: z
      .object({
        packageName: packageNameSchema.describe("Package to assess."),
        from: exactVersion.describe("Version the project uses now."),
        to: exactVersion.describe("Version being considered."),
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
      })
      .strict(),
    annotations: READ_ONLY_NETWORK,
    response: RESPONSES.upgradeImpact,
    mcp: true,
    http: {
      method: "POST",
      path: "/packages/assess-upgrade",
      positional: ["packageName", "from", "to"],
    },
    handler: (input, context) => context.api.assessUpgradeFn(input),
  }),
  defineOperation({
    name: "findVulnerableSymbols",
    title: "Find candidate vulnerable symbols",
    description:
      "Heuristic. Diff a vulnerable version of an npm package against the version that fixes it and list the exported functions, classes and files whose implementation changed (formatting and comments ignored), ranked by how closely the change matches the advisory text or CWE ids if given, with each candidate checked for reachability from the project's source. A changed symbol is a candidate, not proof it was the vulnerable one. Changes nothing.",
    input: z
      .object({
        packageName: packageNameSchema.describe("Package to diff."),
        from: exactVersion.describe("The vulnerable version."),
        to: exactVersion.describe("The version that fixes it."),
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
        advisoryText: z
          .string()
          .max(20_000)
          .optional()
          .describe("Advisory summary or details; used only to rank candidates."),
        cwes: z
          .array(z.string().max(20))
          .max(20)
          .optional()
          .describe("CWE ids such as CWE-1333; used only to rank candidates."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Largest number of candidates to return (default 25)."),
        checkReachability: z
          .boolean()
          .optional()
          .describe("Check each candidate against the project's source (default true)."),
      })
      .strict(),
    annotations: READ_ONLY_NETWORK,
    response: RESPONSES.vulnerableSymbols,
    mcp: true,
    http: {
      method: "POST",
      path: "/packages/vulnerable-symbols",
      positional: ["packageName", "from", "to"],
    },
    handler: (input, context) => context.api.findVulnerableSymbolsFn(input),
  }),
  ...INCIDENT_OPERATIONS,
  ...POLICY_OPERATIONS,
  ...MAINTAINER_VEX_OPERATIONS,
  ...PROVE_OPERATIONS,
  ...RADAR_OPERATIONS,
  ...FRESHNESS_OPERATIONS,
  ...MEMORY_OPERATIONS,
  ...EVIDENCE_PACK_OPERATIONS,
];

export function getOperation(name: string): Operation | undefined {
  return OPERATIONS.find((operation) => operation.name === name);
}
