/**
 * Planning and applying freshness steps. A step is recorded as an ordinary run with a one-item
 * plan, so `applyPlan`, `verifyRun` and `rollbackRun` work on it exactly as on a security fix: the
 * recorded plan is the approval step, and the verifier, not this module, decides whether it holds.
 */
import type { RemediationReport } from "../../platform/types.js";
import { assertAutonomyAllows, summarizeAutonomy } from "../autonomy/index.js";
import { createChangeRequestsForReports } from "../change-request/index.js";
import { applyPlan, persistPlan, rollbackRun, type RunDeps } from "../runs/index.js";
import { defaultRunDeps } from "../runs/deps.js";
import { defaultFreshnessDeps, type FreshnessDeps } from "./deps.js";
import {
  assessClimbs,
  buildClimbs,
  gatherFreshness,
  reportFrom,
} from "./report.js";
import type {
  ApplyFreshnessOptions,
  ApplyFreshnessResult,
  FreshnessClimb,
  FreshnessPlanResult,
  FreshnessReport,
  FreshnessStep,
  FreshnessStepOutcome,
  PlanFreshnessStepOptions,
  PlannedFreshnessStep,
  StepAssessment,
} from "./types.js";

/**
 * Failed attempts after which one `applyFreshness` call stops trying other packages. A step that
 * fails is rolled back and costs an install and a test run, so a project where everything fails
 * must not spend the whole night finding that out.
 */
export const MAX_FAILED_ATTEMPTS = 3;

/** The pseudo advisory id a step's run is recorded under; it also names the change request branch. */
export const stepRunId = (step: FreshnessStep): string => `FRESHNESS-${step.toVersion}`;

const describeStep = (step: FreshnessStep): string =>
  `${step.packageName} ${step.fromVersion} -> ${step.toVersion} (${step.level}, step ${step.index} of ${step.of})`;

/** The preview report `persistPlan` turns into a one-item plan. */
export function stepReport(
  step: FreshnessStep,
  assessment: StepAssessment | undefined,
  applied = false,
): RemediationReport {
  return {
    cveId: stepRunId(step),
    cveDetails: null,
    vulnerablePackages: [],
    results: [
      {
        packageName: step.packageName,
        strategy: "version-bump",
        fromVersion: step.fromVersion,
        toVersion: step.toVersion,
        applied,
        dryRun: !applied,
        dependencyScope: "direct",
        message: `Freshness step: ${describeStep(step)}${
          assessment ? `; upgrade impact ${assessment.breakability}: ${assessment.summary}` : ""
        }`,
      },
    ],
    summary: `Dependency freshness: ${describeStep(step)}.`,
  };
}

export interface Analysis {
  report: FreshnessReport;
  /** Every climb, ordered, held ones last. */
  climbs: FreshnessClimb[];
  eligible?: FreshnessClimb;
  held: Array<{ packageName: string; reason: string }>;
}

/** Gather, build, rate and order the climbs, leaving out packages in `skip`. */
export async function analyse(
  options: PlanFreshnessStepOptions,
  deps: FreshnessDeps,
  cache: Map<string, Promise<StepAssessment>>,
  skip: ReadonlySet<string> = new Set(),
): Promise<Analysis> {
  const gathered = await gatherFreshness(options, deps);
  const built = buildClimbs(gathered);
  const wanted = built.climbs.filter((climb) => !skip.has(climb.packageName));
  const ordered = await assessClimbs(
    wanted,
    {
      cwd: gathered.cwd,
      policy: gathered.policy,
      allowHigh: options.allowHigh ?? false,
      assess: options.assess ?? true,
    },
    deps,
    cache,
  );
  return {
    report: reportFrom(gathered, ordered, built.unplanned),
    climbs: ordered,
    eligible: ordered.find((climb) => !climb.held),
    held: ordered
      .filter((climb) => climb.held)
      .map((climb) => ({ packageName: climb.packageName, reason: climb.held!.message })),
  };
}

async function record(
  climb: FreshnessClimb,
  options: PlanFreshnessStepOptions,
  cwd: string,
): Promise<PlannedFreshnessStep> {
  const step = climb.steps[0]!;
  const { runId, planId } = await persistPlan(
    stepReport(step, climb.assessment),
    {
      cwd,
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.packageManager ? { packageManager: options.packageManager } : {}),
      ...(options.runTests === undefined ? {} : { runTests: options.runTests }),
      ...(options.typecheck === undefined ? {} : { typecheck: options.typecheck }),
      source: options.source ?? "sdk",
    },
    cwd,
  );
  return { step, ...(climb.assessment ? { assessment: climb.assessment } : {}), runId, planId };
}

