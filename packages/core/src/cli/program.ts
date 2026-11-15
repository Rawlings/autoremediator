import { existsSync } from "node:fs";

import { Command } from "commander";

import { HOOK_HOSTS, type HookHost } from "../api/guard/hook.js";
import { OPTION_DESCRIPTIONS } from "../api/index.js";
import { PACKAGE_VERSION } from "../version.js";
import { type AutonomyCliOptions, runAutonomy } from "./autonomy.js";
import {
  runAssess,
  runDiffAudit,
  runEvaluate,
  runSymbols,
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
  runHook,
  runGuard,
  runGuardHook,
  runDiet,
  type DietCliOptions,
  runPlan,
  runRunsApply,
  runRunsList,
  runRunsResume,
  runRunsRollback,
  runRunsShow,
  runRunsVerify,
  type RunsOptions as RunsCliOptions,
} from "./runners.js";
import { addRecipesCommand } from "./recipes.js";
import { runBisect, type BisectCliOptions } from "./bisect.js";
import { runTraceCommand, type TraceRunCommandOptions } from "./trace.js";
import { registerIncidentCommands } from "./incident-commands.js";
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

const hookOptions = (command: Command): Command =>
  command
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--hooks <list>", "Hooks to handle, comma-separated: pre-push,post-merge (default both)")
    .option("--manager <name>", "Hook manager to write for: husky|lefthook|pre-commit|git (default: detected)")
    .option("--output-format <format>", "Output format: text|json", "text");
