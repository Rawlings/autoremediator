import type { Command } from "commander";

import {
  applyPlan,
  getRun,
  listRuns,
  resumeRun,
  rollbackRun,
  type CheckName,
  type RunStatus,
  verifyRun,
  OPTION_DESCRIPTIONS,
} from "../../../api/index.js";
import { mergeCommandOptions } from "../options.js";
import { logJson } from "../output.js";
import type { OutputFormat } from "../types.js";
import { validateOutputFormat } from "../validators.js";
import { formatAutonomyLine } from "./autonomy.js";

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
    process.stdout.write(
      `Plan ${plan.planId}: ${plan.items.length} change(s), ${plan.skipped.length} skipped\n`,
    );
    for (const item of plan.items) {
      const outcome = details.items.find((candidate) => candidate.itemId === item.itemId);
      process.stdout.write(
        `  ${outcome?.status ?? "pending".padEnd(7)}  ${item.packageName} ${item.fromVersion} -> ${item.toVersion} (${item.strategy}${item.rollback ? ", rollback" : ""}) [${item.itemId}]\n`,
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

const runsOptions = (command: Command): Command =>
  command
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text");

const runsAction =
  (name: string, run: (args: string[], opts: RunsOptions) => Promise<void>) =>
  async (...received: unknown[]) => {
    const command = received.at(-1) as Command;
    const args = received.slice(0, -2).filter((arg): arg is string => typeof arg === "string");
    const merged = mergeCommandOptions(command) as unknown as RunsOptions;
    validateOutputFormat(merged.outputFormat, ["text", "json"], `runs ${name}`);
    await run(args, merged);
  };

export function registerRunsCommands(program: Command): void {
  const runs = program
    .command("runs")
    .description("List, apply, resume and roll back recorded plans and runs");
  runsOptions(
    runs
      .command("list")
      .description("List recorded runs, newest first")
      .option("--status <status>", "Only runs in this state")
      .option("--limit <n>", "Show at most this many", (value: string) =>
        Number.parseInt(value, 10),
      ),
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
      .option(
        "--repair",
        "Have an agent repair the project when an upgrade breaks it (needs a model)",
      )
      .option("--no-repair", "Never use an agent, even if a model is configured")
      .option("--model <name>", OPTION_DESCRIPTIONS.model)
      .option(
        "--max-repair-rounds <n>",
        "Times the verifier's findings go back to the agent (default 3)",
        (value: string) => Number.parseInt(value, 10),
      ),
  ).action(runsAction("apply", async ([runId], opts) => runRunsApply(runId, opts)));
  runsOptions(
    runs
      .command("verify")
      .description(
        "Check a run's project with the verifier: scope, policy, install, advisories, tests",
      )
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
}
