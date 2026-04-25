import {
  ciExitCode,
  inspectPatchArtifact,
  listPatchArtifacts,
  remediatePortfolio,
  remediate,
  remediateFromScan,
  type ScanReport,
  toCiSummary,
  toSarifOutput,
  updateOutdated,
  validatePatchArtifact,
} from "../api/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { formatCountMap, logJson } from "./output.js";
import type { CommandOptions } from "./types.js";

function assertPatchOutputFormat(format: string): void {
  if (format !== "text" && format !== "json") {
    throw new Error('Patch commands support --output-format "text" or "json".');
  }
}

function resolveChangeRequestOptions(opts: CommandOptions): {
  enabled?: boolean;
  provider: "github" | "gitlab";
  grouping?: "all" | "per-cve" | "per-package";
  repository?: string;
  baseBranch?: string;
  branchPrefix?: string;
  titlePrefix?: string;
} | undefined {
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
    correlation: report.correlation,
    provenance: report.provenance,
    constraints: report.constraints,
  };
}

export async function runSingleCve(cveId: string, opts: CommandOptions): Promise<void> {
  const changeRequest = resolveChangeRequestOptions(opts);

  const report = await remediate(cveId, {
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    dryRun: opts.dryRun,
    preview: opts.preview,
    runTests: opts.runTests,
    patchesDir: opts.patchesDir,
    policy: opts.policy,
    evidence: opts.evidence,
    llmProvider: opts.llmProvider,
    model: opts.model,
    modelPersonality: opts.modelPersonality,
    providerSafetyProfile: opts.providerSafetyProfile,
    requireConsensusForHighRisk: opts.requireConsensusForHighRisk,
    consensusProvider: opts.consensusProvider,
    consensusModel: opts.consensusModel,
    patchConfidenceThresholds: {
      low: typeof opts.patchConfidenceLow === "number" ? opts.patchConfidenceLow : undefined,
      medium: typeof opts.patchConfidenceMedium === "number" ? opts.patchConfidenceMedium : undefined,
      high: typeof opts.patchConfidenceHigh === "number" ? opts.patchConfidenceHigh : undefined,
    },
    dynamicModelRouting: opts.dynamicModelRouting,
    dynamicRoutingThresholdChars:
      typeof opts.dynamicRoutingThresholdChars === "number"
        ? opts.dynamicRoutingThresholdChars
        : undefined,
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
    exploitSignalOverride: (opts.kevMandatory || opts.epssThreshold != null)
      ? {
          kev: opts.kevMandatory ? { mandatory: true } : undefined,
          epss: opts.epssThreshold != null ? { mandatory: true, threshold: opts.epssThreshold } : undefined,
        }
      : undefined,
    suppressionsFile: opts.suppressionsFile,
    slaCheck: opts.slaCheck,
    skipUnreachable: opts.skipUnreachable,
    regressionCheck: opts.regressionCheck,
    changeRequest,
  });

  const reportAsScan = asSingleCveScanReport(report);

  if (opts.outputFormat === "sarif") {
    logJson(toSarifOutput(reportAsScan));
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
  process.stdout.write(`Results: ${report.results.length}\n`);
  if (report.evidenceFile) {
    process.stdout.write(`Evidence: ${report.evidenceFile}\n`);
  }
  if (opts.ci) {
    process.exitCode = ciExitCode(toCiSummary(reportAsScan));
  }
}

export async function runScanInput(inputPath: string, opts: CommandOptions): Promise<void> {
  const changeRequest = resolveChangeRequestOptions(opts);

  const report = await remediateFromScan(inputPath, {
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    format: opts.format,
    audit: opts.audit,
    policy: opts.policy,
    patchesDir: opts.patchesDir,
    dryRun: opts.dryRun,
    preview: opts.preview,
    runTests: opts.runTests,
    llmProvider: opts.llmProvider,
    model: opts.model,
    modelPersonality: opts.modelPersonality,
    providerSafetyProfile: opts.providerSafetyProfile,
    requireConsensusForHighRisk: opts.requireConsensusForHighRisk,
    consensusProvider: opts.consensusProvider,
    consensusModel: opts.consensusModel,
    patchConfidenceThresholds: {
      low: typeof opts.patchConfidenceLow === "number" ? opts.patchConfidenceLow : undefined,
      medium: typeof opts.patchConfidenceMedium === "number" ? opts.patchConfidenceMedium : undefined,
      high: typeof opts.patchConfidenceHigh === "number" ? opts.patchConfidenceHigh : undefined,
    },
    dynamicModelRouting: opts.dynamicModelRouting,
    dynamicRoutingThresholdChars:
      typeof opts.dynamicRoutingThresholdChars === "number"
        ? opts.dynamicRoutingThresholdChars
        : undefined,
    evidence: opts.evidence,
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
    exploitSignalOverride: (opts.kevMandatory || opts.epssThreshold != null)
      ? {
          kev: opts.kevMandatory ? { mandatory: true } : undefined,
          epss: opts.epssThreshold != null ? { mandatory: true, threshold: opts.epssThreshold } : undefined,
        }
      : undefined,
    suppressionsFile: opts.suppressionsFile,
    slaCheck: opts.slaCheck,
    skipUnreachable: opts.skipUnreachable,
    regressionCheck: opts.regressionCheck,
    changeRequest,
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

export async function runListPatches(opts: Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">): Promise<void> {
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
  opts: Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">
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
  opts: Pick<CommandOptions, "cwd" | "patchesDir" | "packageManager" | "outputFormat">
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
  const changeRequest = resolveChangeRequestOptions(opts);

  const report = await updateOutdated({
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    dryRun: opts.dryRun,
    runTests: opts.runTests,
    evidence: opts.evidence,
    policy: opts.policy,
    patchesDir: opts.patchesDir,
    includeTransitive: opts.includeTransitive,
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
    changeRequest,
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

export async function runPortfolio(targetsFilePath: string, opts: CommandOptions): Promise<void> {
  const changeRequest = resolveChangeRequestOptions(opts);

  let parsedTargets: unknown;
  try {
    parsedTargets = JSON.parse(readFileSync(targetsFilePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read targets file at "${targetsFilePath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!Array.isArray(parsedTargets)) {
    throw new Error("Portfolio targets file must be a JSON array.");
  }

  const report = await remediatePortfolio(parsedTargets, {
    cwd: opts.cwd,
    packageManager: opts.packageManager,
    dryRun: opts.dryRun,
    preview: opts.preview,
    runTests: opts.runTests,
    patchesDir: opts.patchesDir,
    policy: opts.policy,
    evidence: opts.evidence,
    llmProvider: opts.llmProvider,
    model: opts.model,
    modelPersonality: opts.modelPersonality,
    providerSafetyProfile: opts.providerSafetyProfile,
    requireConsensusForHighRisk: opts.requireConsensusForHighRisk,
    consensusProvider: opts.consensusProvider,
    consensusModel: opts.consensusModel,
    patchConfidenceThresholds: {
      low: typeof opts.patchConfidenceLow === "number" ? opts.patchConfidenceLow : undefined,
      medium: typeof opts.patchConfidenceMedium === "number" ? opts.patchConfidenceMedium : undefined,
      high: typeof opts.patchConfidenceHigh === "number" ? opts.patchConfidenceHigh : undefined,
    },
    dynamicModelRouting: opts.dynamicModelRouting,
    dynamicRoutingThresholdChars:
      typeof opts.dynamicRoutingThresholdChars === "number"
        ? opts.dynamicRoutingThresholdChars
        : undefined,
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
    exploitSignalOverride: (opts.kevMandatory || opts.epssThreshold != null)
      ? {
          kev: opts.kevMandatory ? { mandatory: true } : undefined,
          epss: opts.epssThreshold != null ? { mandatory: true, threshold: opts.epssThreshold } : undefined,
        }
      : undefined,
    suppressionsFile: opts.suppressionsFile,
    slaCheck: opts.slaCheck,
    skipUnreachable: opts.skipUnreachable,
    regressionCheck: opts.regressionCheck,
    changeRequest,
  });

  if (opts.outputFormat === "json") {
    logJson(report);
    if (opts.ci) {
      process.exitCode = report.failedCount > 0 ? 1 : 0;
    }
    return;
  }

  process.stdout.write(`Portfolio targets: ${report.targets.length}\n`);
  process.stdout.write(`Successful targets: ${report.successCount}\n`);
  process.stdout.write(`Failed targets: ${report.failedCount}\n`);
  if (opts.ci) {
    process.exitCode = report.failedCount > 0 ? 1 : 0;
  }
}