/**
 * Record the next freshness step as a plan, for `applyPlan` to carry out after review. The step is
 * the first of the safest climb that is not held; only one plan is recorded because applying it
 * changes the manifests every other plan was made against. Changes nothing in the project.
 */
export async function planFreshnessStep(
  options: PlanFreshnessStepOptions = {},
  deps: FreshnessDeps = defaultFreshnessDeps,
): Promise<FreshnessPlanResult> {
  const cwd = options.cwd ?? process.cwd();
  const analysis = await analyse(options, deps, new Map());

  const autonomy = summarizeAutonomy(cwd, options.policy);
  if (autonomy?.level === "L0") {
    return {
      reason: `Autonomy is L0 (observe): no plan was recorded, so there is nothing to apply.`,
      held: analysis.held,
      report: analysis.report,
    };
  }
  if (!analysis.eligible) {
    return {
      reason: describeNothing(analysis),
      held: analysis.held,
      report: analysis.report,
    };
  }
  const planned = await record(analysis.eligible, options, cwd);
  return { planned, held: analysis.held, report: analysis.report };
}

function describeNothing(analysis: Analysis): string {
  if (!analysis.report.policy) {
    return "The policy has no `freshness` key, so there is no limit to climb towards.";
  }
  if (analysis.climbs.length === 0) {
    return analysis.report.unplanned.length > 0
      ? "Some packages are past the policy but no climb could be made for them (see unplanned)."
      : "Every direct dependency is within the freshness policy.";
  }
  return "Every step that is due is held (see held).";
}

const MAX_STEPS_LIMIT = 50;

/**
 * Take freshness steps, one verified upgrade at a time, at most `maxSteps` of them (default 1).
 * Each step is its own recorded run: planned, applied through `applyPlan` (so the verifier, the
 * project's own checks, agent repair and earned autonomy apply as they do everywhere), and, if it
 * does not hold, taken back out with `rollbackRun` and the package left alone for this call. With
 * `changeRequest`, each applied step becomes its own change request and the working tree returns
 * to where it started.
 */
