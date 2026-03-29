import { Command } from "commander";
import { OPTION_DESCRIPTIONS } from "../api/index.js";
import { existsSync } from "node:fs";
import { PACKAGE_VERSION } from "../version";
import { runScanInput, runSingleCve } from "./runners.js";
import type { CommandOptions } from "./types.js";
import { isCveId } from "./types.js";

function addSharedOptions(program: Command, includeInput = false): Command {
  program
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--dry-run", OPTION_DESCRIPTIONS.dryRun, false)
    .option("--preview", OPTION_DESCRIPTIONS.preview, false)
    .option("--run-tests", OPTION_DESCRIPTIONS.runTests, false)
    .option("--llm-provider <provider>", OPTION_DESCRIPTIONS.llmProvider)
    .option("--request-id <id>", OPTION_DESCRIPTIONS.requestId)
    .option("--session-id <id>", OPTION_DESCRIPTIONS.sessionId)
    .option("--parent-run-id <id>", OPTION_DESCRIPTIONS.parentRunId)
    .option("--idempotency-key <key>", OPTION_DESCRIPTIONS.idempotencyKey)
    .option("--resume", OPTION_DESCRIPTIONS.resume, false)
    .option("--actor <name>", OPTION_DESCRIPTIONS.actor)
    .option("--source <src>", `${OPTION_DESCRIPTIONS.source}: cli|sdk|mcp|openapi|unknown`)
    .option("--direct-dependencies-only", OPTION_DESCRIPTIONS.directDependenciesOnly, false)
    .option("--prefer-version-bump", OPTION_DESCRIPTIONS.preferVersionBump, false)
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--evidence", OPTION_DESCRIPTIONS.evidence, true)
    .option("--no-evidence", "Disable evidence file output")
    .option("--ci", "Enable CI behavior (non-zero exit on failed remediations)", false)
    .option("--output-format <format>", "Output format: json|sarif", "json")
    .option("--json", "Print JSON output", false);

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
    await runSingleCve(cveId, merged);
  });

  addSharedOptions(
    program
      .command("scan")
      .description("Remediate vulnerabilities from scanner output (npm/pnpm/yarn audit JSON or SARIF)")
      .requiredOption("--input <path>", OPTION_DESCRIPTIONS.inputPath)
      .option("--format <type>", OPTION_DESCRIPTIONS.format, "auto")
      .option("--summary-file <path>", "Write machine-readable scan summary JSON to path"),
    false
  ).action(async (opts: CommandOptions) => {
    await runScanInput(opts.input!, opts);
  });

  addSharedOptions(
    program
      .argument("[target]", "Scanner output file path (or CVE ID fallback)")
      .option("--format <type>", OPTION_DESCRIPTIONS.format, "auto")
      .option("--summary-file <path>", "Write machine-readable scan summary JSON to path"),
    true
  ).action(async (target: string | undefined, opts: CommandOptions) => {
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
