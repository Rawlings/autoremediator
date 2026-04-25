import type {
  DependencyScope,
  DependencyScopeCounts,
  PatchStrategyCounts,
  RemediationReport,
  UnresolvedReasonCounts,
} from "../platform/types.js";
import type { CiSummary, ScanReport } from "./contracts.js";

export function buildStrategyCounts(reports: RemediationReport[]): PatchStrategyCounts | undefined {
  const counts: PatchStrategyCounts = {};

  for (const report of reports) {
    for (const result of report.results) {
      counts[result.strategy] = (counts[result.strategy] ?? 0) + 1;
    }
  }

  return Object.keys(counts).length > 0 ? counts : undefined;
}

function toDependencyScope(installedType: "direct" | "transitive"): DependencyScope {
  return installedType === "direct" ? "direct" : "transitive";
}

export function buildDependencyScopeCounts(reports: RemediationReport[]): DependencyScopeCounts | undefined {
  const counts: DependencyScopeCounts = {};

  for (const report of reports) {
    const packageScopes = new Map<string, DependencyScope>();

    for (const vulnerablePackage of report.vulnerablePackages) {
      const scope = toDependencyScope(vulnerablePackage.installed.type);
      const current = packageScopes.get(vulnerablePackage.installed.name);
      if (!current || current !== "direct") {
        packageScopes.set(vulnerablePackage.installed.name, scope);
      }
    }

    for (const result of report.results) {
      const scope = packageScopes.get(result.packageName);
      if (!scope) continue;
      counts[scope] = (counts[scope] ?? 0) + 1;
    }
  }

  return Object.keys(counts).length > 0 ? counts : undefined;
}

export function buildUnresolvedReasonCounts(reports: RemediationReport[]): UnresolvedReasonCounts | undefined {
  const counts: UnresolvedReasonCounts = {};

  for (const report of reports) {
    for (const result of report.results) {
      if (!result.unresolvedReason) continue;
      counts[result.unresolvedReason] = (counts[result.unresolvedReason] ?? 0) + 1;
    }
  }

  return Object.keys(counts).length > 0 ? counts : undefined;
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
    patchCount: report.patchCount || 0,
    patchValidationFailures: report.patchValidationFailures,
    strategyCounts: report.strategyCounts,
    dependencyScopeCounts: report.dependencyScopeCounts,
    unresolvedByReason: report.unresolvedByReason,
    patchesDir: report.patchesDir,
    correlation: report.correlation,
    provenance: report.provenance,
    constraints: report.constraints,
    idempotencyKey: report.idempotencyKey,
    llmUsageCount: report.llmUsageCount,
    estimatedCostUsd: report.estimatedCostUsd,
    totalLlmLatencyMs: report.totalLlmLatencyMs,
  };
}

export function ciExitCode(summary: CiSummary): number {
  return summary.failedCount > 0 ? 1 : 0;
}
