import {
  inspectPatchArtifact,
  listPatchArtifacts,
  validatePatchArtifact,
  reconcilePatchArtifacts,
} from "../../../api/index.js";
import { logJson } from "../output.js";
import type { CommandOptions } from "../types.js";

function assertPatchOutputFormat(format: string): void {
  if (format !== "text" && format !== "json") {
    throw new Error('Patch commands support --output-format "text" or "json".');
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
