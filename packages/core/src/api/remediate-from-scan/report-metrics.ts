import type { RemediationReport } from "../../platform/types.js";

export interface ScanLlmUsageTotals {
  llmUsageCount: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalLlmLatencyMs?: number;
}

export function aggregateScanLlmUsage(reports: RemediationReport[]): ScanLlmUsageTotals {
  let llmUsageCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLlmLatencyMs = 0;

  for (const report of reports) {
    for (const usage of report.llmUsage ?? []) {
      llmUsageCount += 1;
      totalInputTokens += usage.inputTokens ?? 0;
      totalOutputTokens += usage.outputTokens ?? 0;
      totalLlmLatencyMs += usage.latencyMs ?? 0;
    }
  }

  return {
    llmUsageCount,
    totalInputTokens: llmUsageCount > 0 ? totalInputTokens : undefined,
    totalOutputTokens: llmUsageCount > 0 ? totalOutputTokens : undefined,
    totalLlmLatencyMs: llmUsageCount > 0 ? totalLlmLatencyMs : undefined,
  };
}
