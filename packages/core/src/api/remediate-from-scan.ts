import type { RemediationReport } from "../platform/types.js";
import { parseScanInput, parseScanInputFromAudit, uniqueCveIds } from "../scanner/index.js";
import { addEvidenceStep, createEvidenceLog, finalizeEvidence, writeEvidenceLog } from "../platform/evidence.js";
import { loadPolicy } from "../platform/policy.js";
import { resolveProvider } from "../platform/config.js";
import type { ScanOptions, ScanReport } from "./contracts.js";
import { resolveConstraints, resolveCorrelationContext, resolveProvenanceContext } from "./context.js";
import { executeScanRemediations } from "./scan-execution.js";
import { buildScanOutcome } from "./scan-outcome.js";

export async function remediateFromScan(
  inputPath: string,
  options: ScanOptions = {}
): Promise<ScanReport> {
  const cwd = options.cwd ?? process.cwd();
  const policy = loadPolicy(cwd, options.policy);
  const format = options.format ?? "auto";
  const patchesDir = options.patchesDir ?? "./patches";
  const audit = options.audit ?? false;
  const workspace = options.constraints?.workspace ?? policy.constraints?.workspace;

  const findings = audit
    ? await parseScanInputFromAudit({
        cwd,
        packageManager: options.packageManager,
        format,
        workspace,
      })
    : parseScanInput(inputPath, format);
  const cveIds = uniqueCveIds(findings);
  const llmProvider = resolveProvider(options);
  const correlation = resolveCorrelationContext(options);
  const provenance = resolveProvenanceContext(options);
  const constraints = resolveConstraints(options, cwd);

  const evidence = createEvidenceLog(cwd, cveIds, {
    ...correlation,
    actor: provenance.actor,
    source: provenance.source,
    llmProvider,
    idempotencyKey: options.idempotencyKey,
  });
  addEvidenceStep(
    evidence,
    "scan.parse",
    { inputPath, format, audit },
    { findingCount: findings.length, cveCount: cveIds.length }
  );

  const execution = await executeScanRemediations({
    cveIds,
    options,
    patchesDir,
    policy,
    correlation,
    provenance,
    constraints,
    evidence,
  });
  const reports: RemediationReport[] = execution.reports;
  const errors = execution.errors;
  const patchCount = execution.patchCount;
  const patchValidationFailures = execution.patchValidationFailures;

  let llmUsageCount = 0;
  let estimatedCostUsd = 0;
  let totalLlmLatencyMs = 0;
  for (const report of reports) {
    for (const usage of report.llmUsage ?? []) {
      llmUsageCount += 1;
      estimatedCostUsd += usage.estimatedCostUsd ?? 0;
      totalLlmLatencyMs += usage.latencyMs ?? 0;
    }
  }

  const outcome = buildScanOutcome({ reports, errors });
  const { status, successCount, failedCount, strategyCounts, dependencyScopeCounts, unresolvedByReason, remediationCount } = outcome;

  evidence.summary = {
    status,
    cveCount: cveIds.length,
    remediationCount,
    successCount,
    failedCount,
    patchCount,
    patchValidationFailures: patchValidationFailures.length > 0 ? patchValidationFailures : undefined,
    strategyCounts,
    dependencyScopeCounts,
    unresolvedByReason,
    patchesDir: patchCount > 0 ? patchesDir : undefined,
    llmUsageCount: llmUsageCount > 0 ? llmUsageCount : undefined,
    estimatedCostUsd: llmUsageCount > 0 ? Number(estimatedCostUsd.toFixed(6)) : undefined,
    totalLlmLatencyMs: llmUsageCount > 0 ? totalLlmLatencyMs : undefined,
  };

  finalizeEvidence(evidence);
  const evidenceFile = options.evidence === false ? undefined : writeEvidenceLog(cwd, evidence);

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
    patchCount,
    patchValidationFailures: patchValidationFailures.length > 0 ? patchValidationFailures : undefined,
    strategyCounts,
    dependencyScopeCounts,
    unresolvedByReason,
    patchesDir: patchCount > 0 ? patchesDir : undefined,
    correlation,
    provenance,
    constraints,
    idempotencyKey: options.idempotencyKey,
    llmUsageCount: llmUsageCount > 0 ? llmUsageCount : undefined,
    estimatedCostUsd: llmUsageCount > 0 ? Number(estimatedCostUsd.toFixed(6)) : undefined,
    totalLlmLatencyMs: llmUsageCount > 0 ? totalLlmLatencyMs : undefined,
  };
}
