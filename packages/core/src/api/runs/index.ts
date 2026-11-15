import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createProjectSnapshot, restoreProjectSnapshot } from "../../platform/rollback.js";
import { getModelSpec } from "../../platform/config.js";
import {
  DEFAULT_REPAIR_BUDGET,
  type RepairAgent,
  type RepairBudget,
} from "../../platform/repair-agent.js";
import type { AutonomySummary, PatchResult, RemediateOptions, RemediationReport } from "../../platform/types.js";
import { resolveConstraints } from "../context.js";
import { resolveLanguageModel } from "../../remediation/patch/model.js";
import { createBuiltinRepairAgent } from "../../remediation/repair/builtin-agent.js";
import { fingerprintRepo, sameInputs } from "../../runs/fingerprint.js";
import { isPlanId, isRunId } from "../../runs/ids.js";
import type { StepEvent } from "../../runs/ledger.js";
import { buildPlan, type PlanItem, type PlanOptions, type PlanSkip, type RemediationPlan } from "../../runs/plan.js";
import { RunStore, type AttemptRecord, type RunRecord, type RunStatus } from "../../runs/run-store.js";
import { loadSnapshot } from "../../runs/snapshot-store.js";
import { assertAutonomyAllows, summarizeAutonomy } from "../autonomy/index.js";
import { applyEvents, autonomyForReport, recordOutcomes, rollbackEvent, verifyEvents } from "./autonomy-events.js";
import { defaultRunDeps, type RunDeps } from "./deps.js";
import { hasRecipeFor } from "./recipes.js";
import {
  appliedTestCommand,
  passedTestCommands,
  recordMemory,
  rejectedUpgradeEntry,
  testCommandEntry,
} from "./memory-events.js";
import {
  APPLICABLE_STATUSES,
  ensureRunSnapshot,
  repairItem,
  SNAPSHOT_DIR,
  SNAPSHOT_MANIFEST,
  type RepairItemResult,
} from "./repair.js";
import type { CheckName, VerificationResult, VerifyRequest } from "../../remediation/verify/types.js";

export type { AttemptRecord, AttemptStatus, RunRecord, RunStatus } from "../../runs/run-store.js";
export type { RunDeps } from "./deps.js";
export type { PlanItem, PlanSkip, RemediationPlan } from "../../runs/plan.js";
export type { CheckName, CheckResult, VerificationResult } from "../../remediation/verify/types.js";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunQuery {
  /** Project directory (default: process.cwd()). */
  cwd?: string;
  runId: string;
}

export interface ApplyPlanOptions {
  cwd?: string;
  /** The run that holds the plan. */
  runId?: string;
  /** Alternative to `runId`: the content id of the plan. */
  planId?: string;
  /** Apply only these plan items (default: every item not yet applied). */
  itemIds?: string[];
  /**
   * Verify each item after applying it, and take it back out if verification fails (default:
   * true). Runs the cheap checks (scope, policy, supply-chain, vuln-gone); tests and type checks
   * already ran inside the apply step when requested.
   */
  verify?: boolean;
  /**
   * When an upgrade breaks the project's type check or tests, have an agent repair the project's
   * source in an isolated checkout, and keep the result only if the verifier accepts it. Default:
   * on when a model is configured (`model` or `AUTOREMEDIATOR_MODEL`), off otherwise. `true`
   * without a model is an error; `false` never spends tokens.
   */
  repair?: boolean;
  /** Language model for repair, as `<provider>:<model-id>` (default: `AUTOREMEDIATOR_MODEL`). */
  model?: string;
  /** SDK only: supply the agent yourself instead of configuring a model. */
  repairAgent?: RepairAgent;
  /** Limits for one repair attempt (defaults: 40 steps, 10 minutes, 12 commands, 3 rounds). */
  repairBudget?: Partial<RepairBudget>;
  /** SDK only: cancel in-flight repairs. */
  signal?: AbortSignal;
}

