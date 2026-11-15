import type { Command } from "commander";

import {
  inspectPatchArtifact,
  listPatchArtifacts,
  validatePatchArtifact,
  reconcilePatchArtifacts,
  OPTION_DESCRIPTIONS,
} from "../../../api/index.js";
import { mergeCommandOptions } from "../options.js";
import { logJson } from "../output.js";
import type { CommandOptions } from "../types.js";
import { validateOutputFormat } from "../validators.js";

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

function registerListPatches(patches: Command): void {
  patches
    .command("list")
    .description("List patch artifacts in the configured patches directory")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(
      async (
        _opts: Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">,
        command: Command,
      ) => {
        const merged = mergeCommandOptions(command) as Pick<
          CommandOptions,
          "cwd" | "patchesDir" | "outputFormat"
        >;
        validateOutputFormat(merged.outputFormat, ["text", "json"], "patches list");
        await runListPatches(merged);
      },
    );
}

function registerInspectPatches(patches: Command): void {
  patches
    .command("inspect")
    .description("Inspect a patch artifact and its manifest metadata")
    .argument("<patchPath>", "Path to the .patch file to inspect")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(
      async (
        patchPath: string,
        _opts: Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">,
        command: Command,
      ) => {
        const merged = mergeCommandOptions(command) as Pick<
          CommandOptions,
          "cwd" | "patchesDir" | "outputFormat"
        >;
        validateOutputFormat(merged.outputFormat, ["text", "json"], "patches inspect");
        await runInspectPatch(patchPath, merged);
      },
    );
}

function registerValidatePatches(patches: Command): void {
  patches
    .command("validate")
    .description(
      "Validate a patch artifact against its manifest and the current dependency inventory",
    )
    .argument("<patchPath>", "Path to the .patch file to validate")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(
      async (
        patchPath: string,
        _opts: Pick<CommandOptions, "cwd" | "patchesDir" | "packageManager" | "outputFormat">,
        command: Command,
      ) => {
        const merged = mergeCommandOptions(command) as Pick<
          CommandOptions,
          "cwd" | "patchesDir" | "packageManager" | "outputFormat"
        >;
        validateOutputFormat(merged.outputFormat, ["text", "json"], "patches validate");
        await runValidatePatch(patchPath, merged);
      },
    );
}

function registerReconcilePatches(patches: Command): void {
  patches
    .command("reconcile")
    .description(
      "Reconcile active patch artifacts against upstream registries to retire obsolete patches",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--auto-apply", "Automatically upgrade packages and remove retired patch artifacts")
    .option("--run-tests", OPTION_DESCRIPTIONS.runTests)
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(
      async (
        _opts: Pick<
          CommandOptions,
          "cwd" | "patchesDir" | "packageManager" | "runTests" | "outputFormat"
        > & { autoApply?: boolean },
        command: Command,
      ) => {
        const merged = mergeCommandOptions(command);
        validateOutputFormat(merged.outputFormat ?? "text", ["text", "json"], "patches reconcile");
        await runReconcilePatches(merged);
      },
    );
}

export function registerPatchesCommands(program: Command): void {
  const patches = program
    .command("patches")
    .description("Inspect and validate stored patch artifacts");
  registerListPatches(patches);
  registerInspectPatches(patches);
  registerValidatePatches(patches);
  registerReconcilePatches(patches);
}
