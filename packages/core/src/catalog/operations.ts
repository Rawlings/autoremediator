import { z } from "zod";

import { stripUntrustedChangeRequestFields } from "../api/change-request/index.js";
import type {
  PortfolioTarget,
  RemediateOptions,
  ScanOptions,
  UpdateOutdatedOptions,
} from "../api/index.js";
import {
  deltaScanOptionsSchema,
  evaluatePackageOptionsSchema,
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
} from "../platform/option-schemas.js";
import { PACKAGE_VERSION } from "../version.js";
import { RESPONSES } from "./responses.js";
import { defineOperation, type Operation, type OperationContext } from "./define-operation.js";

const cveId = z.string("cveId is required (string)").min(1, "cveId is required (string)");
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
    name: "remediate",
    title: "Remediate a CVE",
    description:
      "Remediate a single CVE in a Node.js project. Looks up the CVE, scans the project inventory, and applies a version bump or generates a patch file. Returns a RemediationReport.",
    input: z.object({ cveId: cveId.describe(OPTION_DESCRIPTIONS.cveId), ...remediateOptionsSchema.shape }).strict(),
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
    input: z.object({ cveId: cveId.describe(OPTION_DESCRIPTIONS.cveId), ...planOptionShape }).strict(),
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
    input: z.object({ patchFilePath: patchFilePathSchema, ...patchArtifactQuerySchema.shape }).strict(),
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
    input: z.object({ patchFilePath: patchFilePathSchema, ...patchArtifactQuerySchema.shape }).strict(),
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
      "Convert a ScanReport or RemediationReport to a CycloneDX 1.5 VEX document. Returns a compliance-ready vulnerability exploitability exchange record binding remediation evidence to SBOM vulnerability entries.",
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
      })
      .strict(),
    annotations: READ_ONLY,
    response: RESPONSES.vexDocument,
    mcp: true,
    http: { method: "POST", path: "/vex", positional: ["report"] },
    handler: ({ report, toolVersion }, context) =>
      context.api.toVexFn(
        report as unknown as Parameters<typeof context.api.toVexFn>[0],
        toolVersion ? { toolVersion } : undefined,
      ),
  }),
  defineOperation({
    name: "submitRemediateJob",
    title: "Submit a remediation job",
    description:
      "Submit a single-CVE remediation as a background async job. Returns a JobHandle immediately with a jobId. Use pollJob to check status and retrieve the result.",
    input: z.object({ cveId: cveId.describe(OPTION_DESCRIPTIONS.cveId), ...remediateOptionsSchema.shape }).strict(),
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
      "Scan project source files using oxc-parser AST call-graph tracing to check if a package or vulnerable symbol is reachable and invoked.",
    input: z
      .object({
        packageName: packageNameSchema.describe("Target package name to trace in project source files."),
        cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
        symbol: z
          .string()
          .optional()
          .describe("Optional specific vulnerable function or export symbol to verify in call graph."),
      })
      .strict(),
    annotations: READ_ONLY,
    response: RESPONSES.reachability,
    mcp: true,
    http: { method: "POST", path: "/reachability", positional: ["packageName"] },
    handler: ({ packageName, cwd, symbol }, context) =>
      context.api.checkReachabilityFn({ packageName, cwd, symbol }),
  }),
  defineOperation({
    name: "evaluatePackage",
    title: "Evaluate a package",
    description:
      "Pre-flight security evaluator for npm packages. Queries OSV, CISA KEV, and FIRST EPSS telemetry before installation.",
    input: z
      .object({ packageName: packageNameSchema.describe("Package name to evaluate."), ...evaluatePackageOptionsSchema.shape })
      .strict(),
    annotations: READ_ONLY_NETWORK,
    response: RESPONSES.packageEvaluation,
    mcp: true,
    http: { method: "POST", path: "/packages/evaluate", positional: ["packageName"] },
    handler: ({ packageName, ...options }, context) =>
      context.api.evaluatePackageFn(packageName, options),
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
];

export function getOperation(name: string): Operation | undefined {
  return OPERATIONS.find((operation) => operation.name === name);
}
