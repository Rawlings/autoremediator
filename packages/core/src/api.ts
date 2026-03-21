/**
 * autoremediator public SDK
 *
 * Usage:
 *   import { remediate } from 'autoremediator';
 *   const report = await remediate('CVE-2021-23337', { cwd: '/my/project' });
 */
import { runRemediationPipeline } from "./remediation/pipeline.js";
import type {
  CorrelationContext,
  ProvenanceContext,
  RemediationConstraints,
  RemediateOptions,
  RemediationReport,
} from "./platform/types.js";
import { parseScanInput, type ScanInputFormat, uniqueCveIds } from "./scanner/index.js";
import { addEvidenceStep, createEvidenceLog, finalizeEvidence, writeEvidenceLog } from "./platform/evidence.js";
import { isPackageAllowed, loadPolicy } from "./platform/policy.js";
import { readIdempotentReport, storeIdempotentReport } from "./platform/idempotency.js";

export { runRemediationPipeline } from "./remediation/pipeline.js";

export type {
  CorrelationContext,
  RemediationConstraints,
  ProvenanceContext,
  RemediateOptions,
  RemediationReport,
  CveDetails,
  AffectedPackage,
  InventoryPackage,
  VulnerablePackage,
  PatchResult,
  PatchStrategy,
} from "./platform/types.js";
export type { ScanInputFormat } from "./scanner/index.js";

export interface ScanOptions extends RemediateOptions {
  format?: ScanInputFormat;
  policyPath?: string;
  writeEvidence?: boolean;
}

export interface ScanReport {
  schemaVersion: "1.0";
  status: "ok" | "partial" | "failed";
  generatedAt: string;
  cveIds: string[];
  reports: RemediationReport[];
  successCount: number;
  failedCount: number;
  errors: Array<{ cveId: string; message: string }>;
  evidenceFile?: string;
  patchFileCount: number;
  patchValidationFailures?: Array<{
    packageName: string;
    cveId: string;
    error: string;
  }>;
  patchStorageDir?: string;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
  idempotencyKey?: string;
}

export interface CiSummary {
  schemaVersion: "1.0";
  status: "ok" | "partial" | "failed";
  generatedAt: string;
  cveCount: number;
  remediationCount: number;
  successCount: number;
  failedCount: number;
  errors: Array<{ cveId: string; message: string }>;
  evidenceFile?: string;
  patchFileCount?: number;
  patchValidationFailures?: Array<{
    packageName: string;
    cveId: string;
    error: string;
  }>;
  patchStorageDir?: string;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
  idempotencyKey?: string;
}

function buildRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveCorrelationContext(options: RemediateOptions): Required<Pick<CorrelationContext, "requestId">> & CorrelationContext {
  return {
    requestId: options.requestId ?? buildRequestId(),
    sessionId: options.sessionId,
    parentRunId: options.parentRunId,
  };
}

function resolveProvenanceContext(options: RemediateOptions): ProvenanceContext {
  return {
    actor: options.actor,
    source: options.source ?? "sdk",
  };
}

function resolveConstraints(options: RemediateOptions, cwd: string): RemediationConstraints {
  const policy = loadPolicy(cwd, options.policyPath);
  return {
    directDependenciesOnly:
      options.constraints?.directDependenciesOnly ??
      policy.constraints?.directDependenciesOnly ??
      false,
    preferVersionBump:
      options.constraints?.preferVersionBump ??
      policy.constraints?.preferVersionBump ??
      false,
  };
}

function enforceConstraints(
  report: RemediationReport,
  constraints: RemediationConstraints
): RemediationReport {
  const indirectPackages = new Set(
    report.vulnerablePackages
      .filter((vp) => vp.installed.type === "indirect")
      .map((vp) => vp.installed.name)
  );

  const nextResults = report.results.map((result) => {
    if (constraints.directDependenciesOnly && indirectPackages.has(result.packageName)) {
      return {
        ...result,
        strategy: "none" as const,
        applied: false,
        message: `Constraint blocked remediation for indirect dependency \"${result.packageName}\".`,
      };
    }

    if (constraints.preferVersionBump && result.strategy === "patch-file") {
      return {
        ...result,
        strategy: "none" as const,
        applied: false,
        message: `Constraint prefers version-bump and rejected patch-file remediation for \"${result.packageName}\".`,
      };
    }

    return result;
  });

  return {
    ...report,
    results: nextResults,
    constraints,
  };
}

/**
 * Main entry point for programmatic use.
 *
 * @param cveId  - CVE identifier, e.g. "CVE-2021-23337"
 * @param options - Optional configuration (cwd, dryRun, llmProvider, etc.)
 * @returns       A RemediationReport describing what was found and done
 */
