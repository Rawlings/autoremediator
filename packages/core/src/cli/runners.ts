import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import {
  applyPlan,
  checkReachability,
  ciExitCode,
  EXIT_CODES,
  evaluatePackage,
  getRun,
  init,
  installHooks,
  HOOK_MANAGERS,
  HOOK_NAMES,
  type HookManager,
  type HookName,
  type HooksResult,
  guardPackages,
  guardGitDiff,
  guardExitCode,
  runHostHook,
  type HookHost,
  type GuardReport,
  AGENT_HOSTS,
  type AgentHost,
  type InitResult,
  inspectPatchArtifact,
  listPatchArtifacts,
  listRuns,
  planRemediation,
  remediatePortfolio,
  remediate,
  remediateFromScan,
  resumeRun,
  rollbackRun,
  scanDelta,
  buildSlaBreachSummary,
  buildStrategyCounts,
  buildDependencyScopeCounts,
  type RemediateOptions,
  type CheckName,
  type RunStatus,
  type ScanReport,
  toCiSummary,
  toCycloneDxVex,
  toSarifOutput,
  updateOutdated,
  validatePatchArtifact,
  verifyRun,
  reconcilePatchArtifacts,
} from "../api/index.js";
import type { ChangeRequestProvider } from "../platform/types.js";
import { PACKAGE_VERSION } from "../version.js";
import { formatAutonomyLine } from "./autonomy.js";
import { formatCountMap, logJson } from "./output.js";
import { runInteractiveTriage } from "./triage.js";
import type { CommandOptions, OutputFormat } from "./types.js";

export { runInteractiveTriage };

function assertPatchOutputFormat(format: string): void {
  if (format !== "text" && format !== "json") {
    throw new Error('Patch commands support --output-format "text" or "json".');
  }
}

function resolveChangeRequestOptions(opts: CommandOptions):
  | {
      enabled?: boolean;
      provider: ChangeRequestProvider;
      grouping?: "all" | "per-cve" | "per-package";
      repository?: string;
      baseBranch?: string;
      branchPrefix?: string;
      titlePrefix?: string;
    }
  | undefined {
  if (!opts.createChangeRequest) {
    return undefined;
  }

  return {
    enabled: true,
    provider: opts.changeRequestProvider ?? "github",
    grouping: opts.changeRequestGrouping,
    repository: opts.changeRequestRepository,
    baseBranch: opts.changeRequestBaseBranch,
    branchPrefix: opts.changeRequestBranchPrefix,
    titlePrefix: opts.changeRequestTitlePrefix,
  };
}

function resolveDispositionPolicy(
  opts: CommandOptions,
):
  | { minConfidenceForAutoApply?: number; holdForTransitive?: boolean; escalateOnKev?: boolean }
  | undefined {
  const hasAny =
    opts.minConfidenceForAutoApply != null ||
    opts.holdForTransitive === true ||
    opts.escalateOnKev === true;
  if (!hasAny) return undefined;
  const policy: {
    minConfidenceForAutoApply?: number;
    holdForTransitive?: boolean;
    escalateOnKev?: boolean;
  } = {};
  if (typeof opts.minConfidenceForAutoApply === "number")
    policy.minConfidenceForAutoApply = opts.minConfidenceForAutoApply;
  if (opts.holdForTransitive === true) policy.holdForTransitive = true;
  if (opts.escalateOnKev === true) policy.escalateOnKev = true;
  return policy;
}

/**
 * Every SDK option the shared CLI flags can set, built in one place. Each command used to spell this
 * out itself, and the copies drifted: `portfolio` and `update-outdated` accepted flags such as
 * `--proof-of-fix` and `--offline` and silently dropped them.
 */
export function toRemediateOptions(opts: CommandOptions): RemediateOptions {
  return {
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    dryRun: opts.dryRun,
    preview: opts.preview,
    simulationMode: opts.simulationMode,
    runTests: opts.runTests,
    typecheck: opts.typecheck,
    patchesDir: opts.patchesDir,
    policy: opts.policy,
    evidence: opts.evidence,
    model: opts.model,
    patchConfidenceThresholds: {
      low: typeof opts.patchConfidenceLow === "number" ? opts.patchConfidenceLow : undefined,
      medium:
        typeof opts.patchConfidenceMedium === "number" ? opts.patchConfidenceMedium : undefined,
      high: typeof opts.patchConfidenceHigh === "number" ? opts.patchConfidenceHigh : undefined,
    },
    requestId: opts.requestId,
    sessionId: opts.sessionId,
    parentRunId: opts.parentRunId,
    idempotencyKey: opts.idempotencyKey,
    resume: opts.resume,
    actor: opts.actor,
    source: opts.source ?? "cli",
    constraints: {
      directDependenciesOnly: opts.directDependenciesOnly,
      preferVersionBump: opts.preferVersionBump,
      installMode: opts.installMode,
      installPreferOffline: opts.installPreferOffline,
      enforceFrozenLockfile: opts.enforceFrozenLockfile,
      workspace: opts.workspace,
    },
    exploitSignalOverride:
      opts.kevMandatory || opts.epssThreshold != null
        ? {
            kev: opts.kevMandatory ? { mandatory: true } : undefined,
            epss:
              opts.epssThreshold != null
                ? { mandatory: true, threshold: opts.epssThreshold }
                : undefined,
          }
        : undefined,
    suppressionsFile: opts.suppressionsFile,
    slaCheck: opts.slaCheck,
    skipUnreachable: opts.skipUnreachable,
    containmentMode: opts.containmentMode,
    campaignMode: opts.campaignMode,
    changeRequest: resolveChangeRequestOptions(opts),
    dispositionPolicy: resolveDispositionPolicy(opts),
    offlineIntelligence: opts.offline,
    intelligenceSnapshotPath: opts.intelligenceSnapshot,
    proofOfFix: opts.proofOfFix,
    requireProofOfFix: opts.requireProofOfFix,
    reproductionTest: opts.reproductionTest,
    breakingChangeRefactor: opts.breakingChangeRefactor,
  };
}

