import type { Command } from "commander";

import {
  applyFreshness,
  freshnessReport,
  OPTION_DESCRIPTIONS,
  planFreshnessStep,
  type ApplyFreshnessOptions,
  type ApplyFreshnessResult,
  type FreshnessClimb,
  type FreshnessPlanResult,
  type FreshnessReport,
} from "../api/index.js";
import { CHANGE_REQUEST_PROVIDER_VALUES, type ChangeRequestProvider } from "../platform/types.js";
import { logJson } from "./output.js";
import { validateOutputFormat } from "./validators.js";

export interface FreshnessCliOptions {
  cwd: string;
  policy?: string;
  packageManager?: string;
  package?: string;
  assess?: boolean;
  allowHigh?: boolean;
  ignoreMemory?: boolean;
  plan?: boolean;
  apply?: boolean;
  maxSteps?: number;
  runTests?: boolean;
  typecheck?: boolean;
  model?: string;
  /** `--no-repair` arrives as false. */
  repair?: boolean;
  maxRepairRounds?: number;
  createChangeRequest?: boolean;
  changeRequestProvider?: string;
  changeRequestRepository?: string;
  changeRequestBaseBranch?: string;
  changeRequestBranchPrefix?: string;
  outputFormat: string;
}

const packagesOf = (opts: FreshnessCliOptions): string[] | undefined =>
  opts.package
    ? opts.package
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
    : undefined;

function describeLimits(report: FreshnessReport): string {
  const policy = report.policy;
  if (!policy) return "no `freshness` policy";
  const limits = [
    policy.maxMajorsBehind === undefined ? "" : `maxMajorsBehind ${policy.maxMajorsBehind}`,
    policy.maxMinorsBehind === undefined ? "" : `maxMinorsBehind ${policy.maxMinorsBehind}`,
    policy.maxAgeDays === undefined ? "" : `maxAgeDays ${policy.maxAgeDays}`,
  ].filter(Boolean);
  return `${limits.join(", ")}${policy.ignore.length > 0 ? `; ignoring ${policy.ignore.join(", ")}` : ""}`;
}

function distanceText(entry: FreshnessReport["packages"][number]): string {
  const parts = [
    entry.majorsBehind ? `${entry.majorsBehind} major${entry.majorsBehind === 1 ? "" : "s"}` : "",
    entry.minorsBehind ? `${entry.minorsBehind} minor${entry.minorsBehind === 1 ? "" : "s"}` : "",
    entry.patchesBehind
      ? `${entry.patchesBehind} patch${entry.patchesBehind === 1 ? "" : "es"}`
      : "",
  ].filter(Boolean);
  const extra = [
    entry.releasesBehind === undefined
      ? ""
      : `${entry.releasesBehind} release${entry.releasesBehind === 1 ? "" : "s"}`,
    entry.ageDays === undefined ? "" : `installed ${entry.ageDays} days old`,
  ].filter(Boolean);
  return `${parts.join(", ")}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`;
}

function climbLine(climb: FreshnessClimb): string {
  const path = [climb.installed, ...climb.steps.map((step) => step.toVersion)].join(" -> ");
  const rating = climb.assessment
    ? ` [${climb.assessment.breakability}${climb.assessment.score === undefined ? "" : `, ${climb.assessment.score} points`}]`
    : "";
  return `  ${climb.packageName}: ${path}${rating}${climb.held ? `  HELD: ${climb.held.message}` : ""}`;
}

export function renderFreshnessReport(report: FreshnessReport): string {
  const lines: string[] = [];
  const { counts } = report;
  lines.push(
    `Freshness ${report.score}/100: ${counts.direct} direct dependenc${counts.direct === 1 ? "y" : "ies"}, ${counts.current} current, ${counts.behind} behind` +
      `${counts.ignored > 0 ? `, ${counts.ignored} ignored` : ""}${counts.notInstalled > 0 ? `, ${counts.notInstalled} not installed` : ""}.`,
  );
  lines.push(`Policy: ${describeLimits(report)}.`);
  const behind = report.packages.filter((entry) => entry.status === "behind");
  if (behind.length > 0) {
    lines.push("", "Behind:");
    for (const entry of behind) {
      lines.push(
        `  ${entry.name} ${entry.installed} -> ${entry.latest}: ${distanceText(entry)}${entry.exceeds.length > 0 ? `  PAST POLICY: ${entry.exceeds.join("; ")}` : ""}${entry.unknownAge ? `  AGE UNKNOWN: ${entry.unknownAge}` : ""}`,
      );
    }
  }
  if (report.climbs.length > 0) {
    lines.push(
      "",
      "Climb, safest first (one jump per step; only the first jump of each is taken at a time):",
    );
    for (const climb of report.climbs) lines.push(climbLine(climb));
  }
  for (const entry of report.unplanned)
    lines.push("", `Not planned: ${entry.packageName}: ${entry.reason}`);
  for (const note of report.notes) lines.push("", `Note: ${note}`);
  return `${lines.join("\n")}\n`;
}

