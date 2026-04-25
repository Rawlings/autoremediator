import { Command } from "commander";
import { OPTION_DESCRIPTIONS } from "../api/index.js";
import { existsSync } from "node:fs";
import { PACKAGE_VERSION } from "../version";
import { runInspectPatch, runListPatches, runPortfolio, runScanInput, runSingleCve, runUpdateOutdated, runValidatePatch } from "./runners.js";
import type { CommandOptions } from "./types.js";
import { isCveId } from "./types.js";
import { validateOutputFormat, validateSharedCommandOptions } from "./validators.js";

function addSharedOptions(program: Command, includeInput = false): Command {
  const parseBooleanFlag = (value: string): boolean => value === "true";

  program
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--dry-run", OPTION_DESCRIPTIONS.dryRun, false)
    .option("--preview", OPTION_DESCRIPTIONS.preview, false)
    .option("--run-tests", OPTION_DESCRIPTIONS.runTests, false)
    .option("--llm-provider <provider>", OPTION_DESCRIPTIONS.llmProvider)
    .option("--model <name>", OPTION_DESCRIPTIONS.model)
    .option("--model-personality <profile>", OPTION_DESCRIPTIONS.modelPersonality)
    .option("--provider-safety-profile <profile>", OPTION_DESCRIPTIONS.providerSafetyProfile)
    .option("--require-consensus-for-high-risk", OPTION_DESCRIPTIONS.requireConsensusForHighRisk, false)
    .option("--consensus-provider <provider>", OPTION_DESCRIPTIONS.consensusProvider)
    .option("--consensus-model <name>", OPTION_DESCRIPTIONS.consensusModel)
    .option(
      "--patch-confidence-low <value>",
      OPTION_DESCRIPTIONS.patchConfidenceThresholdLow,
      (value: string) => parseFloat(value)
    )
    .option(
      "--patch-confidence-medium <value>",
      OPTION_DESCRIPTIONS.patchConfidenceThresholdMedium,
      (value: string) => parseFloat(value)
    )
    .option(
      "--patch-confidence-high <value>",
      OPTION_DESCRIPTIONS.patchConfidenceThresholdHigh,
      (value: string) => parseFloat(value)
    )
    .option("--dynamic-model-routing", OPTION_DESCRIPTIONS.dynamicModelRouting, false)
    .option(
      "--dynamic-routing-threshold-chars <count>",
      OPTION_DESCRIPTIONS.dynamicRoutingThresholdChars,
      (value: string) => parseInt(value, 10)
    )
    .option("--request-id <id>", OPTION_DESCRIPTIONS.requestId)
    .option("--session-id <id>", OPTION_DESCRIPTIONS.sessionId)
    .option("--parent-run-id <id>", OPTION_DESCRIPTIONS.parentRunId)
    .option("--idempotency-key <key>", OPTION_DESCRIPTIONS.idempotencyKey)
    .option("--resume", OPTION_DESCRIPTIONS.resume, false)
    .option("--actor <name>", OPTION_DESCRIPTIONS.actor)
    .option("--source <src>", `${OPTION_DESCRIPTIONS.source}: cli|sdk|mcp|openapi|unknown`)
    .option("--direct-dependencies-only", OPTION_DESCRIPTIONS.directDependenciesOnly, false)
    .option("--prefer-version-bump", OPTION_DESCRIPTIONS.preferVersionBump, false)
    .option("--install-mode <mode>", OPTION_DESCRIPTIONS.installMode)
    .option(
      "--install-prefer-offline <value>",
      `${OPTION_DESCRIPTIONS.installPreferOffline} (true|false)`,
      parseBooleanFlag
    )
    .option(
      "--enforce-frozen-lockfile <value>",
      `${OPTION_DESCRIPTIONS.enforceFrozenLockfile} (true|false)`,
      parseBooleanFlag
    )
    .option("--workspace <name>", OPTION_DESCRIPTIONS.workspace)
    .option("--audit", OPTION_DESCRIPTIONS.audit, false)
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--evidence", OPTION_DESCRIPTIONS.evidence, true)
    .option("--no-evidence", "Disable evidence file output")
    .option("--ci", "Enable CI behavior (non-zero exit on failed remediations)", false)
    .option("--output-format <format>", "Output format: text|json|sarif", "text")
    .option("--kev-mandatory", OPTION_DESCRIPTIONS.kevMandatory, false)
    .option(
      "--epss-threshold <value>",
      OPTION_DESCRIPTIONS.epssThreshold,
      (v: string) => parseFloat(v)
    )
    .option("--suppressions-file <path>", OPTION_DESCRIPTIONS.suppressionsFile)
    .option("--sla-check", OPTION_DESCRIPTIONS.slaCheck, false)
    .option("--skip-unreachable", OPTION_DESCRIPTIONS.skipUnreachable, false)
    .option("--regression-check", OPTION_DESCRIPTIONS.regressionCheck, false)
    .option("--create-change-request", OPTION_DESCRIPTIONS.createChangeRequest, false)
    .option("--change-request-provider <provider>", OPTION_DESCRIPTIONS.changeRequestProvider)
    .option("--change-request-grouping <grouping>", OPTION_DESCRIPTIONS.changeRequestGrouping)
    .option("--change-request-repository <repository>", OPTION_DESCRIPTIONS.changeRequestRepository)
    .option("--change-request-base-branch <branch>", OPTION_DESCRIPTIONS.changeRequestBaseBranch)
    .option("--change-request-branch-prefix <prefix>", OPTION_DESCRIPTIONS.changeRequestBranchPrefix)
    .option("--change-request-title-prefix <prefix>", OPTION_DESCRIPTIONS.changeRequestTitlePrefix);

  if (includeInput) {
    program.option("--input <path>", `${OPTION_DESCRIPTIONS.inputPath} (scanner-first mode)`);
  }

  return program;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("autoremediator")
    .description("Scanner-first Node.js vulnerability auto-remediation tool")
    .version(PACKAGE_VERSION)
    .showHelpAfterError();

  addSharedOptions(
    program
      .command("cve")
      .description("Remediate a single CVE ID")
      .argument("<cveId>", OPTION_DESCRIPTIONS.cveId),
    false
  ).action(async (cveId: string, opts: CommandOptions, command: Command) => {
    const merged = {
      ...opts,
      ...(command.optsWithGlobals() as Partial<CommandOptions>),
    } as CommandOptions;
    validateSharedCommandOptions(merged);
    validateOutputFormat(merged.outputFormat, ["text", "json", "sarif"], "cve");
    await runSingleCve(cveId, merged);
  });

  addSharedOptions(
    program
      .command("scan")
      .description("Remediate vulnerabilities from scanner output (npm/pnpm/yarn audit JSON or SARIF)")
      .option("--input <path>", OPTION_DESCRIPTIONS.inputPath)
      .option("--format <type>", OPTION_DESCRIPTIONS.format, "auto")
      .option("--summary-file <path>", "Write machine-readable scan summary JSON to path"),
    false
  ).action(async (opts: CommandOptions, command: Command) => {
    const merged = {
      ...opts,
      ...(command.optsWithGlobals() as Partial<CommandOptions>),
    } as CommandOptions;

    validateSharedCommandOptions(merged);
    validateOutputFormat(merged.outputFormat, ["text", "json", "sarif"], "scan");

    if (!merged.audit && !merged.input) {
      throw new Error("scan mode requires --input unless --audit is enabled.");
    }
    await runScanInput(merged.input ?? "", merged);
  });

  addSharedOptions(
    program
      .command("update-outdated")
      .description("Bump all outdated npm packages to their latest versions")
      .option("--include-transitive", OPTION_DESCRIPTIONS.includeTransitive, false),
    false
  ).action(async (opts: CommandOptions, command: Command) => {
    const merged = {
      ...opts,
      ...(command.optsWithGlobals() as Partial<CommandOptions>),
    } as CommandOptions;
    validateSharedCommandOptions(merged);
    validateOutputFormat(merged.outputFormat, ["text", "json"], "update-outdated");
    await runUpdateOutdated(merged);
  });

  addSharedOptions(
    program
      .command("portfolio")
      .description("Run CVE or scan remediation across multiple repository targets")
      .requiredOption("--targets-file <path>", "Path to portfolio targets JSON file"),
    false
  ).action(async (opts: CommandOptions, command: Command) => {
    const merged = {
      ...opts,
      ...(command.optsWithGlobals() as Partial<CommandOptions>),
    } as CommandOptions;

    validateSharedCommandOptions(merged);
    validateOutputFormat(merged.outputFormat, ["text", "json"], "portfolio");

    await runPortfolio(merged.targetsFile!, merged);
  });

  const patches = program.command("patches").description("Inspect and validate stored patch artifacts");

  patches
    .command("list")
    .description("List patch artifacts in the configured patches directory")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">, command: Command) => {
      const merged = {
        ...(command.optsWithGlobals() as Partial<CommandOptions>),
        ...opts,
      } as Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">;
      validateOutputFormat(merged.outputFormat, ["text", "json"], "patches list");
      await runListPatches(merged);
    });

  patches
    .command("inspect")
    .description("Inspect a patch artifact and its manifest metadata")
    .argument("<patchPath>", "Path to the .patch file to inspect")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (patchPath: string, opts: Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">, command: Command) => {
      const merged = {
        ...(command.optsWithGlobals() as Partial<CommandOptions>),
        ...opts,
      } as Pick<CommandOptions, "cwd" | "patchesDir" | "outputFormat">;
      validateOutputFormat(merged.outputFormat, ["text", "json"], "patches inspect");
      await runInspectPatch(patchPath, merged);
    });

  patches
    .command("validate")
    .description("Validate a patch artifact against its manifest and the current dependency inventory")
    .argument("<patchPath>", "Path to the .patch file to validate")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (patchPath: string, opts: Pick<CommandOptions, "cwd" | "patchesDir" | "packageManager" | "outputFormat">, command: Command) => {
      const merged = {
        ...(command.optsWithGlobals() as Partial<CommandOptions>),
        ...opts,
      } as Pick<CommandOptions, "cwd" | "patchesDir" | "packageManager" | "outputFormat">;
      validateOutputFormat(merged.outputFormat, ["text", "json"], "patches validate");
      await runValidatePatch(patchPath, merged);
    });

  addSharedOptions(
    program
      .argument("[target]", "Scanner output file path (or CVE ID fallback)")
      .option("--format <type>", OPTION_DESCRIPTIONS.format, "auto")
      .option("--summary-file <path>", "Write machine-readable scan summary JSON to path"),
    true
  ).action(async (target: string | undefined, opts: CommandOptions) => {
    validateSharedCommandOptions(opts);
    validateOutputFormat(opts.outputFormat, ["text", "json", "sarif"], "default");

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

    throw new Error(
      `Target "${target}" is neither a valid CVE ID nor an existing scan file path.`
    );
  });

  return program;
}
