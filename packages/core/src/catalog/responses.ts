import { createScanReportSchemaProperties } from "../api/options-schema.js";

/**
 * Loose JSON Schemas for what each operation returns, as the OpenAPI document advertises them.
 * They describe the stable top-level fields only; the TypeScript report types remain the contract.
 */
export interface ResponseSpec {
  description: string;
  schema: Record<string, unknown>;
}

const object = (properties: Record<string, unknown> = {}) => ({ type: "object", properties });
const jobStatus = { type: "string", enum: ["pending", "running", "done", "failed"] };

export const ERROR_RESPONSE_SCHEMA = object({ error: { type: "string" } });

export const RESPONSES = {
  remediationReport: {
    description: "RemediationReport",
    schema: object({
      cveId: { type: "string" },
      cveDetails: { type: ["object", "null"] },
      vulnerablePackages: { type: "array", items: { type: "object" } },
      results: { type: "array", items: { type: "object" } },
      summary: { type: "string" },
      evidenceFile: { type: "string" },
      llmUsage: { type: "array", items: { type: "object" } },
      correlation: { type: "object" },
      provenance: { type: "object" },
      constraints: { type: "object" },
      resumedFromCache: { type: "boolean" },
      simulationSummary: { type: "object" },
    }),
  },
  scanReport: { description: "ScanReport", schema: object(createScanReportSchemaProperties()) },
  portfolioReport: { description: "PortfolioReport", schema: { type: "object" } },
  updateOutdatedReport: {
    description: "UpdateOutdatedReport",
    schema: object({
      schemaVersion: { type: "string" },
      status: { type: "string", enum: ["ok", "partial", "failed"] },
      generatedAt: { type: "string" },
      outdatedPackages: { type: "array", items: { type: "object" } },
      successCount: { type: "number" },
      failedCount: { type: "number" },
      skippedCount: { type: "number" },
      errors: { type: "array", items: { type: "object" } },
      evidenceFile: { type: "string" },
      patchCount: { type: "number" },
      constraints: { type: "object" },
      correlation: { type: "object" },
      provenance: { type: "object" },
    }),
  },
  patchSummaries: {
    description: "Patch artifact summaries",
    schema: { type: "array", items: { type: "object" } },
  },
  patchInspection: { description: "Patch artifact inspection", schema: { type: "object" } },
  patchValidation: { description: "Patch artifact validation report", schema: { type: "object" } },
  patchReconciliation: { description: "Patch reconciliation report", schema: { type: "object" } },
  vexDocument: {
    description: "CycloneDX 1.5 VEX document",
    schema: object({
      bomFormat: { type: "string" },
      specVersion: { type: "string" },
      version: { type: "number" },
      serialNumber: { type: "string" },
      metadata: { type: "object" },
      vulnerabilities: { type: "array", items: { type: "object" } },
    }),
  },
  jobHandle: {
    description: "JobHandle",
    schema: object({
      jobId: { type: "string" },
      status: jobStatus,
      submittedAt: { type: "string", format: "date-time" },
    }),
  },
  job: {
    description: "AsyncRemediationJob",
    schema: object({
      jobId: { type: "string" },
      status: jobStatus,
      submittedAt: { type: "string", format: "date-time" },
      completedAt: { type: "string", format: "date-time" },
      result: { type: "object" },
      error: { type: "string" },
    }),
  },
  reachability: { description: "ReachabilityAssessment", schema: { type: "object" } },
  packageEvaluation: { description: "PackageEvaluationReport", schema: { type: "object" } },
  deltaScan: { description: "DeltaScanReport", schema: { type: "object" } },
  runReport: { description: "RunReport", schema: object({
    runId: { type: "string" },
    planId: { type: "string" },
    status: { type: "string" },
    cwd: { type: "string" },
    items: { type: "array", items: { type: "object" } },
    pending: { type: "array", items: { type: "string" } },
    skipped: { type: "array", items: { type: "object" } },
    message: { type: "string" },
  }) },
  runDetails: { description: "RunDetails", schema: object({
    run: { type: "object" },
    plan: { type: "object" },
    items: { type: "array", items: { type: "object" } },
    ledger: { type: "object" },
  }) },
  runList: { description: "Run records, newest first", schema: { type: "array", items: { type: "object" } } },
  rollbackReport: { description: "RollbackReport", schema: object({
    runId: { type: "string" },
    status: { type: "string" },
    restoredFiles: { type: "number" },
    matchesBase: { type: "boolean" },
    message: { type: "string" },
  }) },
  verification: {
    description: "VerificationResult",
    schema: object({
      runId: { type: "string" },
      passed: { type: "boolean" },
      failedCheck: { type: "string" },
      checks: { type: "array", items: { type: "object" } },
      changedFiles: { type: "array", items: { type: "string" } },
      durationMs: { type: "number" },
    }),
  },
  attemptView: {
    description: "AttemptView",
    schema: object({
      runId: { type: "string" },
      attemptId: { type: "string" },
      itemId: { type: "string" },
      status: { type: "string" },
      worktreePath: { type: "string" },
      verification: { type: "object" },
      failure: { type: "object" },
      changedFiles: { type: "array", items: { type: "string" } },
      finalized: { type: "boolean" },
      recipes: { type: "array", items: { type: "object" } },
      recipe: { type: "object" },
      message: { type: "string" },
    }),
  },
  recipeListing: {
    description: "RecipeListing",
    schema: object({
      recipes: { type: "array", items: { type: "object" } },
      problems: { type: "array", items: { type: "object" } },
    }),
  },
  guardReport: {
    description: "GuardReport",
    schema: object({
      schemaVersion: { type: "string" },
      spec: { type: "string" },
      packageName: { type: "string" },
      resolvedVersion: { type: "string" },
      verdict: { type: "string", enum: ["allow", "warn", "block"] },
      findings: { type: "array", items: { type: "object" } },
      alternative: { type: "object" },
      generatedAt: { type: "string" },
    }),
  },
  init: {
    description: "InitResult",
    schema: object({
      cwd: { type: "string" },
      facts: { type: "object" },
      hosts: { type: "array", items: { type: "string" } },
      changes: { type: "array", items: { type: "object" } },
      drift: { type: "boolean" },
      applied: { type: "boolean" },
      conflicts: { type: "array", items: { type: "string" } },
    }),
  },
  installHooks: {
    description: "HooksResult",
    schema: object({
      cwd: { type: "string" },
      root: { type: "string" },
      manager: { type: "string", enum: ["husky", "lefthook", "pre-commit", "git"] },
      managerReason: { type: "string" },
      action: { type: "string", enum: ["install", "uninstall"] },
      hooks: { type: "array", items: { type: "object" } },
      changes: { type: "array", items: { type: "object" } },
      drift: { type: "boolean" },
      applied: { type: "boolean" },
      conflicts: { type: "array", items: { type: "string" } },
      nextSteps: { type: "array", items: { type: "string" } },
    }),
  },
  bisectReport: {
    description: "BisectReport",
    schema: object({
      schemaVersion: { type: "string" },
      status: {
        type: "string",
        enum: ["culprit", "culprit-set", "not-reproducible", "not-attributable", "no-changes", "incomplete"],
      },
      summary: { type: "string" },
      good: { type: "object" },
      bad: { type: "object" },
      packageManager: { type: "string" },
      lockfile: { type: "string" },
      command: { type: "string" },
      updates: { type: "array", items: { type: "object" } },
      skipped: { type: "array", items: { type: "object" } },
      culprits: { type: "array", items: { type: "object" } },
      holdingBackFixes: { type: "boolean" },
      steps: { type: "array", items: { type: "object" } },
      stepsUsed: { type: "number" },
      maxSteps: { type: "number" },
      stopped: { type: "string", enum: ["max-steps", "interrupted"] },
      remedy: { type: "object" },
      warnings: { type: "array", items: { type: "string" } },
      startedAt: { type: "string" },
      durationMs: { type: "number" },
    }),
  },
  health: { description: "Server is healthy", schema: object({ status: { type: "string" } }) },
} as const satisfies Record<string, ResponseSpec>;
