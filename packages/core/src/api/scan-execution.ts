import type { RemediationReport } from "../platform/types.js";
import type { ProvenanceContext } from "../platform/types.js";
import { addEvidenceStep } from "../platform/evidence.js";
import type { EvidenceLog } from "../platform/evidence.js";
import { isPackageAllowed } from "../platform/policy.js";
import type { AutoremediatorPolicy } from "../platform/policy.js";
import type { ScanOptions } from "./contracts.js";
import { remediate } from "./remediate/index.js";

export interface ScanExecutionResult {
  reports: RemediationReport[];
  errors: Array<{ cveId: string; message: string }>;
  patchCount: number;
  patchValidationFailures: Array<{
    packageName: string;
    cveId: string;
    error: string;
  }>;
}

export async function executeScanRemediations(params: {
  cveIds: string[];
  options: ScanOptions;
  patchesDir: string;
  policy: AutoremediatorPolicy;
  correlation: { requestId: string; sessionId?: string; parentRunId?: string };
  provenance: ProvenanceContext;
  constraints: { directDependenciesOnly?: boolean; preferVersionBump?: boolean };
  evidence: EvidenceLog;
}): Promise<ScanExecutionResult> {
  const reports: RemediationReport[] = [];
  const errors: Array<{ cveId: string; message: string }> = [];
  const patchValidationFailures: Array<{
    packageName: string;
    cveId: string;
    error: string;
  }> = [];
  let patchCount = 0;

  for (const cveId of params.cveIds) {
    try {
      addEvidenceStep(params.evidence, "remediate.start", { cveId });
      const report = await remediate(cveId, {
        ...params.options,
        patchesDir: params.patchesDir,
        evidence: false,
        ...params.correlation,
        actor: params.provenance.actor,
        source: params.provenance.source,
        constraints: params.constraints,
      });

      report.results = report.results.filter((result) => isPackageAllowed(params.policy, result.packageName));

      for (const result of report.results) {
        if (result.strategy === "patch-file") {
          patchCount += 1;
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
      addEvidenceStep(params.evidence, "remediate.finish", { cveId }, { results: report.results.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ cveId, message });
      addEvidenceStep(params.evidence, "remediate.error", { cveId }, undefined, message);
    }
  }

  return {
    reports,
    errors,
    patchCount,
    patchValidationFailures,
  };
}