export interface VerifyRunOptions extends RunQuery {
  /** Run only these checks (default: all, in order). */
  checks?: CheckName[];
  /** Skip checks that need the network. */
  offline?: boolean;
}

export interface RollbackRunOptions extends RunQuery {
  /** Roll back even though the project changed since the run's last step. */
  force?: boolean;
  /**
   * Reinstall dependencies from the restored lockfile so `node_modules` matches again (default:
   * true). Without it the restored manifests and the installed packages disagree.
   */
  reinstall?: boolean;
}

export interface ListRunsOptions {
  cwd?: string;
  status?: RunStatus;
  limit?: number;
}

export interface ItemOutcome {
  itemId: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  strategy: PlanItem["strategy"];
  status: "applied" | "failed";
  message: string;
  unresolvedReason?: string;
  /** Set when verification ran for this item; a failed one is why the item was taken back out. */
  verification?: VerificationResult;
  /** Set when an agent was asked to repair this item. */
  repair?: { attemptId: string; status: string; rounds: number; reason: string };
}

export interface RunReport {
  runId: string;
  planId?: string;
  status: RunStatus;
  cwd: string;
  /** Outcomes of the items this call attempted. */
  items: ItemOutcome[];
  /** Plan items that were not attempted by this call. */
  pending: string[];
  skipped: PlanSkip[];
  message: string;
  /** Set when the policy configures earned autonomy: the level in force and what it says about this run. */
  autonomy?: AutonomySummary;
}

export interface RunDetails {
  run: RunRecord;
  plan?: RemediationPlan;
  /** Outcome of every plan item that has been attempted, from the ledger. */
  items: ItemOutcome[];
  /** Agent repair attempts, oldest first. */
  attempts: AttemptRecord[];
  ledger: { ok: boolean; reason?: string; events: StepEvent[] };
}

