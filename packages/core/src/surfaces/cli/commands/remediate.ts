import { readFileSync, writeFileSync, existsSync } from "node:fs";

import type { Command } from "commander";

import {
  EXIT_CODES,
  planRemediation,
  remediatePortfolio,
  remediate,
  remediateFromScan,
  buildSlaBreachSummary,
  buildStrategyCounts,
  buildDependencyScopeCounts,
  type PatchResult,
  type RemediateOptions,
  type ScanReport,
  toCiSummary,
  updateOutdated,
  OPTION_DESCRIPTIONS,
} from "../../../api/index.js";
import type { ChangeRequestProvider } from "../../../features/change-request/types.js";
import { errorMessage } from "../../../shared/errors.js";
import { emitScanReport } from "../emit.js";
import { mergeCommandOptions, addSharedOptions } from "../options.js";
import { formatCountMap, logJson } from "../output.js";
import { formatResultLines } from "../result-lines.js";
import { patchGeneratedLines, slaBreachLines, transitiveLines } from "../summary-lines.js";
import type { CommandOptions } from "../types.js";
import { isCveId } from "../types.js";
import { validateOutputFormat, validateSharedCommandOptions } from "../validators.js";
import { formatAutonomyLine } from "./autonomy.js";
import { runInteractiveTriage } from "./triage.js";

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
  if (typeof opts.minConfidenceForAutoApply === "number") {
    policy.minConfidenceForAutoApply = opts.minConfidenceForAutoApply;
  }
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
    ignoreMemory: opts.ignoreMemory,
  };
}

function singleCveStatus(results: readonly PatchResult[]): ScanReport["status"] {
  const anyFailed = results.some((result) => !result.applied && !result.dryRun);
  if (!anyFailed) return "ok";
  return results.some((result) => result.applied || result.dryRun) ? "partial" : "failed";
}