export async function applyFreshness(
  options: ApplyFreshnessOptions = {},
  deps: FreshnessDeps = defaultFreshnessDeps,
  runDeps: RunDeps = defaultRunDeps,
): Promise<ApplyFreshnessResult> {
  const cwd = options.cwd ?? process.cwd();
  const maxSteps = options.maxSteps ?? 1;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS_LIMIT) {
    throw new Error(`maxSteps must be a whole number from 1 to ${MAX_STEPS_LIMIT}.`);
  }
  // Earned autonomy: below L2 nothing is changed, exactly as for applyPlan.
  assertAutonomyAllows(cwd, options.policy, "apply", "freshness apply");

  const cache = new Map<string, Promise<StepAssessment>>();
  const skip = new Set<string>();
  const stopped: ApplyFreshnessResult["stopped"] = [];
  const outcomes: FreshnessStepOutcome[] = [];
  const awaiting = new Set<string>();
  const failedPackages = new Set<string>();
  let first: FreshnessReport | undefined;
  let last: Analysis | undefined;
  let applied = 0;
  let failed = 0;

  while (applied < maxSteps && failed < MAX_FAILED_ATTEMPTS) {
    const analysis = await analyse(options, deps, cache, skip);
    first ??= analysis.report;
    last = analysis;
    const climb = analysis.eligible;
    if (!climb) break;

    const planned = await record(climb, options, cwd);
    const step = planned.step;
    const base = {
      step,
      ...(planned.assessment ? { assessment: planned.assessment } : {}),
      runId: planned.runId,
      planId: planned.planId,
    };

    const run = await applyPlan(
      {
        cwd,
        runId: planned.runId,
        ...(options.verify === undefined ? {} : { verify: options.verify }),
        ...(options.repair === undefined ? {} : { repair: options.repair }),
        ...(options.model ? { model: options.model } : {}),
        ...(options.repairAgent ? { repairAgent: options.repairAgent } : {}),
        ...(options.repairBudget ? { repairBudget: options.repairBudget } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      runDeps,
    ).catch((error: unknown) => ({
      status: "failed" as const,
      message: error instanceof Error ? error.message : String(error),
      items: [],
    }));
    const runSummary = { status: run.status, message: run.message };

    if (run.status === "applied") {
      applied++;
      const outcome: FreshnessStepOutcome = {
        ...base,
        status: "applied",
        message: `Upgraded ${describeStep(step)}.`,
        run: runSummary,
      };
      outcomes.push(outcome);
      if (options.changeRequest?.enabled) {
        await openChangeRequest(outcome, options, cwd, runDeps);
        // The step now lives on its own branch for review. A later step of the same package would
        // build on a change that is not merged, so it waits for the next call.
        skip.add(step.packageName);
        if (step.index < step.of) {
          awaiting.add(step.packageName);
          stopped.push({
            packageName: step.packageName,
            reason: `step ${step.index} of ${step.of} awaits review in its change request; the next step comes after it is merged.`,
          });
        }
      }
      continue;
    }

    // The step did not hold. The verifier or the project's own checks already took it back out; the
    // rollback closes the run's record and makes sure the project is exactly as before.
    failed++;
    const detail = run.items?.[0]?.message ?? run.message;
    const rolledBack = await rollbackRun({ cwd, runId: planned.runId, force: true }, runDeps)
      .then(() => true)
      .catch(() => false);
    outcomes.push({
      ...base,
      status: "failed",
      message: `${describeStep(step)} did not hold: ${detail}`,
      run: runSummary,
      rolledBack,
    });
    stopped.push({ packageName: step.packageName, reason: detail });
    failedPackages.add(step.packageName);
    skip.add(step.packageName);
  }

  // The loop always runs once with maxSteps >= 1 and a failure budget above 0; this is for exactness.
  first ??= (await analyse(options, deps, cache, skip)).report;
  for (const entry of last?.held ?? []) stopped.push(entry);

  // Packages with a step still to take, by the last analysis (taken before the step that followed it).
  const doneWith = (name: string, steps: number): boolean =>
    steps <= 1 && outcomes.some((o) => o.step.packageName === name && o.status === "applied");
  const remaining = [
    ...new Set([
      ...(last?.climbs ?? [])
        .filter((climb) => !climb.held && !failedPackages.has(climb.packageName) && !doneWith(climb.packageName, climb.steps.length))
        .map((climb) => climb.packageName),
      ...awaiting,
    ]),
  ];

  const status: ApplyFreshnessResult["status"] =
    outcomes.length === 0
      ? "nothing-to-do"
      : failed === 0
        ? "ok"
        : applied === 0
          ? "failed"
          : "partial";
  return {
    status,
    steps: outcomes,
    stopped,
    remaining,
    report: first,
    message: summarise(status, applied, failed, remaining.length, first),
  };
}

function summarise(
  status: ApplyFreshnessResult["status"],
  applied: number,
  failed: number,
  remaining: number,
  report: FreshnessReport,
): string {
  if (status === "nothing-to-do") {
    if (!report.policy) return "The policy has no `freshness` key, so there is no limit to climb towards.";
    return report.climbs.length === 0
      ? "Every direct dependency is within the freshness policy."
      : "Every step that is due is held; see stopped.";
  }
  return `${applied} step(s) applied, ${failed} failed and rolled back; ${remaining} package(s) still have steps to take.`;
}

async function openChangeRequest(
  outcome: FreshnessStepOutcome,
  options: ApplyFreshnessOptions,
  cwd: string,
  runDeps: RunDeps,
): Promise<void> {
  const report = {
    ...stepReport(outcome.step, outcome.assessment, true),
    ...(outcome.runId ? { runId: outcome.runId } : {}),
  };
  try {
    const [result] = await createChangeRequestsForReports({
      cwd,
      options: options.changeRequest!,
      reports: [report],
    });
    if (result) {
      outcome.changeRequest = result;
      if (result.error) outcome.message = `${outcome.message} Change request not created: ${result.error}`;
    }
  } catch (error) {
    outcome.message = `${outcome.message} Change request not created: ${error instanceof Error ? error.message : String(error)}`;
  }
  // The step's change now sits on its own branch and the working tree is back on the base branch,
  // so node_modules must follow the lockfile again before the next step is tried.
  if (outcome.changeRequest?.created) {
    await runDeps
      .reinstall({ cwd, options: options.packageManager ? { packageManager: options.packageManager } : undefined })
      .catch((error: unknown) => {
        outcome.message = `${outcome.message} Reinstall after returning to the base branch failed: ${error instanceof Error ? error.message : String(error)}`;
      });
  }
}
