import type { RemediationReport } from "../../platform/types.js";

export interface ScanLlmUsageTotals {
  llmUsageCount: number;
  estimatedCostUsd?: number;
  totalLlmLatencyMs?: number;
}

export function aggregateScanLlmUsage(reports: RemediationReport[]): ScanLlmUsageTotals {
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

  return {
    llmUsageCount,
    estimatedCostUsd: llmUsageCount > 0 ? Number(estimatedCostUsd.toFixed(6)) : undefined,
    totalLlmLatencyMs: llmUsageCount > 0 ? totalLlmLatencyMs : undefined,
  };
}