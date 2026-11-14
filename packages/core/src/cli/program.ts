import { existsSync } from "node:fs";

import { Command } from "commander";

import { OPTION_DESCRIPTIONS } from "../api/index.js";
import { PACKAGE_VERSION } from "../version.js";
import {
  runDiffAudit,
  runEvaluate,
  runInspectPatch,
  runListPatches,
  runPortfolio,
  runReachability,
  runScanInput,
  runSingleCve,
  runUpdateOutdated,
  runValidatePatch,
  runReconcilePatches,
  runInteractiveTriage,
  runInit,
  runPlan,
  runRunsApply,
  runRunsList,
  runRunsResume,
  runRunsRollback,
  runRunsShow,
  runRunsVerify,
  type RunsOptions as RunsCliOptions,
} from "./runners.js";
import type { CommandOptions } from "./types.js";
import { isCveId } from "./types.js";
import { validateOutputFormat, validateSharedCommandOptions } from "./validators.js";

/**
 * Combine a subcommand's options with any root options given before it.
 * A value the user explicitly typed always beats a default; between two explicit values the more
 * specific (subcommand) one wins. Plain `optsWithGlobals()` lets the root's defaults override the
 * subcommand's explicit flags.
 */
function mergeCommandOptions(command: Command): CommandOptions {
  const chain: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent) {
    chain.unshift(current);
  }

  const merged: Record<string, unknown> = {};
  const explicit = new Set<string>();
  for (const cmd of chain) {
    for (const [key, value] of Object.entries(cmd.opts())) {
      const isExplicit = cmd.getOptionValueSource(key) === "cli";
      if (isExplicit || !explicit.has(key)) merged[key] = value;
      if (isExplicit) explicit.add(key);
    }
  }
  return merged as unknown as CommandOptions;
}

const parseBooleanFlag = (value: string): boolean => value === "true";

function addSharedOptions(
  program: Command,
  includeInput = false,
  includeSimulationMode = true,
): Command {
  program
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--dry-run", OPTION_DESCRIPTIONS.dryRun)
    .option("--preview", OPTION_DESCRIPTIONS.preview)
    .option("--run-tests", OPTION_DESCRIPTIONS.runTests)
    .option(
      "--typecheck",
      "Enable typecheck validation (e.g. tsc --noEmit or npm run typecheck) after patching",
    )
    .option("-i, --interactive", "Launch interactive developer CLI triage workflow")

    .option("--model <name>", OPTION_DESCRIPTIONS.model)
    .option(
      "--patch-confidence-low <value>",
      OPTION_DESCRIPTIONS.patchConfidenceThresholdLow,
      (value: string) => Number.parseFloat(value),
    )
    .option(
      "--patch-confidence-medium <value>",
      OPTION_DESCRIPTIONS.patchConfidenceThresholdMedium,
      (value: string) => Number.parseFloat(value),
    )
    .option(
      "--patch-confidence-high <value>",
      OPTION_DESCRIPTIONS.patchConfidenceThresholdHigh,
      (value: string) => Number.parseFloat(value),
    )
    .option("--request-id <id>", OPTION_DESCRIPTIONS.requestId)
    .option("--session-id <id>", OPTION_DESCRIPTIONS.sessionId)
    .option("--parent-run-id <id>", OPTION_DESCRIPTIONS.parentRunId)
    .option("--idempotency-key <key>", OPTION_DESCRIPTIONS.idempotencyKey)
    .option("--resume", OPTION_DESCRIPTIONS.resume)
    .option("--actor <name>", OPTION_DESCRIPTIONS.actor)
    .option("--source <src>", `${OPTION_DESCRIPTIONS.source}: cli|sdk|mcp|openapi|unknown`)
    .option("--direct-dependencies-only", OPTION_DESCRIPTIONS.directDependenciesOnly)
    .option("--prefer-version-bump", OPTION_DESCRIPTIONS.preferVersionBump)
    .option("--install-mode <mode>", OPTION_DESCRIPTIONS.installMode)
    .option(
      "--install-prefer-offline <value>",
      `${OPTION_DESCRIPTIONS.installPreferOffline} (true|false)`,
      parseBooleanFlag,
    )
    .option(
      "--enforce-frozen-lockfile <value>",
      `${OPTION_DESCRIPTIONS.enforceFrozenLockfile} (true|false)`,
      parseBooleanFlag,
    )
    .option("--workspace <name>", OPTION_DESCRIPTIONS.workspace)
    .option("--audit", OPTION_DESCRIPTIONS.audit)
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--evidence", OPTION_DESCRIPTIONS.evidence, true)
    .option("--no-evidence", "Disable evidence file output")
    .option("--ci", "Enable CI behavior (non-zero exit on failed remediations)")
    .option("--output-format <format>", "Output format: text|json|sarif", "text")
    .option("--kev-mandatory", OPTION_DESCRIPTIONS.kevMandatory)
    .option("--epss-threshold <value>", OPTION_DESCRIPTIONS.epssThreshold, (v: string) =>
      Number.parseFloat(v),
    )
    .option("--suppressions-file <path>", OPTION_DESCRIPTIONS.suppressionsFile)
    .option("--sla-check", OPTION_DESCRIPTIONS.slaCheck)
    .option("--skip-unreachable", OPTION_DESCRIPTIONS.skipUnreachable)
    .option(
      "--min-confidence-for-auto-apply <value>",
      OPTION_DESCRIPTIONS.dispositionPolicyMinConfidenceForAutoApply,
      (v: string) => Number.parseFloat(v),
    )
    .option("--hold-for-transitive", OPTION_DESCRIPTIONS.dispositionPolicyHoldForTransitive)
    .option("--escalate-on-kev", OPTION_DESCRIPTIONS.dispositionPolicyEscalateOnKev)
    .option("--containment-mode", OPTION_DESCRIPTIONS.containmentMode)
    .option("--campaign-mode", OPTION_DESCRIPTIONS.campaignMode)
    .option("--offline", OPTION_DESCRIPTIONS.offlineIntelligence)
    .option("--intelligence-snapshot <path>", OPTION_DESCRIPTIONS.intelligenceSnapshotPath)
    .option("--create-change-request", OPTION_DESCRIPTIONS.createChangeRequest)
    .option("--change-request-provider <provider>", OPTION_DESCRIPTIONS.changeRequestProvider)
    .option("--change-request-grouping <grouping>", OPTION_DESCRIPTIONS.changeRequestGrouping)
    .option("--change-request-repository <repository>", OPTION_DESCRIPTIONS.changeRequestRepository)
    .option("--change-request-base-branch <branch>", OPTION_DESCRIPTIONS.changeRequestBaseBranch)
    .option(
      "--change-request-branch-prefix <prefix>",
      OPTION_DESCRIPTIONS.changeRequestBranchPrefix,
    )
    .option("--change-request-title-prefix <prefix>", OPTION_DESCRIPTIONS.changeRequestTitlePrefix)
    .option("--proof-of-fix", OPTION_DESCRIPTIONS.proofOfFix)
    .option("--require-proof-of-fix", OPTION_DESCRIPTIONS.requireProofOfFix)
    .option("--reproduction-test <path>", OPTION_DESCRIPTIONS.reproductionTest)
    .option("--breaking-change-refactor", OPTION_DESCRIPTIONS.breakingChangeRefactor);

  if (includeSimulationMode) {
    program.option("--simulation-mode", OPTION_DESCRIPTIONS.simulationMode);
  }

  if (includeInput) {
    program.option("--input <path>", `${OPTION_DESCRIPTIONS.inputPath} (scanner-first mode)`);
  }

  return program;
}

