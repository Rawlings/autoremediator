/**
 * autoremediator public SDK
 *
 * Usage:
 *   import { remediate } from 'autoremediator';
 *   const report = await remediate('CVE-2021-23337', { cwd: '/my/project' });
 */
import { runHealAgent } from "./remediation/pipeline.js";
import type { RemediateOptions, RemediationReport } from "./platform/types.js";
import { parseScanInput, type ScanInputFormat, uniqueCveIds } from "./scanner/index.js";
import { addEvidenceStep, createEvidenceLog, finalizeEvidence, writeEvidenceLog } from "./platform/evidence.js";
import { isPackageAllowed, loadPolicy } from "./platform/policy.js";

// Internal alias so pipeline stays working
const runRemediationPipeline = runHealAgent;
export { runRemediationPipeline, runHealAgent };

export type {
  RemediateOptions,
  RemediationReport,
  CveDetails,
  AffectedPackage,
  InventoryPackage,
  VulnerablePackage,
  PatchResult,
  PatchStrategy,
  /** @deprecated Use RemediateOptions */ HealOptions,
  /** @deprecated Use RemediationReport */ HealReport,
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
}

/**
 * Main entry point for programmatic use.
 *
 * @param cveId  - CVE identifier, e.g. "CVE-2021-23337"
 * @param options - Optional configuration (cwd, dryRun, llmProvider, etc.)
 * @returns       A HealReport describing what was found and done
 */
export async function remediate(cveId: string, options: RemediateOptions = {}): Promise<RemediationReport> {
  if (!/^CVE-\d{4}-\d+$/i.test(cveId)) {
    throw new Error(
      `Invalid CVE ID: "${cveId}". Expected format: CVE-YYYY-NNNNN (e.g. CVE-2021-23337).`
    );
  }
  return runHealAgent(cveId.toUpperCase(), options);
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

  const evidence = createEvidenceLog(cwd, cveIds);
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
      addEvidenceStep(evidence, "heal.start", { cveId });
      const report = await remediate(cveId, {
        ...options,
        patchesDir,
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
      addEvidenceStep(evidence, "heal.finish", { cveId }, { results: report.results.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ cveId, message });
      addEvidenceStep(evidence, "heal.error", { cveId }, undefined, message);
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
  };
}

export function ciExitCode(summary: CiSummary): number {
  return summary.failedCount > 0 ? 1 : 0;
}

// Backward-compatible aliases (deprecated)
export { remediate as heal, remediateFromScan as healFromScanFile };
