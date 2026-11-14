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
  health: { description: "Server is healthy", schema: object({ status: { type: "string" } }) },
} as const satisfies Record<string, ResponseSpec>;
