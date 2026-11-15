/**
 * What the run operations tell the autonomy track record. Each builder turns something a run really
 * did (an item applied or rejected, a verification, a rollback, a promoted attempt) into the event
 * the record keeps. Recording is best effort and lives in `api/autonomy`.
 */
import semver from "semver";

import type { OutcomeFacts } from "../autonomy/compute.js";
import { recordAutonomyEvents, summarizeAutonomy } from "../autonomy/index.js";
import type { AutonomySummary, NewTrackEvent } from "../autonomy/types.js";
import type { CheckName, VerificationResult } from "../verify/types.js";
import type { PlanOptions, RemediationPlan } from "./plan.js";
import type { RunRecord } from "./run-store.js";

/** The parts of an item outcome that autonomy reads (structurally the same as `ItemOutcome`). */
interface ItemOutcome {
  itemId: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  strategy: string;
  status: "applied" | "failed";
  message: string;
  unresolvedReason?: string;
  verification?: VerificationResult;
  repair?: { status: string };
}

const checkPassed = (verification: VerificationResult | undefined, name: CheckName): boolean =>
  verification?.checks.some((check) => check.name === name && check.status === "passed") ?? false;

const firstLine = (text: string): string => text.split("\n")[0] ?? "";

/** One event per item `applyPlan` attempted in this call. */
export function applyEvents(
  run: Pick<RunRecord, "runId" | "cveIds">,
  options: PlanOptions,
  outcomes: readonly ItemOutcome[],
): NewTrackEvent[] {
  return outcomes.map((outcome) => {
    const applied = outcome.status === "applied";
    const rejected = !applied && outcome.verification && !outcome.verification.passed;
    const type: NewTrackEvent["type"] = applied
      ? outcome.verification?.passed
        ? "applied-verified"
        : "applied-unverified"
      : rejected
        ? "verifier-failure"
        : "apply-failed";
    const detail = rejected
      ? `${outcome.packageName} ${outcome.fromVersion} -> ${outcome.toVersion}: ${firstLine(outcome.message)}`
      : `${outcome.packageName} ${outcome.fromVersion} -> ${outcome.toVersion} (${outcome.strategy}): ${applied ? "applied" : (outcome.unresolvedReason ?? firstLine(outcome.message))}${outcome.repair?.status === "promoted" ? ", repaired by an agent" : ""}`;
    return {
      type,
      runId: run.runId,
      itemId: outcome.itemId,
      cveIds: run.cveIds,
      packages: [outcome.packageName],
      // The apply step runs the project's tests and type check when asked, and fails the item if
      // they fail, so an applied item with them requested has passed them.
      coverage: {
        tests: applied && options.runTests === true,
        typecheck: applied && options.typecheck === true,
      },
      detail,
    };
  });
}

/** `verifyRun` over a run that has applied something: a failure is an incident, a pass is evidence. */
export function verifyEvents(
  run: Pick<RunRecord, "runId" | "cveIds" | "status">,
  plan: RemediationPlan,
  appliedItems: number,
  result: VerificationResult,
): NewTrackEvent[] {
  if (appliedItems === 0 || run.status === "rolled-back") return [];
  const packages = plan.items.map((item) => item.packageName);
  if (!result.passed) {
    const failed = result.checks.find((check) => check.name === result.failedCheck);
    return [
      {
        type: "verifier-failure",
        runId: run.runId,
        cveIds: run.cveIds,
        packages,
        coverage: { tests: false, typecheck: false },
        detail: `verifyRun failed (${result.failedCheck}): ${firstLine(failed?.message ?? "see the run's verification.json")}`,
      },
    ];
  }
  const coverage = {
    tests: checkPassed(result, "tests"),
    typecheck: checkPassed(result, "typecheck"),
  };
  // A pass that did not run the tests or type check adds nothing the record does not already hold.
  if (!coverage.tests && !coverage.typecheck) return [];
  return [
    {
      type: "verify-passed",
      runId: run.runId,
      cveIds: run.cveIds,
      packages,
      coverage,
      detail: `verifyRun passed with ${[coverage.tests ? "tests" : "", coverage.typecheck ? "type check" : ""].filter(Boolean).join(" and ")}`,
    },
  ];
}

export function rollbackEvent(
  run: Pick<RunRecord, "runId" | "cveIds">,
  plan: RemediationPlan | undefined,
  appliedItems: number,
  detail: { restoredFiles: number; forced: boolean },
): NewTrackEvent[] {
  if (appliedItems === 0) return [];
  return [
    {
      type: "rollback",
      runId: run.runId,
      cveIds: run.cveIds,
      packages: plan?.items.map((item) => item.packageName) ?? [],
      coverage: { tests: false, typecheck: false },
      detail: `rolled back${detail.forced ? " (forced)" : ""}; ${detail.restoredFiles} file(s) restored`,
    },
  ];
}

export function finalizeEvent(
  run: Pick<RunRecord, "runId" | "cveIds">,
  itemId: string,
  packageName: string,
  outcome: { promoted: boolean; message: string; verification?: VerificationResult },
): NewTrackEvent {
  return {
    type: outcome.promoted ? "applied-verified" : "verifier-failure",
    runId: run.runId,
    itemId,
    cveIds: run.cveIds,
    packages: [packageName],
    coverage: {
      tests: outcome.promoted && checkPassed(outcome.verification, "tests"),
      typecheck: outcome.promoted && checkPassed(outcome.verification, "typecheck"),
    },
    detail: outcome.promoted
      ? `${packageName}: applied from a host agent's attempt`
      : `${packageName}: promotion failed: ${firstLine(outcome.message)}`,
  };
}

const isMajorBump = (from: string, to: string): boolean => {
  const a = semver.coerce(from);
  const b = semver.coerce(to);
  return a !== null && b !== null && semver.major(b) > semver.major(a);
};

/** Record events and say, on the run's ledger, when that was not possible. */
export async function recordOutcomes(
  cwd: string,
  policy: string | undefined,
  events: readonly NewTrackEvent[],
  onProblem: (problem: string) => void,
): Promise<void> {
  const result = await recordAutonomyEvents(cwd, policy, events);
  if (result.problem) onProblem(result.problem);
}

/** The level and signals to put on a run report. */
export function autonomyForReport(
  cwd: string,
  policy: string | undefined,
  status: string,
  outcomes: readonly ItemOutcome[],
  plan: RemediationPlan,
  /** The level in force before this run recorded its outcomes. */
  levelBefore?: AutonomySummary["level"],
): AutonomySummary | undefined {
  const facts: OutcomeFacts = {
    fullyApplied: status === "applied",
    allVerified: outcomes.every(
      (outcome) => outcome.status !== "applied" || outcome.verification?.passed === true,
    ),
    anyMajorBump: plan.items.some((item) => isMajorBump(item.fromVersion, item.toVersion)),
    anyFailed: outcomes.some((outcome) => outcome.status === "failed"),
  };
  return summarizeAutonomy(cwd, policy, facts, new Date(), levelBefore);
}