const hookAction =
  (mode: "install" | "uninstall" | "status") =>
  async (...received: unknown[]) => {
    const merged = mergeCommandOptions(received.at(-1) as Command) as unknown as Parameters<typeof runHook>[1];
    validateOutputFormat(merged.outputFormat, ["text", "json"], `hook ${mode}`);
    await runHook(mode, merged);
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
    .command("guard [packages...]")
    .description(
      "Judge npm packages before installing them: existence, malware, look-alike names, release age, install scripts, provenance, vulnerabilities. Exits 0 clear, 3 check first, 4 blocked",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--min-age-hours <hours>", "Block releases younger than this (default 72, 0 turns it off)", (value: string) =>
      Number.parseFloat(value),
    )
    .option("--offline", "Skip the OSV malware and advisory lookups")
    .option("--git-diff", "Check the dependencies added or changed in package.json since --base instead of naming packages")
    .option("--base <ref>", "With --git-diff: git ref to compare with (default HEAD; a branch is compared at the merge base)")
    .option("--include-transitive", "With --git-diff: also check packages only the lockfile gained")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (packages: string[], opts: Parameters<typeof runGuard>[1]) => {
      validateOutputFormat(opts.outputFormat, ["text", "json"], "guard");
      await runGuard(packages, opts);
    });

  program
    .command("diet")
    .description(
      "Report what the project could stop depending on: unused dependencies, micro-packages a Node built-in replaces, duplicate versions, and an attack-surface score. With --apply, remove only the certainly-unused dependencies, verify, and roll back on any failure",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--apply", "Remove the certainly-unused dependencies through npm or pnpm, then verify and roll back if any check fails")
    .option("--run-tests", "With --apply: also run the project's tests during verification")
    .option("--no-typecheck", "With --apply: skip the type check during verification")
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--package-manager <name>", "With --apply: package manager to use (auto-detected from the lockfile)")
    .option("--verbose", "List every duplicate and every indirectly used dependency")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: DietCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "diet");
      if (!opts.apply && (opts.runTests || opts.typecheck === false || opts.packageManager)) {
        throw new Error("--run-tests, --no-typecheck and --package-manager only apply with --apply.");
      }
      await runDiet(opts);
    });

  program
    .command("guard-hook")
    .description("Agent pre-command hook (Claude Code, Cursor, Copilot): reads the hook JSON on stdin and answers allow, ask or deny for package installs")
    .option("--host <host>", `Agent host whose hook format to speak: ${HOOK_HOSTS.join("|")}`, "claude-code")
    .action(async (opts: { host: string }) => {
      if (!HOOK_HOSTS.includes(opts.host as HookHost)) {
        throw new Error(`Unknown host "${opts.host}". Use one of: ${HOOK_HOSTS.join(", ")}.`);
      }
      await runGuardHook(opts.host as HookHost);
    });

  registerIncidentCommands(program);

  program
    .command("init")
    .description("Set up the project: policy file, agent MCP configuration and instructions")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--hosts <list>", "Agent hosts to configure, comma-separated: claude-code,cursor,vscode,codex,gemini,copilot")
    .option("--ci", "Also write a weekly remediation workflow (GitHub Actions)")
    .option("--guard", "Also install guard hooks (Claude Code, Cursor, Copilot) and a pnpmfile (pnpm projects) that check package installs")
    .option("--no-policy", "Do not write the policy file")
    .option("--no-agents-md", "Do not add a section to AGENTS.md")
    .option("--yes", "Write the changes without asking")
    .option("--check", "Report what is out of date and exit 1 if anything is; writes nothing")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: Parameters<typeof runInit>[0]) => {
      validateOutputFormat(opts.outputFormat, ["text", "json"], "init");
      await runInit(opts);
    });

  const hook = program
    .command("hook")
    .description("Install git hooks that check dependency changes: pre-push blocks a risky push, post-merge advises");
  hookOptions(
    hook
      .command("install")
      .description("Add the hooks (reports a diff; writes only with --yes or after you confirm)")
      .option("--yes", "Write the changes without asking"),
  ).action(hookAction("install"));
  hookOptions(
    hook
      .command("uninstall")
      .description("Remove only the blocks and entries Autoremediator wrote")
      .option("--yes", "Write the changes without asking"),
  ).action(hookAction("uninstall"));
  hookOptions(
    hook.command("status").description("Report installed, missing or modified hooks; exits 1 on drift"),
  ).action(hookAction("status"));

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

  addRecipesCommand(program);
  const autonomy = program
    .command("autonomy")
    .description("Show the autonomy level this repository has earned, and why");
  for (const [mode, text] of [
    ["status", "Show the level in force, the ceiling, the level earned and what the next one needs"],
    ["explain", "Explain the level: the evidence, the settings and every promotion and demotion with its cause"],
  ] as const) {
    autonomy
      .command(mode)
      .description(text)
      .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
      .option("--policy <path>", "Path to the policy file (default: .github/autoremediator.yml)")
      .option("--output-format <format>", "Output format: text|json", "text")
      .action(async (_opts: AutonomyCliOptions, command: Command) => {
        const merged = mergeCommandOptions(command) as unknown as AutonomyCliOptions;
        validateOutputFormat(merged.outputFormat, ["text", "json"], `autonomy ${mode}`);
        await runAutonomy(mode, merged);
      });
  }

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
    .option("--trace-file <path>", OPTION_DESCRIPTIONS.traceFile)
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(
      async (opts: {
        cwd?: string;
        package: string;
        symbol?: string;
        traceFile?: string;
        outputFormat?: string;
      }) => {
        validateOutputFormat(
          (opts.outputFormat ?? "text") as "text" | "json",
          ["text", "json"],
          "reachability",
        );
        await runReachability(opts);
      },
    );

  const trace = program
    .command("trace")
    .description("Record which dependencies a command, usually your tests, loads and calls")
    .enablePositionalOptions();
  trace
    .command("run")
    .description(
      "Run a command with the trace hook in every Node.js process it starts, then write the trace (use -- before the command)",
    )
    .argument("<command...>", "The command to run, for example: node --test")
    .passThroughOptions()
    .option("--packages <list>", "Packages to watch, comma-separated (required with --calls)")
    .option("--calls", "Count calls to the exported functions of --packages (adds overhead)")
    .option("--out <path>", "Where to write the trace (default: .autoremediator/trace.json)")
    .option("--timeout <seconds>", "Stop the command after this many seconds", (value: string) =>
      Number.parseInt(value, 10),
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (command: string[], opts: TraceRunCommandOptions) => {
      validateOutputFormat((opts.outputFormat ?? "text") as "text" | "json", ["text", "json"], "trace run");
      await runTraceCommand(command, opts);
    });

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
    .command("assess <package>")
    .description(
      "How likely is upgrading a package to break this project? Compares two versions' public API, engines, module format and peers against the project's own usage (e.g. assess lodash --from 4.17.20 --to 4.17.21)",
    )
    .requiredOption("--from <version>", "Version the project uses now")
    .requiredOption("--to <version>", "Version being considered")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(
      async (
        pkg: string,
        opts: { cwd?: string; from: string; to: string; outputFormat?: string },
      ) => {
        validateOutputFormat(
          (opts.outputFormat ?? "text") as "text" | "json",
          ["text", "json"],
          "assess",
        );
        await runAssess(pkg, opts);
      },
    );

  program
    .command("symbols <package>")
    .description(
      "Heuristic: list the exports that changed between a vulnerable version and its fix, ranked and checked for reachability from this project",
    )
    .requiredOption("--from <version>", "The vulnerable version")
    .requiredOption("--to <version>", "The version that fixes it")
    .option("--advisory-text <text>", "Advisory summary or details, used only to rank candidates")
    .option("--cwe <ids>", "Comma-separated CWE ids (CWE-1333,CWE-94), used only to rank candidates")
    .option("--limit <n>", "Largest number of candidates to show", (value) => Number.parseInt(value, 10))
    .option("--no-reachability", "Skip checking candidates against this project's source")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(
      async (
        pkg: string,
        opts: {
          cwd?: string;
          from: string;
          to: string;
          advisoryText?: string;
          cwe?: string;
          limit?: number;
          reachability?: boolean;
          outputFormat?: string;
        },
      ) => {
        validateOutputFormat(
          (opts.outputFormat ?? "text") as "text" | "json",
          ["text", "json"],
          "symbols",
        );
        await runSymbols(pkg, opts);
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
    .command("bisect")
    .description(
      "Find which package update in the lockfile diff between a good and a bad git ref breaks a command, in isolated worktrees. Runs --command with your privileges. Exits 0 when a culprit is found, 1 otherwise",
    )
    .requiredOption("--good <ref>", "Git ref (commit, tag, branch) where the command passes")
    .option("--bad <ref>", "Git ref where the command fails (default: HEAD; committed state, not the working tree)")
    .requiredOption("--command <command>", "Shell command to run after installing; exit code 0 means pass")
    .option("--timeout <seconds>", "Kill the command after this long and count it as failing (default: 600)", (value: string) =>
      Number.parseFloat(value),
    )
    .option("--max-steps <n>", "Evaluate at most this many candidate states (default: 30)", (value: string) =>
      Number.parseInt(value, 10),
    )
    .option("--package-manager <name>", "npm|pnpm|yarn (default: from the lockfile)")
    .option("--ignore-scripts", "Pass --ignore-scripts to every install so package install scripts do not run")
    .option("--apply", "Apply the recommended pin through the run machinery instead of only planning it")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: BisectCliOptions) => {
      validateOutputFormat(opts.outputFormat, ["text", "json"], "bisect");
      await runBisect(opts);
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
