import {
  applyPlan,
  getRun,
  listRuns,
  resumeRun,
  rollbackRun,
  type CheckName,
  type RunStatus,
  verifyRun,
} from "../../../api/index.js";
import { logJson } from "../output.js";
import type { OutputFormat } from "../types.js";
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