function asSingleCveScanReport(report: Awaited<ReturnType<typeof remediate>>): ScanReport {
  return {
    schemaVersion: "1.0",
    status: report.results.some((result) => !result.applied && !result.dryRun)
      ? report.results.some((result) => result.applied || result.dryRun)
        ? "partial"
        : "failed"
      : "ok",
    generatedAt: new Date().toISOString(),
    cveIds: [report.cveId],
    reports: [report],
    successCount: report.results.filter((result) => result.applied || result.dryRun).length,
    failedCount: report.results.filter((result) => !result.applied && !result.dryRun).length,
    errors: [],
    evidenceFile: report.evidenceFile,
    patchCount: report.results.filter((result) => result.strategy === "patch-file").length,
    strategyCounts: buildStrategyCounts([report]),
    dependencyScopeCounts: buildDependencyScopeCounts([report]),
    slaBreachSummary: buildSlaBreachSummary([report]),
    correlation: report.correlation,
    provenance: report.provenance,
    constraints: report.constraints,
  };
}

export async function runSingleCve(cveId: string, opts: CommandOptions): Promise<void> {
  const report = await remediate(cveId, toRemediateOptions(opts));

  const reportAsScan = asSingleCveScanReport(report);

  if (opts.outputFormat === "sarif") {
    logJson(toSarifOutput(reportAsScan));
    if (opts.ci) {
      process.exitCode = ciExitCode(toCiSummary(reportAsScan));
    }
    return;
  }

  if (opts.outputFormat === "cyclonedx-vex") {
    logJson(toCycloneDxVex(reportAsScan, { toolVersion: PACKAGE_VERSION }));
    if (opts.ci) {
      process.exitCode = ciExitCode(toCiSummary(reportAsScan));
    }
    return;
  }

  if (opts.outputFormat === "json") {
    logJson(report);
    if (opts.ci) {
      process.exitCode = ciExitCode(toCiSummary(reportAsScan));
    }
    return;
  }

  process.stdout.write(`${report.summary}\n`);
  if (report.autonomy) process.stdout.write(`${formatAutonomyLine(report.autonomy)}\n`);
  process.stdout.write(`Results: ${report.results.length}\n`);
  if (
    reportAsScan.dependencyScopeCounts?.transitive != null &&
    reportAsScan.dependencyScopeCounts.transitive > 0
  ) {
    process.stdout.write(
      `  Transitive remediations: ${reportAsScan.dependencyScopeCounts.transitive} (fixed without requiring upstream patch)\n`,
    );
  }
  const singlePatchFileCount = reportAsScan.strategyCounts?.["patch-file"] ?? 0;
  if (singlePatchFileCount > 0) {
    const singlePatchResults = report.results.filter((r) => r.strategy === "patch-file");
    const singleConfidenceValues = singlePatchResults
      .map((r) => r.confidence)
      .filter((c): c is number => c != null);
    const singleAvgConfidence =
      singleConfidenceValues.length > 0
        ? singleConfidenceValues.reduce((sum, c) => sum + c, 0) / singleConfidenceValues.length
        : undefined;
    process.stdout.write(`Patch-generated (no upstream fix): ${singlePatchFileCount}\n`);
    if (singleAvgConfidence != null) {
      process.stdout.write(`  Avg patch confidence: ${singleAvgConfidence.toFixed(2)}\n`);
    }
    const singleUniqueRanges = [
      ...new Set(singlePatchResults.map((r) => r.vulnerableRange).filter(Boolean)),
    ];
    for (const range of singleUniqueRanges) {
      process.stdout.write(`  Vulnerable range: ${range}\n`);
    }
  }
  if (reportAsScan.slaBreachSummary != null && reportAsScan.slaBreachSummary.breachCount > 0) {
    process.stdout.write(
      `SLA breaches: ${reportAsScan.slaBreachSummary.breachCount} CVE(s) overdue\n`,
    );
    for (const breach of reportAsScan.slaBreachSummary.breaches) {
      process.stdout.write(
        `  ${breach.cveId}: ${breach.severity}, ${breach.hoursOverdue}h overdue → ${breach.recommendedAction}\n`,
      );
    }
  }
  if (report.evidenceFile) {
    process.stdout.write(`Evidence: ${report.evidenceFile}\n`);
  }
  if (opts.ci) {
    process.exitCode = ciExitCode(toCiSummary(reportAsScan));
  }
}