function renderPlan(result: FreshnessPlanResult): string {
  const lines: string[] = [];
  if (result.planned) {
    const { step } = result.planned;
    lines.push(
      `Planned step ${step.index} of ${step.of}: ${step.packageName} ${step.fromVersion} -> ${step.toVersion} (${step.level}).`,
      `Run ${result.planned.runId}, plan ${result.planned.planId}. Review it with \`autoremediator runs show ${result.planned.runId}\`, apply it with \`autoremediator runs apply ${result.planned.runId}\`.`,
    );
    if (result.planned.assessment) {
      lines.push(
        `Upgrade impact ${result.planned.assessment.breakability}: ${result.planned.assessment.summary}`,
      );
    }
  } else {
    lines.push(result.reason ?? "No step was planned.");
  }
  for (const entry of result.held) lines.push(`Held: ${entry.packageName}: ${entry.reason}`);
  return `${lines.join("\n")}\n`;
}

/** The first few lines of a message; the full text stays in the JSON output. */
function brief(text: string, lines = 3, width = 240): string {
  const kept = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, lines)
    .map((line) => (line.length > width ? `${line.slice(0, width)}...` : line));
  return kept.join(" | ");
}

function renderApply(result: ApplyFreshnessResult): string {
  const lines: string[] = [result.message];
  for (const outcome of result.steps) {
    lines.push(
      `  ${outcome.status === "applied" ? "applied" : "FAILED "} ${outcome.step.packageName} ${outcome.step.fromVersion} -> ${outcome.step.toVersion} (run ${outcome.runId ?? "-"})`,
    );
    if (outcome.status === "failed") {
      lines.push(
        `    ${brief(outcome.message)}`,
        `    rolled back: ${outcome.rolledBack ? "yes" : "no, check the project"}`,
      );
    }
    if (outcome.changeRequest) {
      lines.push(
        outcome.changeRequest.created
          ? `    change request: ${outcome.changeRequest.url ?? outcome.changeRequest.branchName}`
          : `    change request not created: ${outcome.changeRequest.error ?? "unknown reason"}`,
      );
    }
  }
  for (const entry of result.stopped)
    lines.push(`  stopped: ${entry.packageName}: ${brief(entry.reason, 1)}`);
  if (result.remaining.length > 0) lines.push(`  still to do: ${result.remaining.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export async function runFreshness(opts: FreshnessCliOptions): Promise<void> {
  const common = {
    cwd: opts.cwd,
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.packageManager
      ? { packageManager: opts.packageManager as "npm" | "pnpm" | "yarn" }
      : {}),
    ...(packagesOf(opts) ? { packages: packagesOf(opts) } : {}),
    ...(opts.allowHigh ? { allowHigh: true } : {}),
    ...(opts.ignoreMemory ? { ignoreMemory: true } : {}),
    source: "cli" as const,
  };
  const json = opts.outputFormat === "json";

  if (opts.apply) {
    const options: ApplyFreshnessOptions = {
      ...common,
      ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
      ...(opts.runTests ? { runTests: true } : {}),
      ...(opts.typecheck ? { typecheck: true } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.repair === false ? { repair: false } : {}),
      ...(opts.maxRepairRounds ? { repairBudget: { maxRepairRounds: opts.maxRepairRounds } } : {}),
      ...(opts.createChangeRequest
        ? {
            changeRequest: {
              enabled: true,
              provider: (opts.changeRequestProvider ?? "github") as ChangeRequestProvider,
              grouping: "per-package" as const,
              ...(opts.changeRequestRepository ? { repository: opts.changeRequestRepository } : {}),
              ...(opts.changeRequestBaseBranch ? { baseBranch: opts.changeRequestBaseBranch } : {}),
              ...(opts.changeRequestBranchPrefix
                ? { branchPrefix: opts.changeRequestBranchPrefix }
                : {}),
            },
          }
        : {}),
    };
    const result = await applyFreshness(options);
    if (json) logJson(result);
    else process.stdout.write(renderApply(result));
    // A step that did not hold is a failure to a scheduler, even when another step landed.
    process.exitCode = result.status === "failed" || result.status === "partial" ? 1 : 0;
    return;
  }

  if (opts.plan) {
    const result = await planFreshnessStep({
      ...common,
      ...(opts.assess === false ? { assess: false } : {}),
      ...(opts.runTests ? { runTests: true } : {}),
      ...(opts.typecheck ? { typecheck: true } : {}),
    });
    if (json) logJson(result);
    else process.stdout.write(renderPlan(result));
    return;
  }

  const report = await freshnessReport({ ...common, ...(opts.assess ? { assess: true } : {}) });
  if (json) logJson(report);
  else process.stdout.write(renderFreshnessReport(report));
}

/** Register `freshness`. */
export function registerFreshnessCommands(program: Command): void {
  program
    .command("freshness")
    .description(
      "How far behind the latest release the direct dependencies are, a project freshness score, and the smallest verified steps back inside the policy's `freshness` limits. With --apply, takes at most --max-steps steps (default 1), each its own recorded run that is rolled back if it does not verify",
    )
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--policy <path>", OPTION_DESCRIPTIONS.policy)
    .option("--package-manager <name>", OPTION_DESCRIPTIONS.packageManager)
    .option("--package <list>", "Only these direct dependencies, comma-separated")
    .option(
      "--assess",
      "Report only: rate the first step of each climb with assessUpgrade and order them safest first",
    )
    .option("--no-assess", "With --plan: do not rate steps (order by step size only)")
    .option("--allow-high", "Take steps assessUpgrade rates High (held otherwise)")
    .option(
      "--ignore-memory",
      "Plan as if the repository's memory were empty: ignore pinned packages and rejected upgrades in .autoremediator/memory.md",
    )
    .option(
      "--plan",
      "Record the next step as a plan (never applied); review it with `runs show`, apply it with `runs apply`",
    )
    .option(
      "--apply",
      "Take steps now: plan, apply and verify each one, rolling back any that does not hold",
    )
    .option(
      "--max-steps <n>",
      "With --apply: most steps to take in this run (default 1)",
      (value: string) => Number.parseInt(value, 10),
    )
    .option("--run-tests", "With --plan or --apply: run the project's tests for each step")
    .option("--typecheck", "With --plan or --apply: run the project's type check for each step")
    .option("--model <provider:model>", OPTION_DESCRIPTIONS.model)
    .option(
      "--no-repair",
      "With --apply: never use a model to repair a step that breaks the project",
    )
    .option(
      "--max-repair-rounds <n>",
      "With --apply: most feedback rounds per repair (default 3)",
      (value: string) => Number.parseInt(value, 10),
    )
    .option(
      "--create-change-request",
      "With --apply: one change request per step, on its own branch",
    )
    .option("--change-request-provider <provider>", OPTION_DESCRIPTIONS.changeRequestProvider)
    .option("--change-request-repository <repository>", OPTION_DESCRIPTIONS.changeRequestRepository)
    .option("--change-request-base-branch <branch>", OPTION_DESCRIPTIONS.changeRequestBaseBranch)
    .option(
      "--change-request-branch-prefix <prefix>",
      OPTION_DESCRIPTIONS.changeRequestBranchPrefix,
    )
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: FreshnessCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "freshness");
      if (opts.apply && opts.plan) throw new Error("Use --plan or --apply, not both.");
      if (!opts.apply && !opts.plan) {
        const misplaced = [
          opts.maxSteps ? "--max-steps" : "",
          opts.runTests ? "--run-tests" : "",
          opts.typecheck ? "--typecheck" : "",
          opts.model ? "--model" : "",
          opts.createChangeRequest ? "--create-change-request" : "",
        ].filter(Boolean);
        if (misplaced.length > 0)
          throw new Error(`${misplaced.join(", ")} only apply with --plan or --apply.`);
      }
      if (opts.apply && opts.assess === false) {
        throw new Error(
          "--no-assess only applies with --plan: --apply orders and holds steps by their rating.",
        );
      }
      if (
        !opts.createChangeRequest &&
        (opts.changeRequestProvider ||
          opts.changeRequestRepository ||
          opts.changeRequestBaseBranch ||
          opts.changeRequestBranchPrefix)
      ) {
        throw new Error("change-request override flags require --create-change-request.");
      }
      if (
        opts.changeRequestProvider &&
        !CHANGE_REQUEST_PROVIDER_VALUES.includes(
          opts.changeRequestProvider as ChangeRequestProvider,
        )
      ) {
        throw new Error(
          `--change-request-provider must be one of: ${CHANGE_REQUEST_PROVIDER_VALUES.join(", ")} (received: ${opts.changeRequestProvider}).`,
        );
      }
      if (opts.maxSteps !== undefined && (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1)) {
        throw new Error("--max-steps must be a whole number of at least 1.");
      }
      await runFreshness(opts);
    });
}
