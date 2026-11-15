/** Option helpers every command registration shares. */
import type { Command } from "commander";

import { OPTION_DESCRIPTIONS } from "../../api/index.js";
import type { CommandOptions } from "./types.js";

export function mergeCommandOptions(command: Command): CommandOptions {
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

/** Where and how a run executes: project, package manager, dry run, tests, typecheck. */
function addRunOptions(program: Command): Command {
  return program
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
    .option("-i, --interactive", "Launch interactive developer CLI triage workflow");
}

/** The model and the confidence a generated patch needs. */
function addModelOptions(program: Command): Command {
  return program
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
    );
}

/** Ids that tie this run to a caller's session, plus idempotency and resume. */
function addCorrelationOptions(program: Command): Command {
  return program
    .option("--request-id <id>", OPTION_DESCRIPTIONS.requestId)
    .option("--session-id <id>", OPTION_DESCRIPTIONS.sessionId)
    .option("--parent-run-id <id>", OPTION_DESCRIPTIONS.parentRunId)
    .option("--idempotency-key <key>", OPTION_DESCRIPTIONS.idempotencyKey)
    .option("--resume", OPTION_DESCRIPTIONS.resume)
    .option("--actor <name>", OPTION_DESCRIPTIONS.actor)
    .option("--source <src>", `${OPTION_DESCRIPTIONS.source}: cli|sdk|mcp|openapi|unknown`);
}

/** How dependencies are installed and which workspace is touched. */
function addInstallOptions(program: Command): Command {
  return program
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
    .option("--workspace <name>", OPTION_DESCRIPTIONS.workspace);
}

/** The policy file, evidence and CI output. */
function addPolicyAndOutputOptions(program: Command): Command {
  return program
    .option("--audit", OPTION_DESCRIPTIONS.audit)
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--evidence", OPTION_DESCRIPTIONS.evidence, true)
    .option("--no-evidence", "Disable evidence file output")
    .option("--ci", "Enable CI behavior (non-zero exit on failed remediations)")
    .option("--output-format <format>", "Output format: text|json|sarif", "text");
}

/** Exploit-signal gates and how results are classified. */
function addExploitAndDispositionOptions(program: Command): Command {
  return program
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
    .option("--intelligence-snapshot <path>", OPTION_DESCRIPTIONS.intelligenceSnapshotPath);
}

/** Opening a pull or merge request for the fixes. */
function addChangeRequestOptions(program: Command): Command {
  return program
    .option("--create-change-request", OPTION_DESCRIPTIONS.createChangeRequest)
    .option("--change-request-provider <provider>", OPTION_DESCRIPTIONS.changeRequestProvider)
    .option("--change-request-grouping <grouping>", OPTION_DESCRIPTIONS.changeRequestGrouping)
    .option("--change-request-repository <repository>", OPTION_DESCRIPTIONS.changeRequestRepository)
    .option("--change-request-base-branch <branch>", OPTION_DESCRIPTIONS.changeRequestBaseBranch)
    .option(
      "--change-request-branch-prefix <prefix>",
      OPTION_DESCRIPTIONS.changeRequestBranchPrefix,
    )
    .option("--change-request-title-prefix <prefix>", OPTION_DESCRIPTIONS.changeRequestTitlePrefix);
}

/** Proof of fix, refactoring and memory. */
function addProofOptions(program: Command): Command {
  return program
    .option("--proof-of-fix", OPTION_DESCRIPTIONS.proofOfFix)
    .option("--require-proof-of-fix", OPTION_DESCRIPTIONS.requireProofOfFix)
    .option("--reproduction-test <path>", OPTION_DESCRIPTIONS.reproductionTest)
    .option("--breaking-change-refactor", OPTION_DESCRIPTIONS.breakingChangeRefactor)
    .option(
      "--ignore-memory",
      "Plan as if the repository's memory were empty: ignore pinned packages and rejected upgrades in .autoremediator/memory.md",
    );
}

export function addSharedOptions(
  program: Command,
  includeInput = false,
  includeSimulationMode = true,
): Command {
  addProofOptions(
    addChangeRequestOptions(
      addExploitAndDispositionOptions(
        addPolicyAndOutputOptions(
          addInstallOptions(addCorrelationOptions(addModelOptions(addRunOptions(program)))),
        ),
      ),
    ),
  );

  if (includeSimulationMode) {
    program.option("--simulation-mode", OPTION_DESCRIPTIONS.simulationMode);
  }

  if (includeInput) {
    program.option("--input <path>", `${OPTION_DESCRIPTIONS.inputPath} (scanner-first mode)`);
  }

  return program;
}

export const parseBooleanFlag = (value: string): boolean => value === "true";