function asSingleCveScanReport(report: Awaited<ReturnType<typeof remediate>>): ScanReport {
  const succeeded = report.results.filter((result) => result.applied || result.dryRun);
  return {
    schemaVersion: "1.0",
    status: singleCveStatus(report.results),
    generatedAt: new Date().toISOString(),
    cveIds: [report.cveId],
    reports: [report],
    successCount: succeeded.length,
    failedCount: report.results.length - succeeded.length,
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

function singleCveText(report: Awaited<ReturnType<typeof remediate>>, scan: ScanReport): string[] {
  const lines = [report.summary];
  if (report.autonomy) lines.push(formatAutonomyLine(report.autonomy));
  lines.push(
    `Results: ${report.results.length}`,
    ...transitiveLines(scan.dependencyScopeCounts),
    ...patchGeneratedLines(scan.strategyCounts?.["patch-file"] ?? 0, report.results),
    ...slaBreachLines(scan.slaBreachSummary),
  );
  if (report.evidenceFile) lines.push(`Evidence: ${report.evidenceFile}`);
  return lines;
}

export async function runSingleCve(cveId: string, opts: CommandOptions): Promise<void> {
  const report = await remediate(cveId, toRemediateOptions(opts));
  const scan = asSingleCveScanReport(report);
  emitScanReport(opts, { scan, json: report, text: () => singleCveText(report, scan) });
}

function scanText(report: ScanReport): string[] {
  const results = report.reports.flatMap((entry) => entry.results);
  const counts = [
    ["Strategy counts", formatCountMap(report.strategyCounts)],
    ["Dependency scope counts", formatCountMap(report.dependencyScopeCounts)],
  ] as const;
  const unresolved = formatCountMap(report.unresolvedByReason);
  return [
    ...formatResultLines(results),
    `CVEs found: ${report.cveIds.length}`,
    `Remediation reports: ${report.reports.length}`,
    `Successful remediations: ${report.successCount}`,
    `Failed remediations: ${report.failedCount}`,
    ...counts.filter(([, text]) => text).map(([label, text]) => `${label}: ${text}`),
    ...transitiveLines(report.dependencyScopeCounts),
    ...patchGeneratedLines(report.strategyCounts?.["patch-file"] ?? 0, results),
    ...slaBreachLines(report.slaBreachSummary),
    ...(unresolved ? [`Unresolved reasons: ${unresolved}`] : []),
    ...(report.evidenceFile ? [`Evidence: ${report.evidenceFile}`] : []),
    ...report.errors.map((error) => `Error ${error.cveId}: ${error.message}`),
  ];
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
    writeFileSync(opts.summaryFile, `${JSON.stringify(toCiSummary(report), null, 2)}\n`, "utf8");
  }
  emitScanReport(opts, { scan: report, json: report, text: () => scanText(report) });
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
    throw new Error(`Could not read targets file at "${targetsFilePath}": ${errorMessage(error)}`, {
      cause: error,
    });
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

export function registerRemediateCommands(program: Command): void {
  addSharedOptions(
    program
      .command("cve")
      .description("Remediate a single CVE ID")
      .argument("<cveId>", OPTION_DESCRIPTIONS.cveId),
    false,
  ).action(async (cveId: string, _opts: CommandOptions, command: Command) => {
    const merged = mergeCommandOptions(command);
    validateSharedCommandOptions(merged);
    validateOutputFormat(merged.outputFormat, ["text", "json", "sarif", "cyclonedx-vex"], "cve");
    await runSingleCve(cveId, merged);
  });
  addSharedOptions(
    program
      .command("scan")
      .description(
        "Remediate vulnerabilities from scanner output (npm/pnpm/yarn/bun audit JSON or SARIF)",
      )
      .option("--input <path>", OPTION_DESCRIPTIONS.inputPath)
      .option("--format <type>", OPTION_DESCRIPTIONS.format, "auto")
      .option("--summary-file <path>", "Write machine-readable scan summary JSON to path"),
    false,
  ).action(async (_opts: CommandOptions, command: Command) => {
    const merged = mergeCommandOptions(command);

    validateSharedCommandOptions(merged);
    validateOutputFormat(merged.outputFormat, ["text", "json", "sarif", "cyclonedx-vex"], "scan");

    if (!merged.audit && !merged.input) {
      throw new Error("scan mode requires --input unless --audit is enabled.");
    }
    await runScanInput(merged.input ?? "", merged);
  });
  addSharedOptions(
    program
      .command("update-outdated")
      .description("Bump all outdated npm packages to their latest versions")
      .option("--include-transitive", OPTION_DESCRIPTIONS.includeTransitive),
    false,
    false,
  ).action(async (_opts: CommandOptions, command: Command) => {
    const merged = mergeCommandOptions(command);
    if (merged.simulationMode) {
      throw new Error("--simulation-mode is not supported by update-outdated.");
    }
    validateSharedCommandOptions(merged);
    validateOutputFormat(merged.outputFormat, ["text", "json"], "update-outdated");
    await runUpdateOutdated(merged);
  });
  addSharedOptions(
    program
      .command("portfolio")
      .description("Run CVE or scan remediation across multiple repository targets")
      .requiredOption("--targets-file <path>", "Path to portfolio targets JSON file"),
    false,
  ).action(async (_opts: CommandOptions, command: Command) => {
    const merged = mergeCommandOptions(command);

    validateSharedCommandOptions(merged);
    validateOutputFormat(merged.outputFormat, ["text", "json"], "portfolio");

    await runPortfolio(merged.targetsFile!, merged);
  });
  addSharedOptions(
    program
      .command("plan")
      .description("Preview the fix for a CVE and record it as a plan you can apply later")
      .argument("<cveId>", OPTION_DESCRIPTIONS.cveId),
    false,
  ).action(async (cveId: string, _opts: CommandOptions, command: Command) => {
    const merged = mergeCommandOptions(command);
    validateSharedCommandOptions(merged);
    validateOutputFormat(merged.outputFormat, ["text", "json"], "plan");
    await runPlan(cveId, merged);
  });
}

export function registerDefaultCommand(program: Command): void {
  addSharedOptions(
    program
      .argument("[target]", "Scanner output file path (or CVE ID fallback)")
      .option("--format <type>", OPTION_DESCRIPTIONS.format, "auto")
      .option("--summary-file <path>", "Write machine-readable scan summary JSON to path"),
    true,
  ).action(async (target: string | undefined, opts: CommandOptions) => {
    validateSharedCommandOptions(opts);
    validateOutputFormat(opts.outputFormat, ["text", "json", "sarif"], "default");

    if (opts.interactive) {
      await runInteractiveTriage(opts.input ?? target ?? opts, opts);
      return;
    }

    if (opts.audit) {
      await runScanInput(opts.input ?? target ?? "", opts);
      return;
    }

    if (opts.input) {
      await runScanInput(opts.input, opts);
      return;
    }

    if (!target) {
      program.outputHelp();
      return;
    }

    if (isCveId(target)) {
      await runSingleCve(target, opts);
      return;
    }

    if (existsSync(target)) {
      await runScanInput(target, opts);
      return;
    }

    throw new Error(`Target "${target}" is neither a valid CVE ID nor an existing scan file path.`);
  });
}
