import type {
  PortfolioReport,
  PortfolioTarget,
  PortfolioTargetResult,
  RemediateOptions,
  RemediationReport,
} from "../../platform/types.js";
import type { ScanReport } from "../contracts.js";
import { remediate } from "../remediate/index.js";
import { remediateFromScan } from "../remediate-from-scan/index.js";
import { assertValidSimulationMode } from "../reporting.js";
import { rankPortfolioTargets } from "./risk-score.js";

function toTargetStatusFromRemediation(report: RemediationReport): "ok" | "partial" | "failed" {
  const failed = report.results.some((result) => !result.applied && !result.dryRun);
  const succeeded = report.results.some((result) => result.applied || result.dryRun);
  if (!failed) return "ok";
  return succeeded ? "partial" : "failed";
}

function normalizeTargetInput(target: PortfolioTarget): { cveId?: string; inputPath?: string; audit: boolean } {
  return {
    cveId: target.cveId?.trim() || undefined,
    inputPath: target.inputPath?.trim() || undefined,
    audit: target.audit ?? false,
  };
}

function validateTarget(target: PortfolioTarget, index: number): void {
  if (!target.cwd || typeof target.cwd !== "string") {
    throw new Error(`Invalid portfolio target at index ${index}: cwd is required.`);
  }

  const { cveId, inputPath, audit } = normalizeTargetInput(target);
  const hasScanInput = Boolean(inputPath) || audit;

  if (Boolean(cveId) === hasScanInput) {
    throw new Error(
      `Invalid portfolio target at index ${index}: provide exactly one mode (cveId OR inputPath/audit).`
    );
  }
}

export async function remediatePortfolio(
  targets: PortfolioTarget[],
  options: RemediateOptions = {}
): Promise<PortfolioReport> {
  assertValidSimulationMode(options);
  const normalizedTargets = Array.isArray(targets) ? targets : [];

  if (normalizedTargets.length === 0) {
    throw new Error("Portfolio requires at least one target.");
  }

  normalizedTargets.forEach((target, index) => validateTarget(target, index));

  const executionTargets = options.campaignMode === true
    ? rankPortfolioTargets(normalizedTargets)
    : normalizedTargets.map((target) => ({ target, rank: undefined }));

  const results: PortfolioTargetResult[] = [];
  const changeRequests = [] as NonNullable<PortfolioReport["changeRequests"]>;
  let successCount = 0;
  let failedCount = 0;

  for (const executionTarget of executionTargets) {
    const target = executionTarget.target;
    const threatRank = options.campaignMode === true ? executionTarget.rank : undefined;
    const { cveId, inputPath, audit } = normalizeTargetInput(target);

    try {
      if (cveId) {
        const remediationReport = await remediate(cveId, {
          ...options,
          cwd: target.cwd,
          source: options.source,
        });

        const status = toTargetStatusFromRemediation(remediationReport);
        results.push({
          target,
          status,
          ...(threatRank !== undefined ? { threatRank } : {}),
          remediationReport,
          changeRequests: remediationReport.changeRequests,
        });

        if (remediationReport.changeRequests?.length) {
          changeRequests.push(...remediationReport.changeRequests);
        }

        if (status === "failed") {
          failedCount += 1;
        } else {
          successCount += 1;
        }
        continue;
      }

      const scanReport = await remediateFromScan(inputPath ?? "", {
        ...options,
        cwd: target.cwd,
        audit,
        format: target.format,
        source: options.source,
      });

      results.push({
        target,
        status: scanReport.status,
        ...(threatRank !== undefined ? { threatRank } : {}),
        scanReport,
        changeRequests: scanReport.changeRequests,
      });

      if (scanReport.changeRequests?.length) {
        changeRequests.push(...scanReport.changeRequests);
      }

      if (scanReport.status === "failed") {
        failedCount += 1;
      } else {
        successCount += 1;
      }
    } catch (error) {
      results.push({
        target,
        status: "failed",
        ...(threatRank !== undefined ? { threatRank } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      failedCount += 1;
    }
  }

  const overallStatus = failedCount === 0 ? "ok" : successCount > 0 ? "partial" : "failed";

  return {
    schemaVersion: "1.0",
    status: overallStatus,
    generatedAt: new Date().toISOString(),
    targets: results,
    successCount,
    failedCount,
    changeRequests: changeRequests.length > 0 ? changeRequests : undefined,
  };
}