export async function runScanInput(inputPath: string, opts: CommandOptions): Promise<void> {
  if (opts.interactive) {
    await runInteractiveTriage(inputPath, opts);
    return;
  }
  const report = await remediateFromScan(inputPath, {
    ...toRemediateOptions(opts),
    format: opts.format,
    audit: opts.audit,
  });

  if (opts.summaryFile) {
    const summary = toCiSummary(report);
    writeFileSync(opts.summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
  }

  if (opts.outputFormat === "sarif") {
    logJson(toSarifOutput(report));
    if (opts.ci) {
      process.exitCode = ciExitCode(toCiSummary(report));
    }
    return;
  }

  if (opts.outputFormat === "cyclonedx-vex") {
    logJson(toCycloneDxVex(report, { toolVersion: PACKAGE_VERSION }));
    if (opts.ci) {
      process.exitCode = ciExitCode(toCiSummary(report));
    }
    return;
  }

  if (opts.outputFormat === "json") {
    logJson(report);
    if (opts.ci) {
      process.exitCode = ciExitCode(toCiSummary(report));
    }
    return;
  }

  process.stdout.write(`CVEs found: ${report.cveIds.length}\n`);
  process.stdout.write(`Remediation reports: ${report.reports.length}\n`);
  process.stdout.write(`Successful remediations: ${report.successCount}\n`);
  process.stdout.write(`Failed remediations: ${report.failedCount}\n`);
  const strategyCounts = formatCountMap(report.strategyCounts);
  if (strategyCounts) {
    process.stdout.write(`Strategy counts: ${strategyCounts}\n`);
  }
  const dependencyScopeCounts = formatCountMap(report.dependencyScopeCounts);
  if (dependencyScopeCounts) {
    process.stdout.write(`Dependency scope counts: ${dependencyScopeCounts}\n`);
  }
  if (
    report.dependencyScopeCounts?.transitive != null &&
    report.dependencyScopeCounts.transitive > 0
  ) {
    process.stdout.write(
      `  Transitive remediations: ${report.dependencyScopeCounts.transitive} (fixed without requiring upstream patch)\n`,
    );
  }
  const patchFileCount = report.strategyCounts?.["patch-file"] ?? 0;
  if (patchFileCount > 0) {
    const patchResults = report.reports
      .flatMap((r) => r.results)
      .filter((r) => r.strategy === "patch-file");
    const confidenceValues = patchResults
      .map((r) => r.confidence)
      .filter((c): c is number => c != null);
    const avgConfidence =
      confidenceValues.length > 0
        ? confidenceValues.reduce((sum, c) => sum + c, 0) / confidenceValues.length
        : undefined;
    process.stdout.write(`Patch-generated (no upstream fix): ${patchFileCount}\n`);
    if (avgConfidence != null) {
      process.stdout.write(`  Avg patch confidence: ${avgConfidence.toFixed(2)}\n`);
    }
    const uniqueRanges = [...new Set(patchResults.map((r) => r.vulnerableRange).filter(Boolean))];
    for (const range of uniqueRanges) {
      process.stdout.write(`  Vulnerable range: ${range}\n`);
    }
  }
  if (report.slaBreachSummary != null && report.slaBreachSummary.breachCount > 0) {
    process.stdout.write(`SLA breaches: ${report.slaBreachSummary.breachCount} CVE(s) overdue\n`);
    for (const breach of report.slaBreachSummary.breaches) {
      process.stdout.write(
        `  ${breach.cveId}: ${breach.severity}, ${breach.hoursOverdue}h overdue → ${breach.recommendedAction}\n`,
      );
    }
  }
  const unresolvedByReason = formatCountMap(report.unresolvedByReason);
  if (unresolvedByReason) {
    process.stdout.write(`Unresolved reasons: ${unresolvedByReason}\n`);
  }
  if (report.evidenceFile) {
    process.stdout.write(`Evidence: ${report.evidenceFile}\n`);
  }

  if (report.errors.length > 0) {
    for (const error of report.errors) {
      process.stdout.write(`Error ${error.cveId}: ${error.message}\n`);
    }
  }

  if (opts.ci) {
    process.exitCode = ciExitCode(toCiSummary(report));
  }
}

export async function runListPatches(
  opts: Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">,
): Promise<void> {
  assertPatchOutputFormat(opts.outputFormat);

  const patches = await listPatchArtifacts({
    cwd: opts.cwd,
    patchesDir: opts.patchesDir,
  });

  if (opts.outputFormat === "json") {
    logJson(patches);
    return;
  }

  process.stdout.write(`Patch artifacts: ${patches.length}\n`);
  for (const patch of patches) {
    process.stdout.write(`- ${patch.patchFileName}`);
    if (patch.packageName && patch.vulnerableVersion) {
      process.stdout.write(` (${patch.packageName}@${patch.vulnerableVersion})`);
    }
    if (patch.confidence !== undefined) {
      process.stdout.write(` confidence=${patch.confidence.toFixed(2)}`);
    }
    if (patch.riskLevel) {
      process.stdout.write(` risk=${patch.riskLevel}`);
    }
    process.stdout.write(`\n`);
  }
}

export async function runInspectPatch(
  patchPath: string,
  opts: Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">,
): Promise<void> {
  assertPatchOutputFormat(opts.outputFormat);

  const inspection = await inspectPatchArtifact(patchPath, {
    cwd: opts.cwd,
    patchesDir: opts.patchesDir,
  });

  if (opts.outputFormat === "json") {
    logJson(inspection);
    return;
  }

  process.stdout.write(`Patch: ${inspection.patchFilePath}\n`);
  process.stdout.write(`Exists: ${inspection.exists}\n`);
  process.stdout.write(`Diff valid: ${inspection.diffValid}\n`);
  if (inspection.packageName && inspection.vulnerableVersion) {
    process.stdout.write(`Target: ${inspection.packageName}@${inspection.vulnerableVersion}\n`);
  }
  if (inspection.manifestFilePath) {
    process.stdout.write(`Manifest: ${inspection.manifestFilePath}\n`);
  }
  if (inspection.files?.length) {
    process.stdout.write(`Files: ${inspection.files.join(", ")}\n`);
  }
  if (inspection.formatError) {
    process.stdout.write(`Format error: ${inspection.formatError}\n`);
  }
}

export async function runValidatePatch(
  patchPath: string,
  opts: Pick<CommandOptions, "cwd" | "patchesDir" | "packageManager" | "outputFormat">,
): Promise<void> {
  assertPatchOutputFormat(opts.outputFormat);

  const report = await validatePatchArtifact(patchPath, {
    cwd: opts.cwd,
    patchesDir: opts.patchesDir,
    packageManager: opts.packageManager,
  });

  if (opts.outputFormat === "json") {
    logJson(report);
    return;
  }

  process.stdout.write(`Patch: ${report.patchFilePath}\n`);
  process.stdout.write(`Exists: ${report.exists}\n`);
  process.stdout.write(`Manifest found: ${report.manifestFound}\n`);
  process.stdout.write(`Diff valid: ${report.diffValid}\n`);
  process.stdout.write(`Drift detected: ${report.driftDetected}\n`);
  if (report.packageName && report.vulnerableVersion) {
    process.stdout.write(`Target: ${report.packageName}@${report.vulnerableVersion}\n`);
  }
  if (report.installedVersion) {
    process.stdout.write(`Installed version: ${report.installedVersion}\n`);
  }
  for (const phase of report.validationPhases) {
    process.stdout.write(`Phase ${phase.phase}: ${phase.passed ? "ok" : "failed"}`);
    if (phase.error) {
      process.stdout.write(` (${phase.error})`);
    }
    process.stdout.write(`\n`);
  }
}

export async function runUpdateOutdated(opts: CommandOptions): Promise<void> {
  const report = await updateOutdated({
    ...toRemediateOptions(opts),
    includeTransitive: opts.includeTransitive,
  });

  if (opts.outputFormat === "json") {
    logJson(report);
    return;
  }

  process.stdout.write(`Outdated packages found: ${report.outdatedPackages.length}\n`);
  process.stdout.write(`Successful updates: ${report.successCount}\n`);
  process.stdout.write(`Skipped (major bumps): ${report.skippedCount}\n`);
  process.stdout.write(`Failed updates: ${report.failedCount}\n`);
  if (report.evidenceFile) {
    process.stdout.write(`Evidence: ${report.evidenceFile}\n`);
  }
  if (report.errors.length > 0) {
    for (const error of report.errors) {
      process.stdout.write(`Error ${error.packageName}: ${error.message}\n`);
    }
  }
}

function portfolioExitCode(report: { failedCount: number; successCount: number }): number {
  if (report.failedCount <= 0) return EXIT_CODES.ok;
  return report.successCount > 0 ? EXIT_CODES.partial : EXIT_CODES.failed;
}

export async function runPortfolio(targetsFilePath: string, opts: CommandOptions): Promise<void> {
  let parsedTargets: unknown;
  try {
    parsedTargets = JSON.parse(readFileSync(targetsFilePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read targets file at "${targetsFilePath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!Array.isArray(parsedTargets)) {
    throw new Error("Portfolio targets file must be a JSON array.");
  }

  const report = await remediatePortfolio(parsedTargets, toRemediateOptions(opts));

  if (opts.outputFormat === "json") {
    logJson(report);
    if (opts.ci) {
      process.exitCode = portfolioExitCode(report);
    }
    return;
  }

  process.stdout.write(`Portfolio targets: ${report.targets.length}\n`);
  process.stdout.write(`Successful targets: ${report.successCount}\n`);
  process.stdout.write(`Failed targets: ${report.failedCount}\n`);
  if (opts.ci) {
    process.exitCode = portfolioExitCode(report);
  }
}

export async function runReachability(opts: {
  cwd?: string;
  package: string;
  symbol?: string;
  traceFile?: string;
  outputFormat?: string;
}): Promise<void> {
  const result = await checkReachability({
    cwd: opts.cwd,
    packageName: opts.package,
    symbol: opts.symbol,
    traceFile: opts.traceFile,
  });

  if (opts.outputFormat === "json") {
    logJson(result);
    return;
  }

  process.stdout.write(`Package: ${result.packageName}\n`);
  process.stdout.write(`Status: ${result.status}\n`);
  process.stdout.write(`Reason: ${result.reason}\n`);
  if (result.runtime) {
    process.stdout.write(`Runtime: ${result.runtime.verdict}\n`);
    process.stdout.write(`Note: ${result.runtime.caveat}\n`);
  }
  if (result.evidence && result.evidence.length > 0) {
    process.stdout.write(`Evidence files (${result.evidence.length}):\n`);
    for (const ev of result.evidence) {
      process.stdout.write(
        `  - ${ev.filePath} [${ev.matchType}] (invoked: ${ev.invoked ?? false})\n`,
      );
    }
  }
}

export async function runEvaluate(
  packageName: string,
  opts: {
    cwd?: string;
    version?: string;
    outputFormat?: string;
  },
): Promise<void> {
  const report = await evaluatePackage(packageName, {
    version: opts.version,
    cwd: opts.cwd,
    enrichIntelligence: true,
  });

  if (opts.outputFormat === "json") {
    logJson(report);
    return;
  }

  process.stdout.write(
    `Package: ${report.packageName}${report.evaluatedVersion ? `@${report.evaluatedVersion}` : ""}\n`,
  );
  process.stdout.write(`Verdict: ${report.verdict.toUpperCase()}\n`);
  process.stdout.write(`Summary: ${report.summary}\n`);
  if (report.recommendedVersion) {
    process.stdout.write(`Recommended Version: ${report.recommendedVersion}\n`);
  }
  if (report.vulnerabilities.length > 0) {
    process.stdout.write(`Known Vulnerabilities (${report.vulnerabilities.length}):\n`);
    for (const vuln of report.vulnerabilities) {
      process.stdout.write(`  - [${vuln.cveId}] (${vuln.severity}) ${vuln.summary}\n`);
      if (vuln.safeUpgradeVersion) {
        process.stdout.write(`    Safe upgrade: ${vuln.safeUpgradeVersion}\n`);
      }
    }
  }
}

export async function runDiffAudit(opts: {
  cwd?: string;
  base?: string;
  outputFormat?: string;
  ci?: boolean;
}): Promise<void> {
  const report = await scanDelta({
    cwd: opts.cwd,
    baseRef: opts.base,
  });

  if (opts.outputFormat === "json") {
    logJson(report);
    if (opts.ci) {
      process.exitCode = report.netRiskVerdict === "degraded" ? 1 : 0;
    }
    return;
  }

  process.stdout.write(`Delta scan against base: ${report.baseRef}\n`);
  process.stdout.write(`Net Risk Verdict: ${report.netRiskVerdict.toUpperCase()}\n`);
  process.stdout.write(`Dependency Changes: ${report.dependencyChanges.length}\n`);
  process.stdout.write(`Newly Introduced CVEs: ${report.introducedFindings.length}\n`);
  process.stdout.write(`Resolved CVEs: ${report.resolvedFindings.length}\n`);
  process.stdout.write(`Summary: ${report.summary}\n`);

  if (report.introducedFindings.length > 0) {
    process.stdout.write(`\nIntroduced Findings:\n`);
    for (const f of report.introducedFindings) {
      process.stdout.write(
        `  - [${f.cveId}] ${f.packageName}@${f.installedVersion ?? "unknown"} (${f.severity}): ${f.summary}\n`,
      );
    }
  }

  if (opts.ci) {
    process.exitCode = report.netRiskVerdict === "degraded" ? 1 : 0;
  }
}

export async function runReconcilePatches(
  opts: Pick<
    CommandOptions,
    "cwd" | "patchesDir" | "packageManager" | "runTests" | "outputFormat"
  > & {
    autoApply?: boolean;
  },
): Promise<void> {
  const report = await reconcilePatchArtifacts({
    cwd: opts.cwd,
    patchesDir: opts.patchesDir,
    packageManager: opts.packageManager,
    autoApply: opts.autoApply,
    runTests: opts.runTests,
  });

  if (opts.outputFormat === "json") {
    logJson(report);
    return;
  }

  process.stdout.write(`=== Patch Artifact Reconciliation ===\n`);
  process.stdout.write(`Reconciled (upgraded): ${report.reconciledCount}\n`);
  process.stdout.write(`Retained: ${report.retainedCount}\n\n`);

  for (const item of report.reconciled) {
    process.stdout.write(`- [${item.status}] ${item.packageName} (${item.patchFilePath})\n`);
    if (item.safeUpstreamVersion) {
      process.stdout.write(`  Safe Upstream Version: ${item.safeUpstreamVersion}\n`);
    }
    if (item.reason) {
      process.stdout.write(`  Reason: ${item.reason}\n`);
    }
  }
}

export async function runPlan(cveId: string, opts: CommandOptions): Promise<void> {
  // A plan is always a preview; planRemediation rejects the flags that would say otherwise.
  const { dryRun: _dryRun, preview: _preview, ...options } = toRemediateOptions(opts);
  const report = await planRemediation(cveId, options);

  if (opts.outputFormat === "json") {
    logJson(report);
    return;
  }

  process.stdout.write(`${report.summary}\n`);
  if (report.autonomy) process.stdout.write(`${formatAutonomyLine(report.autonomy)}\n`);
  if (report.runId) {
    process.stdout.write(`Plan: ${report.planId}\nRun:  ${report.runId}\n`);
    process.stdout.write(`Apply it with: autoremediator runs apply ${report.runId}\n`);
  }
}

export interface RunsOptions {
  cwd: string;
  outputFormat: OutputFormat;
  status?: string;
  limit?: number;
  planId?: string;
  force?: boolean;
  item?: string[];
  check?: string[];
  offline?: boolean;
  verify?: boolean;
  repair?: boolean;
  model?: string;
  maxRepairRounds?: number;
}

export async function runRunsList(opts: RunsOptions): Promise<void> {
  const runs = listRuns({
    cwd: opts.cwd,
    status: opts.status as RunStatus | undefined,
    limit: opts.limit,
  });
  if (opts.outputFormat === "json") {
    logJson(runs);
    return;
  }
  if (runs.length === 0) {
    process.stdout.write("No runs recorded.\n");
    return;
  }
  for (const run of runs) {
    process.stdout.write(
      `${run.runId}  ${run.status.padEnd(11)}  ${run.cveIds.join(",")}  ${run.createdAt}\n`,
    );
  }
}

export async function runRunsShow(runId: string, opts: RunsOptions): Promise<void> {
  const details = getRun({ cwd: opts.cwd, runId });
  if (opts.outputFormat === "json") {
    logJson(details);
    return;
  }
  const { run, plan } = details;
  process.stdout.write(`Run ${run.runId}: ${run.status}\n`);
  if (plan) {
    process.stdout.write(`Plan ${plan.planId}: ${plan.items.length} change(s), ${plan.skipped.length} skipped\n`);
    for (const item of plan.items) {
      const outcome = details.items.find((candidate) => candidate.itemId === item.itemId);
      process.stdout.write(
        `  ${outcome?.status ?? "pending".padEnd(7)}  ${item.packageName} ${item.fromVersion} -> ${item.toVersion} (${item.strategy}) [${item.itemId}]\n`,
      );
    }
    for (const skip of plan.skipped) {
      process.stdout.write(`  skipped  ${skip.packageName}: ${skip.reason}\n`);
    }
  }
  process.stdout.write(
    details.ledger.ok
      ? `Ledger: ${details.ledger.events.length} events, intact\n`
      : `Ledger: FAILED VERIFICATION (${details.ledger.reason})\n`,
  );
}

function printRunReport(report: Awaited<ReturnType<typeof applyPlan>>): void {
  process.stdout.write(`${report.message}\n`);
  if (report.autonomy) process.stdout.write(`${formatAutonomyLine(report.autonomy)}\n`);
  for (const item of report.items) {
    process.stdout.write(
      `  ${item.status}  ${item.packageName} ${item.fromVersion} -> ${item.toVersion}: ${item.message}\n`,
    );
  }
  if (report.pending.length > 0) {
    process.stdout.write(`Pending: ${report.pending.join(", ")}\n`);
  }
}

export async function runRunsApply(runId: string | undefined, opts: RunsOptions): Promise<void> {
  const report = await applyPlan({
    cwd: opts.cwd,
    runId,
    planId: opts.planId,
    itemIds: opts.item,
    // `--no-verify` arrives as verify: false; verification is on unless it is turned off.
    ...(opts.verify === false ? { verify: false } : {}),
    // `--repair` / `--no-repair`; unset means "on when a model is configured".
    ...(opts.repair === undefined ? {} : { repair: opts.repair }),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxRepairRounds ? { repairBudget: { maxRepairRounds: opts.maxRepairRounds } } : {}),
  });
  if (opts.outputFormat === "json") logJson(report);
  else printRunReport(report);
  if (report.status !== "applied") process.exitCode = 1;
}

export async function runRunsResume(runId: string, opts: RunsOptions): Promise<void> {
  const report = await resumeRun({ cwd: opts.cwd, runId });
  if (opts.outputFormat === "json") logJson(report);
  else printRunReport(report);
  if (report.status !== "applied") process.exitCode = 1;
}

export async function runRunsRollback(runId: string, opts: RunsOptions): Promise<void> {
  const report = await rollbackRun({ cwd: opts.cwd, runId, force: opts.force });
  if (opts.outputFormat === "json") logJson(report);
  else process.stdout.write(`${report.message}\n`);
}

export async function runRunsVerify(runId: string, opts: RunsOptions): Promise<void> {
  const result = await verifyRun({
    cwd: opts.cwd,
    runId,
    ...(opts.check ? { checks: opts.check as CheckName[] } : {}),
    ...(opts.offline ? { offline: true } : {}),
  });
  if (opts.outputFormat === "json") {
    logJson(result);
  } else {
    process.stdout.write(`${result.passed ? "Verified" : `Failed (${result.failedCheck})`}\n`);
    for (const check of result.checks) {
      process.stdout.write(`  ${check.status.padEnd(7)}  ${check.name}: ${check.message}\n`);
      for (const detail of check.details ?? []) process.stdout.write(`           ${detail}\n`);
    }
  }
  if (!result.passed) process.exitCode = 1;
}

export interface InitCliOptions {
  cwd: string;
  outputFormat: OutputFormat;
  hosts?: string;
  ci?: boolean;
  guard?: boolean;
  policy?: boolean;
  agentsMd?: boolean;
  yes?: boolean;
  check?: boolean;
}

function parseHosts(value: string | undefined): AgentHost[] | undefined {
  if (!value) return undefined;
  const hosts = value.split(",").map((host) => host.trim()).filter(Boolean);
  const unknown = hosts.filter((host) => !(AGENT_HOSTS as readonly string[]).includes(host));
  if (unknown.length > 0) {
    throw new Error(`Unknown host: ${unknown.join(", ")}. Choose from ${AGENT_HOSTS.join(", ")}.`);
  }
  return hosts as AgentHost[];
}

function describeInit(result: InitResult, header: string): string {
  const lines = [header];
  const { facts } = result;
  lines.push(
    `Package manager ${facts.packageManager}, git host ${facts.gitHost}, CI ${facts.ci.join(", ") || "none"}`,
    `Agent hosts: ${result.hosts.join(", ") || "none found (use --hosts)"}`,
  );
  for (const change of result.changes) {
    lines.push(`  ${change.action.padEnd(9)} ${change.path}${change.action === "conflict" ? `  (${change.reason})` : ""}`);
  }
  return lines.join("\n");
}

async function confirmInteractively(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function runInit(opts: InitCliOptions): Promise<void> {
  const base = {
    cwd: opts.cwd,
    hosts: parseHosts(opts.hosts),
    ci: opts.ci,
    guard: opts.guard,
    policy: opts.policy,
    agentsMd: opts.agentsMd,
  };
  let result = await init({ ...base, check: opts.check, yes: opts.yes });
  const json = opts.outputFormat === "json";
  const interactive = !json && !opts.yes && !opts.check && process.stdin.isTTY && process.stdout.isTTY;

  if (!json) {
    process.stdout.write(`${describeInit(result, opts.check ? "Checking setup" : "Setup plan")}\n`);
    if (!result.applied) {
      for (const change of result.changes) {
        if (change.diff) process.stdout.write(`\n${change.diff}\n`);
      }
    }
  }

  if (interactive && result.drift) {
    if (await confirmInteractively(`\nWrite ${result.changes.filter((c) => c.diff).length} file(s)? [y/N] `)) {
      result = await init({ ...base, yes: true });
      process.stdout.write("Done.\n");
    }
    return;
  }

  if (json) logJson(result);
  else if (result.applied) process.stdout.write("\nWritten.\n");
  else if (!opts.check && result.drift) process.stdout.write("\nNothing written. Run again with --yes to apply.\n");
  else if (!result.drift) process.stdout.write("\nAlready set up.\n");

  if (opts.check) {
    if (result.drift || result.conflicts.length > 0) process.exitCode = EXIT_CODES.failed;
  } else if (!result.applied && result.drift) {
    // Changes are waiting for a yes that this run could not get.
    process.exitCode = EXIT_CODES.needsApproval;
  }
}

export interface HookCliOptions {
  cwd: string;
  outputFormat: OutputFormat;
  hooks?: string;
  manager?: string;
  yes?: boolean;
}

function parseHookNames(value: string | undefined): HookName[] | undefined {
  if (!value) return undefined;
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(HOOK_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown hook: ${unknown.join(", ")}. Choose from ${HOOK_NAMES.join(", ")}.`);
  }
  return names as HookName[];
}

function parseHookManager(value: string | undefined): HookManager | undefined {
  if (!value) return undefined;
  if (!(HOOK_MANAGERS as readonly string[]).includes(value)) {
    throw new Error(`Unknown hook manager: ${value}. Choose from ${HOOK_MANAGERS.join(", ")}.`);
  }
  return value as HookManager;
}

function describeHooks(result: HooksResult, header: string): string {
  const lines = [header, `Hook manager: ${result.manager} (${result.managerReason})`];
  for (const hook of result.hooks) {
    lines.push(`  ${hook.state.padEnd(9)} ${hook.hook.padEnd(10)} ${hook.path}  (${hook.detail})`);
  }
  for (const change of result.changes) {
    if (change.action === "conflict") lines.push(`  conflict  ${change.reason}`);
  }
  return lines.join("\n");
}

/** `hook install`, `hook uninstall` and `hook status`; same approval rules as `init`. */
export async function runHook(mode: "install" | "uninstall" | "status", opts: HookCliOptions): Promise<void> {
  const base = {
    cwd: opts.cwd,
    hooks: parseHookNames(opts.hooks),
    manager: parseHookManager(opts.manager),
    uninstall: mode === "uninstall",
  };
  const check = mode === "status";
  let result = await installHooks({ ...base, check, yes: check ? false : opts.yes });
  const json = opts.outputFormat === "json";
  const interactive = !json && !check && !opts.yes && process.stdin.isTTY && process.stdout.isTTY;

  if (!json) {
    const header = check ? "Hook status" : mode === "uninstall" ? "Hook removal plan" : "Hook install plan";
    process.stdout.write(`${describeHooks(result, header)}\n`);
    if (!result.applied && !check) {
      for (const change of result.changes) {
        if (change.diff) process.stdout.write(`\n${change.diff}\n`);
      }
    }
  }

  if (interactive && result.drift) {
    if (await confirmInteractively(`\nWrite ${result.changes.filter((c) => c.diff || c.action === "update").length} file(s)? [y/N] `)) {
      result = await installHooks({ ...base, yes: true });
      process.stdout.write("Done.\n");
      for (const step of result.nextSteps) process.stdout.write(`Next: ${step}\n`);
    }
    return;
  }

  if (json) logJson(result);
  else {
    if (result.applied) process.stdout.write("\nWritten.\n");
    else if (!check && result.drift) process.stdout.write("\nNothing written. Run again with --yes to apply.\n");
    else if (!result.drift && result.conflicts.length === 0) {
      process.stdout.write(mode === "uninstall" ? "\nNothing to remove.\n" : check ? "\nAll hooks are installed.\n" : "\nAlready installed.\n");
    }
    for (const step of result.nextSteps) process.stdout.write(`Next: ${step}\n`);
  }

  if (check) {
    if (result.drift || result.conflicts.length > 0) process.exitCode = EXIT_CODES.failed;
  } else if (!result.applied && result.drift) {
    // Changes are waiting for a yes that this run could not get.
    process.exitCode = EXIT_CODES.needsApproval;
  } else if (result.conflicts.length > 0) {
    process.exitCode = EXIT_CODES.failed;
  }
}

export interface GuardCliOptions {
  cwd: string;
  outputFormat: OutputFormat;
  minAgeHours?: number;
  offline?: boolean;
  /** Guard the dependencies added or changed since `base` instead of the packages named. */
  gitDiff?: boolean;
  base?: string;
  includeTransitive?: boolean;
}

function describeGuard(report: GuardReport): string {
  const lines = [`${report.verdict.toUpperCase().padEnd(5)} ${report.spec}${report.resolvedVersion ? ` (${report.resolvedVersion})` : ""}`];
  for (const finding of report.findings) {
    lines.push(`  ${finding.severity.padEnd(5)} ${finding.check}: ${finding.message}`);
  }
  if (report.alternative) {
    const { packageName, version, reason } = report.alternative;
    lines.push(`  instead: ${packageName}${version ? `@${version}` : ""} (${reason})`);
  }
  return lines.join("\n");
}

export async function runGuard(specs: string[], opts: GuardCliOptions): Promise<void> {
  const options = {
    cwd: opts.cwd,
    ...(opts.minAgeHours === undefined ? {} : { minPublishAgeHours: opts.minAgeHours }),
    ...(opts.offline ? { offline: true } : {}),
  };
  if (opts.gitDiff) {
    const result = await guardGitDiff({
      ...options,
      ...(opts.base ? { baseRef: opts.base } : {}),
      ...(opts.includeTransitive ? { includeTransitive: true } : {}),
    });
    if (opts.outputFormat === "json") logJson(result);
    else {
      const head = `Dependencies added or changed since ${result.baseRef.slice(0, 12)}: ${result.checked} checked, ${result.skipped.length} skipped`;
      const skipped = result.skipped.map((entry) => `  skip  ${entry.packageName}@${entry.version}: ${entry.reason}`);
      process.stdout.write(`${[head, ...skipped, ...result.reports.map((entry) => describeGuard(entry))].join("\n")}\n`);
    }
    process.exitCode = guardExitCode(result.reports);
    return;
  }
  if (specs.length === 0) {
    throw new Error("Name at least one package, or use --git-diff to check what changed in the working tree.");
  }
  const reports = await guardPackages(specs, options);
  if (opts.outputFormat === "json") logJson(reports.length === 1 ? reports[0] : reports);
  else process.stdout.write(`${reports.map((entry) => describeGuard(entry)).join("\n")}\n`);
  process.exitCode = guardExitCode(reports);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Agent pre-command hook: JSON on stdin, the host's permission decision on stdout, always exit 0. */
export async function runGuardHook(host: HookHost = "claude-code"): Promise<void> {
  const output = await runHostHook(host, await readStdin());
  if (output) process.stdout.write(`${output}\n`);
}