export async function remediate(cveId: string, options: RemediateOptions = {}): Promise<RemediationReport> {
  if (!/^CVE-\d{4}-\d+$/i.test(cveId)) {
    throw new Error(
      `Invalid CVE ID: "${cveId}". Expected format: CVE-YYYY-NNNNN (e.g. CVE-2021-23337).`
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const constraints = resolveConstraints(options, cwd);
  const provenance = resolveProvenanceContext(options);
  const correlation = resolveCorrelationContext(options);

  if (options.resume && options.idempotencyKey) {
    const cached = readIdempotentReport(cwd, options.idempotencyKey, cveId.toUpperCase());
    if (cached) {
      return {
        ...cached,
        summary: `${cached.summary} (resumed from idempotency cache)`,
        correlation,
        provenance,
        constraints,
        resumedFromCache: true,
      };
    }
  }

  const report = await runRemediationPipeline(cveId.toUpperCase(), {
    ...options,
    ...correlation,
    constraints,
  });
  const constrainedReport = enforceConstraints(report, constraints);
  const finalReport = {
    ...constrainedReport,
    correlation,
    provenance,
    constraints,
    resumedFromCache: false,
  };

  if (options.idempotencyKey && !options.dryRun && !options.preview) {
    storeIdempotentReport(cwd, options.idempotencyKey, cveId.toUpperCase(), finalReport);
  }

  return {
    ...finalReport,
  };
}

/**
 * Non-mutating preview entrypoint for planning and orchestration.
 */
export async function planRemediation(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  return remediate(cveId, {
    ...options,
    preview: true,
    dryRun: true,
  });
}

/**
 * Scanner-first entrypoint: parse a scanner output file (npm audit JSON or SARIF),
 * extract CVEs, and run remediations one-by-one.
 */
export async function remediateFromScan(
  inputPath: string,
  options: ScanOptions = {}
): Promise<ScanReport> {
  const cwd = options.cwd ?? process.cwd();
  const format = options.format ?? "auto";
  const patchesDir = options.patchesDir ?? "./patches";

  const findings = parseScanInput(inputPath, format);
  const cveIds = uniqueCveIds(findings);
  const policy = loadPolicy(cwd, options.policyPath);
  const correlation = resolveCorrelationContext(options);
  const provenance = resolveProvenanceContext(options);
  const constraints = resolveConstraints(options, cwd);

  const evidence = createEvidenceLog(cwd, cveIds, {
    ...correlation,
    actor: provenance.actor,
    source: provenance.source,
    idempotencyKey: options.idempotencyKey,
  });
  addEvidenceStep(evidence, "scan.parse", { inputPath, format }, { findingCount: findings.length, cveCount: cveIds.length });

  const reports: RemediationReport[] = [];
  const errors: Array<{ cveId: string; message: string }> = [];
  const patchValidationFailures: Array<{
    packageName: string;
    cveId: string;
    error: string;
  }> = [];
  let patchFileCount = 0;

  for (const cveId of cveIds) {
    try {
      addEvidenceStep(evidence, "remediate.start", { cveId });
      const report = await remediate(cveId, {
        ...options,
        patchesDir,
        ...correlation,
        actor: provenance.actor,
        source: provenance.source,
        constraints,
      });

      // Keep a defensive filter in case upstream tools return unexpected packages.
      report.results = report.results.filter((r) => isPackageAllowed(policy, r.packageName));

      // Count patches and collect validation failures
      for (const result of report.results) {
        if (result.strategy === "patch-file") {
          patchFileCount += 1;
        }
        if (result.validation?.passed === false && result.validation?.error) {
          patchValidationFailures.push({
            packageName: result.packageName,
            cveId,
            error: result.validation.error,
          });
        }
      }

      reports.push(report);
      addEvidenceStep(evidence, "remediate.finish", { cveId }, { results: report.results.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ cveId, message });
      addEvidenceStep(evidence, "remediate.error", { cveId }, undefined, message);
    }
  }

  let successCount = 0;
  let failedCount = 0;
  for (const report of reports) {
    for (const result of report.results) {
      if (result.applied || result.dryRun) {
        successCount += 1;
      } else {
        failedCount += 1;
      }
    }
  }

  failedCount += errors.length;

  let status: ScanReport["status"] = "ok";
  if (failedCount > 0 && successCount > 0) {
    status = "partial";
  } else if (failedCount > 0 && successCount === 0) {
    status = "failed";
  }

  finalizeEvidence(evidence);
  const evidenceFile = options.writeEvidence === false ? undefined : writeEvidenceLog(cwd, evidence);

  return {
    schemaVersion: "1.0",
    status,
    generatedAt: new Date().toISOString(),
    cveIds,
    reports,
    successCount,
    failedCount,
    errors,
    evidenceFile,
    patchFileCount,
    patchValidationFailures: patchValidationFailures.length > 0 ? patchValidationFailures : undefined,
    patchStorageDir: patchFileCount > 0 ? patchesDir : undefined,
    correlation,
    provenance,
    constraints,
    idempotencyKey: options.idempotencyKey,
  };
}

export function toCiSummary(report: ScanReport): CiSummary {
  let remediationCount = 0;
  for (const cveReport of report.reports) {
    remediationCount += cveReport.results.length;
  }

  return {
    schemaVersion: report.schemaVersion,
    status: report.status,
    generatedAt: report.generatedAt,
    cveCount: report.cveIds.length,
    remediationCount,
    successCount: report.successCount,
    failedCount: report.failedCount,
    errors: report.errors,
    evidenceFile: report.evidenceFile,
    patchFileCount: report.patchFileCount || 0,
    patchValidationFailures: report.patchValidationFailures,
    patchStorageDir: report.patchStorageDir,
    correlation: report.correlation,
    provenance: report.provenance,
    constraints: report.constraints,
    idempotencyKey: report.idempotencyKey,
  };
}

export function ciExitCode(summary: CiSummary): number {
  return summary.failedCount > 0 ? 1 : 0;
}