export interface RollbackReport {
  runId: string;
  status: "rolled-back";
  restoredFiles: number;
  /** Manifests and lockfiles match the state the plan was made against again. */
  matchesBase: boolean;
  /** Whether dependencies were reinstalled from the restored lockfile. */
  reinstalled: boolean;
  /** Why the reinstall did not happen or failed. */
  reinstallNote?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function planOptionsFrom(options: RemediateOptions, cwd: string): PlanOptions {
  const constraints = resolveConstraints(options, cwd);
  return {
    ...(options.packageManager ? { packageManager: options.packageManager } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.runTests === undefined ? {} : { runTests: options.runTests }),
    ...(constraints.typecheck === undefined ? {} : { typecheck: constraints.typecheck }),
    ...(options.patchesDir ? { patchesDir: options.patchesDir } : {}),
    ...(options.proofOfFix === undefined ? {} : { proofOfFix: options.proofOfFix }),
    ...(constraints.requireProofOfFix === undefined
      ? {}
      : { requireProofOfFix: constraints.requireProofOfFix }),
    ...(options.reproductionTest ? { reproductionTest: options.reproductionTest } : {}),
    ...(constraints.enableBreakingChangeRefactor === undefined
      ? {}
      : { breakingChangeRefactor: constraints.enableBreakingChangeRefactor }),
    constraints,
  };
}

/**
 * Record a preview as a run with a plan that can be applied later. Returns the ids to put on the
 * report. Nothing in the project is touched.
 */
export async function persistPlan(
  report: RemediationReport,
  options: RemediateOptions,
  cwd: string,
): Promise<{ runId: string; planId: string }> {
  const store = new RunStore(cwd);
  const planOptions = planOptionsFrom(options, cwd);
  const base = await fingerprintRepo(cwd, options.policy);
  const run = store.create({
    cwd,
    cveIds: [report.cveId],
    source: options.source,
    base,
    status: "planned",
  });
  const plan = buildPlan({ runId: run.runId, cwd, report, base, options: planOptions });

  store.writeJson(run.runId, "plan.json", plan);
  store.writeJson(run.runId, "report.json", report);
  store.update(run.runId, { planId: plan.planId });
  store
    .ledger(run.runId)
    .append("plan.created", {
      planId: plan.planId,
      cveId: report.cveId,
      items: plan.items.length,
      skipped: plan.skipped.length,
    });
  return { runId: run.runId, planId: plan.planId };
}

// ---------------------------------------------------------------------------
// Reading runs
// ---------------------------------------------------------------------------

function outcomesFrom(events: StepEvent[], plan: RemediationPlan | undefined): ItemOutcome[] {
  const byItem = new Map<string, ItemOutcome>();
  for (const event of events) {
    if (!["item.done", "item.error", "item.rejected"].includes(event.type)) continue;
    const itemId = String(event.data["itemId"]);
    const item = plan?.items.find((candidate) => candidate.itemId === itemId);
    if (!item) continue;
    byItem.set(itemId, {
      itemId,
      packageName: item.packageName,
      fromVersion: item.fromVersion,
      toVersion: item.toVersion,
      strategy: item.strategy,
      status: event.type === "item.done" && event.data["status"] === "applied" ? "applied" : "failed",
      message: typeof event.data["message"] === "string" ? event.data["message"] : "",
      ...(typeof event.data["unresolvedReason"] === "string"
        ? { unresolvedReason: event.data["unresolvedReason"] }
        : {}),
      ...(event.data["repair"] ? { repair: event.data["repair"] as ItemOutcome["repair"] } : {}),
    });
  }
  return [...byItem.values()];
}

export function getRun(query: RunQuery): RunDetails {
  const store = new RunStore(query.cwd ?? process.cwd());
  const run = store.load(query.runId);
  const plan = store.readPlan(run.runId);
  const ledger = store.ledger(run.runId);
  const check = ledger.verify();
  const events = check.ok || check.seq > 1 ? safeRead(ledger) : [];
  return {
    run,
    ...(plan ? { plan } : {}),
    items: outcomesFrom(events, plan),
    attempts: store.listAttempts(run.runId),
    ledger: check.ok ? { ok: true, events } : { ok: false, reason: check.reason, events },
  };
}

function safeRead(ledger: ReturnType<RunStore["ledger"]>): StepEvent[] {
  try {
    return ledger.read();
  } catch {
    return [];
  }
}

export function listRuns(options: ListRunsOptions = {}): RunRecord[] {
  const store = new RunStore(options.cwd ?? process.cwd());
  const runs = store.list().filter((run) => !options.status || run.status === options.status);
  return options.limit && options.limit > 0 ? runs.slice(0, options.limit) : runs;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

function resolveRun(store: RunStore, options: ApplyPlanOptions): RunRecord {
  if (options.runId) {
    if (!isRunId(options.runId)) throw new Error(`Invalid run id: ${JSON.stringify(options.runId)}`);
    return store.load(options.runId);
  }
  if (options.planId) {
    if (!isPlanId(options.planId)) throw new Error(`Invalid plan id: ${JSON.stringify(options.planId)}`);
    const match = store.list().find((run) => run.planId === options.planId && run.status !== "rolled-back");
    if (!match) throw new Error(`No run found for plan ${options.planId}`);
    return match;
  }
  throw new Error("applyPlan needs a runId or a planId.");
}

/** Failures of the project's own checks after an upgrade: the ones an agent can do something about. */
const REPAIRABLE = new Set(["validation-failed", "breaking-change-unresolved"]);

/**
 * The agent to use for repairs, or undefined when repair is off. Asking for repair explicitly
 * without anything to repair with is an error; a model that merely happens to be configured but
 * cannot be loaded only disables repair, and the run says so.
 */
async function resolveRepairAgent(
  options: ApplyPlanOptions,
  note: (message: string) => void,
): Promise<RepairAgent | undefined> {
  if (options.repair === false) return undefined;
  if (options.repairAgent) return options.repairAgent;

  const spec = getModelSpec(options.model);
  if (!spec) {
    if (options.repair === true) {
      throw new Error('Repair needs a model: pass `model` ("<provider>:<model-id>") or set AUTOREMEDIATOR_MODEL.');
    }
    return undefined;
  }
  try {
    return createBuiltinRepairAgent(await resolveLanguageModel(spec));
  } catch (error) {
    if (options.repair === true) throw error;
    note(`repair unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}


/**
 * Apply a plan. Before the first change the project's manifests and lockfiles are snapshotted to
 * disk, each item is recorded in the run's ledger as it is attempted, and the run can be resumed
 * after a crash or undone with `rollbackRun`. A plan made against inputs that have since changed is
 * refused rather than applied to a project it was not made for.
 */
export async function applyPlan(
  options: ApplyPlanOptions,
  deps: RunDeps = defaultRunDeps,
): Promise<RunReport> {
  const cwd = options.cwd ?? process.cwd();
  const store = new RunStore(cwd);
  const run = resolveRun(store, options);
  const runId = run.runId;

  if (!APPLICABLE_STATUSES.has(run.status)) {
    throw new Error(`Run ${runId} is ${run.status}; there is nothing to apply.`);
  }
  const plan = store.readPlan(runId);
  if (!plan) throw new Error(`Run ${runId} has no plan.`);
  // Earned autonomy (opt-in via the policy): below L2 nothing is changed, and the reason is given.
  assertAutonomyAllows(cwd, plan.options.policy, "apply", `Applying run ${runId}`);
  const levelBefore = summarizeAutonomy(cwd, plan.options.policy)?.level;

  const ledger = store.ledger(runId);
  const chain = ledger.verify();
  if (!chain.ok) throw new Error(`Run ${runId}: ledger failed verification (${chain.reason}).`);

  const known = new Set(plan.items.map((item) => item.itemId));
  for (const id of options.itemIds ?? []) {
    if (!known.has(id)) throw new Error(`Plan ${plan.planId} has no item ${id}.`);
  }

  const events = ledger.read();
  const applied = new Set(
    events
      .filter((event) => event.type === "item.done" && event.data["status"] === "applied")
      .map((event) => String(event.data["itemId"])),
  );

  // The project must still be what the plan (or the last completed step) left it.
  const expected = run.after ?? run.base;
  const current = await fingerprintRepo(cwd, plan.options.policy);
  if (!sameInputs(current, expected)) {
    throw new Error(
      run.status === "planned"
        ? `The project changed since plan ${plan.planId} was made (manifests, lockfiles or policy differ). Plan again.`
        : `The project changed since run ${runId}'s last completed step, possibly by an interrupted install. Inspect it, or roll the run back.`,
    );
  }

  const notes: string[] = [];
  const agent = await resolveRepairAgent(options, (message) => notes.push(message));

  const release = store.acquireApplyLock(runId);
  const outcomes: ItemOutcome[] = [];
  try {
    for (const note of notes) ledger.append("repair.unavailable", { message: note });
    await ensureRunSnapshot(store, runId, cwd);

    store.update(runId, { status: "applying" });
    ledger.append("apply.start", { itemIds: options.itemIds ?? "all", resumed: run.status !== "planned" });

    const selected = plan.items.filter(
      (item) => !applied.has(item.itemId) && (!options.itemIds || options.itemIds.includes(item.itemId)),
    );

    const advisories = store.readReport(runId)?.cveDetails;
    const verifyItems = options.verify !== false;
    const skippedNames = plan.skipped.map((skip) => skip.packageName);

    let failure: string | undefined;
    for (const item of selected) {
      // Taken before the item, so a rejected item can be put back exactly.
      const before = await createProjectSnapshot(cwd);
      ledger.append("item.start", { itemId: item.itemId, packageName: item.packageName });
      let result: PatchResult;
      try {
        result = await deps.applyItem(item, { cwd, options: plan.options });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ledger.append("item.error", { itemId: item.itemId, message });
        outcomes.push(outcomeOf(item, "failed", message));
        failure = message;
        break;
      }

      let ok = result.applied && !result.unresolvedReason;
      let message = result.message;
      let verification: VerificationResult | undefined;
      let repair: ItemOutcome["repair"];

      // The upgrade works for the dependency but breaks the project: ask an agent to adapt it.
      // With no agent (no model configured) a repair is still worth an attempt when a recipe for this upgrade exists.
      const repairable =
        agent !== undefined ||
        (options.repair !== false && hasRecipeFor(cwd, item, plan.options.policy));
      if (!ok && repairable && result.unresolvedReason && REPAIRABLE.has(result.unresolvedReason)) {
        const others = plan.items
          .filter((candidate) => candidate.itemId !== item.itemId && !applied.has(candidate.itemId))
          .map((candidate) => candidate.packageName);
        const repaired: RepairItemResult = await repairItem(
          {
            cwd,
            store,
            runId,
            item,
            plan,
            advisories: advisories ? [advisories] : [],
            expectedRemaining: [...skippedNames, ...others],
            agent,
            budget: { ...DEFAULT_REPAIR_BUDGET, ...options.repairBudget },
            signal: options.signal ?? new AbortController().signal,
          },
          {
            attempt: deps.attempt,
            promote: { verify: deps.verify, reinstall: () => deps.reinstall({ cwd, options: plan.options }) },
          },
        );
        repair = { attemptId: repaired.attemptId, status: repaired.status, rounds: repaired.rounds, reason: repaired.message };
        if (repaired.status === "promoted") {
          ok = true;
          message = `Upgraded ${item.packageName} to ${item.toVersion} and repaired the project with ${repaired.agentId.startsWith("recipe:") ? "a recipe" : "an agent"}: ${repaired.message}`;
          verification = repaired.verification;
          store.update(runId, { allowSourceEdits: true });
        } else {
          message = `${message} An agent repair was tried and not accepted (${repaired.status}): ${repaired.message}`;
        }
      }

      if (ok && verifyItems && !repair) {
        const others = plan.items
          .filter((candidate) => candidate.itemId !== item.itemId && !applied.has(candidate.itemId))
          .map((candidate) => candidate.packageName);
        verification = await deps.verify({
          cwd,
          ...(plan.options.packageManager
            ? { packageManager: plan.options.packageManager as VerifyRequest["packageManager"] }
            : {}),
          policy: plan.options.policy,
          baseFiles: before.fileSnapshots,
          statusBefore: before.isGit ? (before.gitStatusBefore ?? []) : undefined,
          advisories: advisories ? [advisories] : [],
          expectedRemaining: [...skippedNames, ...others],
          options: { ...verifyOptionsOf(plan.options), allowSourceEdits: plan.options.breakingChangeRefactor },
          checks: ["scope", "policy", "supply-chain", "vuln-gone"],
        });

        if (!verification.passed) {
          // The verifier disposes: whatever the tool reported, this change does not stand.
          const failed = verification.checks.find((check) => check.name === verification!.failedCheck);
          message = `Verification failed (${verification.failedCheck}): ${failed?.message ?? "see details"}`;
          await restoreProjectSnapshot(before);
          const reinstallNote = await deps
            .reinstall({ cwd, options: plan.options })
            .then(() => undefined)
            .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
          ledger.append("item.rejected", {
            itemId: item.itemId,
            message,
            failedCheck: verification.failedCheck,
            details: failed?.details ?? [],
            ...(reinstallNote ? { reinstallNote } : {}),
          });
          store.update(runId, { after: await fingerprintRepo(cwd, plan.options.policy) });
          outcomes.push({ ...outcomeOf(item, "failed", message), verification });
          continue;
        }
      }

      const after = await fingerprintRepo(cwd, plan.options.policy);
      ledger.append("item.done", {
        itemId: item.itemId,
        status: ok ? "applied" : "failed",
        message,
        ...(result.unresolvedReason ? { unresolvedReason: result.unresolvedReason } : {}),
        ...(verification ? { verified: true } : {}),
        ...(repair ? { repair } : {}),
        filesSha256: after.filesSha256,
      });
      store.update(runId, { after });
      outcomes.push({
        ...outcomeOf(item, ok ? "applied" : "failed", message, result.unresolvedReason),
        ...(verification ? { verification } : {}),
        ...(repair ? { repair } : {}),
      });
      if (ok) applied.add(item.itemId);
    }

    const status: RunStatus = failure
      ? "failed"
      : plan.items.every((item) => applied.has(item.itemId))
        ? "applied"
        : "partial";
    store.update(runId, { status, ...(failure ? { error: failure } : {}) });
    ledger.append("apply.end", { status });

    await recordOutcomes(cwd, plan.options.policy, applyEvents(run, plan.options, outcomes), (problem) =>
      ledger.append("autonomy.record-failed", { message: problem }),
    );
    // What this run established for the repository's memory: upgrades the verifier rejected, and how tests ran.
    const testCommands = new Set(
      outcomes.flatMap((outcome) => {
        const ran = passedTestCommands(outcome.verification);
        if (ran.length > 0 || outcome.status !== "applied") return ran;
        return [appliedTestCommand(cwd, plan.options)].filter((command) => command !== undefined);
      }),
    );
    await recordMemory(
      cwd,
      runId,
      [
        ...outcomes.map((outcome) => rejectedUpgradeEntry(outcome, outcome.verification)),
        ...[...testCommands].map((command) => testCommandEntry(command)),
      ],
      (problem) => ledger.append("memory.record-failed", { message: problem }),
    );
    const autonomy = autonomyForReport(cwd, plan.options.policy, status, outcomes, plan, levelBefore);

    return {
      runId,
      planId: plan.planId,
      status,
      cwd,
      items: outcomes,
      pending: plan.items.filter((item) => !applied.has(item.itemId)).map((item) => item.itemId),
      skipped: plan.skipped,
      message: summarize(status, outcomes, plan),
      ...(autonomy ? { autonomy } : {}),
    };
  } finally {
    release();
  }
}

function outcomeOf(
  item: PlanItem,
  status: ItemOutcome["status"],
  message: string,
  unresolvedReason?: string,
): ItemOutcome {
  return {
    itemId: item.itemId,
    packageName: item.packageName,
    fromVersion: item.fromVersion,
    toVersion: item.toVersion,
    strategy: item.strategy,
    status,
    message,
    ...(unresolvedReason ? { unresolvedReason } : {}),
  };
}

function summarize(status: RunStatus, outcomes: ItemOutcome[], plan: RemediationPlan): string {
  const done = outcomes.filter((outcome) => outcome.status === "applied").length;
  const failed = outcomes.length - done;
  if (plan.items.length === 0) return "The plan has no changes to apply.";
  return `${status}: ${done} applied, ${failed} failed of ${outcomes.length} attempted (${plan.items.length} in plan).`;
}

/** Continue a run that was interrupted or left partial, skipping items already applied. */
export async function resumeRun(query: RunQuery, deps: RunDeps = defaultRunDeps): Promise<RunReport> {
  const run = new RunStore(query.cwd ?? process.cwd()).load(query.runId);
  if (run.status === "planned") {
    throw new Error(`Run ${run.runId} has not started; use applyPlan.`);
  }
  return applyPlan({ cwd: query.cwd, runId: query.runId }, deps);
}

// ---------------------------------------------------------------------------
// Rolling back
// ---------------------------------------------------------------------------

/**
 * Undo a run: restore the manifests, lockfiles and patch files it changed from the snapshot taken
 * before its first change. Refused when the project has changed since the run's last step, because
 * restoring would silently discard that work (pass `force` to override).
 */
export async function rollbackRun(
  options: RollbackRunOptions,
  deps: RunDeps = defaultRunDeps,
): Promise<RollbackReport> {
  const cwd = options.cwd ?? process.cwd();
  const store = new RunStore(cwd);
  const run = store.load(options.runId);
  const runId = run.runId;

  if (run.status === "planned") throw new Error(`Run ${runId} made no changes; there is nothing to roll back.`);
  if (run.status === "rolled-back") throw new Error(`Run ${runId} is already rolled back.`);
  if (!store.hasFile(runId, SNAPSHOT_MANIFEST)) {
    throw new Error(`Run ${runId} has no snapshot to restore.`);
  }

  const release = store.acquireApplyLock(runId);
  try {
    const plan = store.readPlan(runId);
    const policy = plan?.options.policy;
    const appliedBefore = appliedCount(store, runId);
    const current = await fingerprintRepo(cwd, policy);
    if (!options.force && !sameInputs(current, run.after ?? run.base)) {
      throw new Error(
        `The project changed since run ${runId}'s last step; rolling back would discard those changes. Review them, or pass force.`,
      );
    }

    const snapshot = loadSnapshot(join(store.runDir(runId), SNAPSHOT_DIR));
    if (snapshot.cwd !== run.cwd) {
      throw new Error(`Run ${runId}: snapshot was taken for a different directory; refusing to restore.`);
    }
    await restoreProjectSnapshot(snapshot);

    let reinstalled = false;
    let reinstallNote: string | undefined;
    if (options.reinstall === false) {
      reinstallNote = "skipped (reinstall: false)";
    } else {
      try {
        await deps.reinstall({ cwd, options: plan?.options });
        reinstalled = true;
      } catch (error) {
        reinstallNote = error instanceof Error ? error.message.split("\n")[0] : String(error);
      }
    }

    const restored = await fingerprintRepo(cwd, policy);
    const matchesBase = sameInputs(restored, run.base);
    store.update(runId, { status: "rolled-back", after: restored });
    store.ledger(runId).append("rollback", {
      restoredFiles: snapshot.fileSnapshots.size,
      matchesBase,
      reinstalled,
      forced: Boolean(options.force),
    });
    await recordOutcomes(
      cwd,
      policy,
      rollbackEvent(run, plan, appliedBefore, { restoredFiles: snapshot.fileSnapshots.size, forced: Boolean(options.force) }),
      (problem) => store.ledger(runId).append("autonomy.record-failed", { message: problem }),
    );

    return {
      runId,
      status: "rolled-back",
      restoredFiles: snapshot.fileSnapshots.size,
      matchesBase,
      reinstalled,
      ...(reinstallNote ? { reinstallNote } : {}),
      message: describeRollback(matchesBase, reinstalled, reinstallNote),
    };
  } finally {
    release();
  }
}


/** Items the run has applied, from its ledger. */
function appliedCount(store: RunStore, runId: string): number {
  return store
    .ledger(runId)
    .read()
    .filter((event) => event.type === "item.done" && event.data["status"] === "applied").length;
}

function describeRollback(matchesBase: boolean, reinstalled: boolean, note?: string): string {
  const files = matchesBase
    ? "Restored manifests, lockfiles and patch files."
    : "Restored the recorded files, but the project still differs from when the plan was made (files the snapshot does not cover).";
  return reinstalled
    ? `${files} Reinstalled dependencies from the restored lockfile.`
    : `${files} Dependencies were not reinstalled (${note}); run your package manager's install to refresh node_modules.`;
}

function verifyOptionsOf(options: PlanOptions): VerifyRequest["options"] {
  return {
    ...(options.runTests === undefined ? {} : { runTests: options.runTests }),
    ...(options.typecheck === undefined ? {} : { typecheck: options.typecheck }),
    ...(options.proofOfFix === undefined ? {} : { proofOfFix: options.proofOfFix }),
    ...(options.requireProofOfFix === undefined ? {} : { requireProofOfFix: options.requireProofOfFix }),
    ...(options.reproductionTest ? { reproductionTest: options.reproductionTest } : {}),
    ...(options.patchesDir ? { patchesDir: options.patchesDir } : {}),
    ...(options.constraints ? { constraints: options.constraints } : {}),
  };
}

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

export interface RunVerification extends VerificationResult {
  runId: string;
}

/**
 * Judge a run's project as it is now against what the run set out to do, with the full set of
 * checks (or the ones asked for): the changes stayed in scope and within policy, the new versions
 * pass the supply-chain gate, a frozen install works, the advisories no longer match, and the
 * requested tests, type check and reproduction test pass. The result is stored with the run.
 */
export async function verifyRun(
  options: VerifyRunOptions,
  deps: RunDeps = defaultRunDeps,
): Promise<RunVerification> {
  const cwd = options.cwd ?? process.cwd();
  const store = new RunStore(cwd);
  const run = store.load(options.runId);
  const runId = run.runId;

  if (!store.hasFile(runId, SNAPSHOT_MANIFEST)) {
    throw new Error(`Run ${runId} has not been applied; there is nothing to verify.`);
  }
  const plan = store.readPlan(runId);
  if (!plan) throw new Error(`Run ${runId} has no plan.`);

  const snapshot = loadSnapshot(join(store.runDir(runId), SNAPSHOT_DIR));
  const applied = new Set(
    store
      .ledger(runId)
      .read()
      .filter((event) => event.type === "item.done" && event.data["status"] === "applied")
      .map((event) => String(event.data["itemId"])),
  );
  const advisories = store.readReport(runId)?.cveDetails;

  const result = await deps.verify({
    cwd,
    ...(plan.options.packageManager
      ? { packageManager: plan.options.packageManager as VerifyRequest["packageManager"] }
      : {}),
    policy: plan.options.policy,
    baseFiles: snapshot.fileSnapshots,
    statusBefore: snapshot.isGit ? (snapshot.gitStatusBefore ?? []) : undefined,
    advisories: advisories ? [advisories] : [],
    expectedRemaining: [
      ...plan.skipped.map((skip) => skip.packageName),
      ...plan.items.filter((item) => !applied.has(item.itemId)).map((item) => item.packageName),
    ],
    options: {
      ...verifyOptionsOf(plan.options),
      allowSourceEdits: run.allowSourceEdits === true || plan.options.breakingChangeRefactor,
      // Earlier runs append to the committed track record after this run's snapshot was taken.
      ignoreTrackRecord: true,
      ...(options.offline ? { offline: true } : {}),
    },
    ...(options.checks ? { checks: options.checks } : {}),
  });

  store.writeJson(runId, "verification.json", result);
  store.ledger(runId).append("verify", {
    passed: result.passed,
    ...(result.failedCheck ? { failedCheck: result.failedCheck } : {}),
    checks: result.checks.map((check) => `${check.name}:${check.status}`),
  });
  await recordOutcomes(cwd, plan.options.policy, verifyEvents(run, plan, applied.size, result), (problem) =>
    store.ledger(runId).append("autonomy.record-failed", { message: problem }),
  );
  await recordMemory(
    cwd,
    runId,
    passedTestCommands(result).map((command) => testCommandEntry(command)),
    (problem) => store.ledger(runId).append("memory.record-failed", { message: problem }),
  );
  return { runId, ...result };
}

/** Files an attempt keeps beside its record. */
export type AttemptArtifact = "diff" | "verification" | "transcript";

const ATTEMPT_FILES: Record<AttemptArtifact, string> = {
  diff: "diff.patch",
  verification: "verification.json",
  transcript: "transcript.jsonl",
};

/** The text of one of an attempt's artifacts, or undefined when the attempt did not produce it. */
export function readAttemptArtifact(
  query: RunQuery & { attemptId: string; artifact: AttemptArtifact },
): string | undefined {
  const store = new RunStore(query.cwd ?? process.cwd());
  const file = join(store.attemptDir(query.runId, query.attemptId), ATTEMPT_FILES[query.artifact]);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}
