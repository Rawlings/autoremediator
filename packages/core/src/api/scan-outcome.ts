import type { RemediationReport } from "../platform/types.js";
import type { ScanReport } from "./contracts.js";
import {
  buildDependencyScopeCounts,
  buildDispositionCounts,
  buildSimulationSummary,
  buildStrategyCounts,
  buildUnresolvedReasonCounts,
} from "./reporting.js";

export interface ScanOutcome {
  status: ScanReport["status"];
  successCount: number;
  failedCount: number;
  strategyCounts: ReturnType<typeof buildStrategyCounts>;
  dependencyScopeCounts: ReturnType<typeof buildDependencyScopeCounts>;
  unresolvedByReason: ReturnType<typeof buildUnresolvedReasonCounts>;
  dispositionCounts: ReturnType<typeof buildDispositionCounts>;
  simulationSummary: ReturnType<typeof buildSimulationSummary>;
  remediationCount: number;
}

export function buildScanOutcome(params: {
  reports: RemediationReport[];
  errors: Array<{ cveId: string; message: string }>;
}): ScanOutcome {
  let successCount = 0;
  let failedCount = 0;
  for (const report of params.reports) {
    for (const result of report.results) {
      if (result.applied || result.dryRun) {
        successCount += 1;
      } else {
        failedCount += 1;
      }
    }
  }

  failedCount += params.errors.length;

  let status: ScanReport["status"] = "ok";
  if (failedCount > 0 && successCount > 0) {
    status = "partial";
  } else if (failedCount > 0 && successCount === 0) {
    status = "failed";
  }

  const strategyCounts = buildStrategyCounts(params.reports);
  const dependencyScopeCounts = buildDependencyScopeCounts(params.reports);
  const unresolvedByReason = buildUnresolvedReasonCounts(params.reports);
  const dispositionCounts = buildDispositionCounts(params.reports);
  const simulationSummary = buildSimulationSummary(params.reports);
  const remediationCount = params.reports.reduce((sum, report) => sum + report.results.length, 0);

  return {
    status,
    successCount,
    failedCount,
    strategyCounts,
    dependencyScopeCounts,
    unresolvedByReason,
    dispositionCounts,
    simulationSummary,
    remediationCount,
  };
}