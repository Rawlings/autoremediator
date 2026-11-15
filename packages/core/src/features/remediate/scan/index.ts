import { getModelSpec } from "../../../infra/config.js";
import { loadPolicy } from "../../../infra/policy/policy.js";
import {
  assertChangeRequestAllowed,
  createChangeRequestsForReports,
} from "../../change-request/index.js";
import {
  addEvidenceStep,
  createEvidenceLog,
  finalizeEvidence,
  writeEvidenceLog,
} from "../../evidence/log.js";
import { parseScanInput, parseScanInputFromAudit, uniqueCveIds } from "../../scan/index.js";
import {
  resolveConstraints,
  resolveCorrelationContext,
  resolveProvenanceContext,
} from "../context.js";
import type { ScanOptions, ScanReport } from "../contracts.js";
import {
  assertValidSimulationMode,
  buildEscalationCounts,
  buildSlaBreachSummary,
} from "../reporting.js";
import { executeScanRemediations } from "../scan-execution.js";
import { buildScanOutcome } from "../scan-outcome.js";
import type { RemediationReport } from "../types.js";
import { aggregateScanLlmUsage } from "./report-metrics.js";

function countContainedResults(reports: RemediationReport[]): number {
  let containmentCount = 0;
  for (const report of reports) {
    for (const result of report.results) {
      if (
        result.unresolvedReason === "policy-blocked" &&
        result.disposition === "hold-for-approval"
      ) {
        containmentCount += 1;
      }
    }
  }
  return containmentCount;
}

export async function remediateFromScan(
  inputPath: string,
  options: ScanOptions = {},
): Promise<ScanReport> {
  assertChangeRequestAllowed(options);
  assertValidSimulationMode(options);
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
  const model = getModelSpec(options.model);
  const correlation = resolveCorrelationContext(options);
  const provenance = resolveProvenanceContext(options);
  const constraints = resolveConstraints(options, cwd);

  const evidence = createEvidenceLog(cwd, cveIds, {
    ...correlation,
    actor: provenance.actor,
    source: provenance.source,
    model,
    idempotencyKey: options.idempotencyKey,
  });
  addEvidenceStep(
    evidence,
    "scan.parse",
    { inputPath, format, audit },
    { findingCount: findings.length, cveCount: cveIds.length },
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
  const { errors, patchCount, patchValidationFailures } = execution;
  const containmentCount = countContainedResults(reports);
  const escalationCounts = buildEscalationCounts(reports.flatMap((report) => report.results));

  const llmUsageTotals = aggregateScanLlmUsage(reports);
  const outcome = buildScanOutcome({ reports, errors });
  const {
    status,
    successCount,
    failedCount,
    strategyCounts,
    dependencyScopeCounts,
    unresolvedByReason,
    dispositionCounts,
    simulationSummary,
    remediationCount,
  } = outcome;

  evidence.summary = {
    status,
    cveCount: cveIds.length,
    remediationCount,
    successCount,
    failedCount,
    patchCount,
    patchValidationFailures:
      patchValidationFailures.length > 0 ? patchValidationFailures : undefined,
    strategyCounts,
    dependencyScopeCounts,
    unresolvedByReason,
    dispositionCounts,
    escalationCounts,
    containmentCount,
    simulationSummary,
    slaBreachSummary: buildSlaBreachSummary(reports),
    patchesDir: patchCount > 0 ? patchesDir : undefined,
    llmUsageCount: llmUsageTotals.llmUsageCount > 0 ? llmUsageTotals.llmUsageCount : undefined,
    totalInputTokens: llmUsageTotals.totalInputTokens,
    totalOutputTokens: llmUsageTotals.totalOutputTokens,
    totalLlmLatencyMs: llmUsageTotals.totalLlmLatencyMs,
  };

  finalizeEvidence(evidence);
  const evidenceFile = options.evidence === false ? undefined : writeEvidenceLog(cwd, evidence);

  const changeRequests = options.changeRequest?.enabled
    ? await createChangeRequestsForReports({
        cwd,
        options: options.changeRequest,
        reports,
      })
    : undefined;

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
    patchValidationFailures:
      patchValidationFailures.length > 0 ? patchValidationFailures : undefined,
    strategyCounts,
    dependencyScopeCounts,
    unresolvedByReason,
    dispositionCounts,
    escalationCounts,
    patchesDir: patchCount > 0 ? patchesDir : undefined,
    correlation,
    provenance,
    constraints,
    idempotencyKey: options.idempotencyKey,
    llmUsageCount: llmUsageTotals.llmUsageCount > 0 ? llmUsageTotals.llmUsageCount : undefined,
    totalInputTokens: llmUsageTotals.totalInputTokens,
    totalOutputTokens: llmUsageTotals.totalOutputTokens,
    totalLlmLatencyMs: llmUsageTotals.totalLlmLatencyMs,
    changeRequests,
    simulationSummary,
    slaBreachSummary: buildSlaBreachSummary(reports),
  };
}