const runsOptions = (command: Command): Command =>
  command
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text");

const runsAction =
  (name: string, run: (args: string[], opts: RunsCliOptions) => Promise<void>) =>
  async (...received: unknown[]) => {
    const command = received.at(-1) as Command;
    const args = received.slice(0, -2).filter((arg): arg is string => typeof arg === "string");
    const merged = mergeCommandOptions(command) as unknown as RunsCliOptions;
    validateOutputFormat(merged.outputFormat, ["text", "json"], `runs ${name}`);
    await run(args, merged);
  };

export function createProgram(): Command {
  const program = new Command();

  program
    .name("autoremediator")
    .description("Scanner-first Node.js vulnerability auto-remediation tool")
    .version(PACKAGE_VERSION)
    // Root options are only valid before a subcommand. Without this, the root swallows flags such as
    // `--cwd` and `--output-format` typed after `reachability`/`diff`/`patches`, and the subcommand
    // silently runs with its defaults.
    .enablePositionalOptions()
    .showHelpAfterError();

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

  program
    .command("init")
    .description("Set up the project: policy file, agent MCP configuration and instructions")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--hosts <list>", "Agent hosts to configure, comma-separated: claude-code,cursor,vscode,codex,gemini,copilot")
    .option("--ci", "Also write a weekly remediation workflow (GitHub Actions)")
    .option("--no-policy", "Do not write the policy file")
    .option("--no-agents-md", "Do not add a section to AGENTS.md")
    .option("--yes", "Write the changes without asking")
    .option("--check", "Report what is out of date and exit 1 if anything is; writes nothing")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: Parameters<typeof runInit>[0]) => {
      validateOutputFormat(opts.outputFormat, ["text", "json"], "init");
      await runInit(opts);
    });

  const runs = program
    .command("runs")
    .description("List, apply, resume and roll back recorded plans and runs");

  runsOptions(
    runs
      .command("list")
      .description("List recorded runs, newest first")
      .option("--status <status>", "Only runs in this state")
      .option("--limit <n>", "Show at most this many", (value: string) => Number.parseInt(value, 10)),
  ).action(runsAction("list", async (_args, opts) => runRunsList(opts)));

  runsOptions(
    runs
      .command("show")
      .description("Show a run's plan, item outcomes and ledger check")
      .argument("<runId>", "Run id"),
  ).action(runsAction("show", async ([runId], opts) => runRunsShow(runId!, opts)));

  runsOptions(
    runs
      .command("apply")
      .description("Apply a plan, after checking the project still matches it")
      .argument("[runId]", "Run id (or use --plan-id)")
      .option("--plan-id <id>", "Plan id, instead of a run id")
      .option("--item <id...>", "Apply only these plan items")
      .option("--no-verify", "Do not verify each item after applying it")
      .option("--repair", "Have an agent repair the project when an upgrade breaks it (needs a model)")
      .option("--no-repair", "Never use an agent, even if a model is configured")
      .option("--model <name>", OPTION_DESCRIPTIONS.model)
      .option("--max-repair-rounds <n>", "Times the verifier's findings go back to the agent (default 3)", (value: string) => Number.parseInt(value, 10)),
  ).action(runsAction("apply", async ([runId], opts) => runRunsApply(runId, opts)));

  runsOptions(
    runs
      .command("verify")
      .description("Check a run's project with the verifier: scope, policy, install, advisories, tests")
      .argument("<runId>", "Run id")
      .option("--check <name...>", "Run only these checks")
      .option("--offline", "Skip checks that need the network"),
  ).action(runsAction("verify", async ([runId], opts) => runRunsVerify(runId!, opts)));

  runsOptions(
    runs
      .command("resume")
      .description("Continue an interrupted or partial run, skipping items already applied")
      .argument("<runId>", "Run id"),
  ).action(runsAction("resume", async ([runId], opts) => runRunsResume(runId!, opts)));

  runsOptions(
    runs
      .command("rollback")
      .description("Restore the manifests and lockfiles a run changed")
      .argument("<runId>", "Run id")
      .option("--force", "Roll back even if the project changed since the run's last step"),
  ).action(runsAction("rollback", async ([runId], opts) => runRunsRollback(runId!, opts)));

  const patches = program
    .command("patches")
    .description("Inspect and validate stored patch artifacts");

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

  program
    .command("reachability")
    .description("Perform AST call-graph reachability analysis for a package or vulnerable symbol")
    .requiredOption("--package <name>", "Target package name to search")
    .option("--symbol <name>", "Optional specific vulnerable function or export symbol to check")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(
      async (opts: { cwd?: string; package: string; symbol?: string; outputFormat?: string }) => {
        validateOutputFormat(
          (opts.outputFormat ?? "text") as "text" | "json",
          ["text", "json"],
          "reachability",
        );
        await runReachability(opts);
      },
    );

  program
    .command("evaluate <package>")
    .description(
      "Pre-flight security evaluator for npm packages before installation (e.g. evaluate express@4.18.2)",
    )
    .option("--pkg-version <version>", "Package version to evaluate")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(
      async (pkg: string, opts: { cwd?: string; pkgVersion?: string; outputFormat?: string }) => {
        validateOutputFormat(
          (opts.outputFormat ?? "text") as "text" | "json",
          ["text", "json"],
          "evaluate",
        );
        let targetName = pkg;
        let targetVersion = opts.pkgVersion;

        // Handle scoped and unscoped package@version syntax: e.g. "express@4.18.2" or "@types/node@20.0.0"
        const lastAt = pkg.lastIndexOf("@");
        if (lastAt > 0 && !targetVersion) {
          targetName = pkg.slice(0, lastAt);
          targetVersion = pkg.slice(lastAt + 1);
        }

        await runEvaluate(targetName, {
          cwd: opts.cwd,
          version: targetVersion,
          outputFormat: opts.outputFormat,
        });
      },
    );

  program
    .command("diff")
    .description("Git-aware delta vulnerability scan against base git reference or working tree")
    .option("--base <ref>", "Git base reference (default: HEAD)", "HEAD")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--ci", "Enable CI exit code behavior on degraded security posture")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: { cwd?: string; base?: string; outputFormat?: string; ci?: boolean }) => {
      validateOutputFormat(
        (opts.outputFormat ?? "text") as "text" | "json",
        ["text", "json"],
        "diff",
      );
      await runDiffAudit(opts);
    });

  program
    .command("triage [input]")
    .description("Interactively triage discovered vulnerabilities step-by-step")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--patches-dir <path>", OPTION_DESCRIPTIONS.patchesDir)
    .option("--format <format>", OPTION_DESCRIPTIONS.format, "auto")
    .option("--run-tests", OPTION_DESCRIPTIONS.runTests)
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .action(async (inputArg: string | undefined, opts: CommandOptions) => {
      await runInteractiveTriage(inputArg ? inputArg : opts, opts);
    });

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

  return program;
}
