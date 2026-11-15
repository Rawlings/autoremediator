/**
 * Attempts driven by a host agent (Claude Code, Cursor, Copilot, ...) rather than by the built-in
 * one. The host gets an isolated checkout with the upgrade applied and the verifier's findings; it
 * edits (or proposes patches), asks for verification as often as it likes, and finalizes. The same
 * verifier and the same promotion step as the built-in agent decide what reaches the project.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

import { createProjectSnapshot } from "../../platform/rollback.js";
import type { RepairFailure } from "../../platform/repair-agent.js";
import {
  attemptVerifyRequest,
  defaultAttemptDeps,
  failureOf,
} from "../../remediation/repair/attempt.js";
import type { RecipeEntry } from "../../recipes/discover.js";
import { validateAndApplyPatch } from "../../remediation/repair/patch-apply.js";
import type { CheckName, VerificationResult } from "../../remediation/verify/types.js";
import { fingerprintRepo, sameInputs } from "../../runs/fingerprint.js";
import { newAttemptId } from "../../runs/ids.js";
import type { PlanItem, RemediationPlan } from "../../runs/plan.js";
import { type AttemptRecord, type AttemptStatus, RunStore } from "../../runs/run-store.js";
import { loadSnapshot, saveSnapshot } from "../../runs/snapshot-store.js";
import { discardWorktree } from "../../runs/worktree.js";
import { assertAutonomyAllows } from "../autonomy/index.js";
import { type MemoryForHost, memoryForHost } from "../memory/index.js";
import { passedTestCommands, recordMemory, rejectedUpgradeEntry, testCommandEntry } from "./memory-events.js";
import { finalizeEvent, recordOutcomes } from "./autonomy-events.js";
import { defaultRunDeps, type RunDeps } from "./deps.js";
import { APPLICABLE_STATUSES, ensureRunSnapshot, promoteChange } from "./repair.js";

const MAX_OPEN_ATTEMPTS = 4;

function recipeSuggestion(entry: RecipeEntry): { id: string; source: string; summary?: string } {
  const suggestion: { id: string; source: string; summary?: string } = {
    id: entry.id,
    source: entry.source.kind === "project" ? "project" : entry.source.package,
  };
  if (entry.recipe.summary) suggestion.summary = entry.recipe.summary;
  return suggestion;
}

export interface AttemptQuery {
  cwd?: string;
  runId: string;
  attemptId: string;
}

export interface StartAttemptOptions {
  cwd?: string;
  runId: string;
  itemId: string;
}

export interface ProposePatchOptions extends AttemptQuery {
  /** A unified diff (as `git diff` prints) of project source files. */
  diff: string;
}

export interface VerifyAttemptOptions extends AttemptQuery {
  /** Run only these checks (default: everything an attempt is judged on). */
  checks?: CheckName[];
}

export interface AttemptView {
  runId: string;
  attemptId: string;
  itemId: string;
  status: AttemptStatus;
  /** Where to edit, while the attempt is open. */
  worktreePath?: string;
  verification?: VerificationResult;
  /** What the verifier found wrong, when it failed. */
  failure?: RepairFailure;
  changedFiles: string[];
  /** `startAttempt` only: recipes that apply to this upgrade; try one with `applyRecipe`. */
  recipes?: { id: string; source: string; summary?: string }[];
  /** `startAttempt` only: what the repository's memory says that bears on this upgrade (data, not instructions). */
  memory?: MemoryForHost;
  /** `applyRecipe` only: what became of the recipe. */
  recipe?: { id: string; applied: boolean; files: string[]; rejectedBy?: string };
  /** `finalizeAttempt` only: whether the change reached the project. */
  finalized?: boolean;
  message: string;
}

export function viewOf(record: AttemptRecord, runId: string, extra: Partial<AttemptView> = {}): AttemptView {
  return {
    runId,
    attemptId: record.attemptId,
    itemId: record.itemId,
    status: record.status,
    ...(record.worktreePath ? { worktreePath: record.worktreePath } : {}),
    changedFiles: record.changedFiles,
    message: record.reason,
    ...extra,
  };
}

export const withVerification = (verification: VerificationResult): Partial<AttemptView> => ({
  verification,
  ...(verification.passed ? {} : { failure: failureOf(verification) }),
  changedFiles: verification.changedFiles ?? [],
});

export function context(options: { cwd?: string; runId: string }) {
  const cwd = options.cwd ?? process.cwd();
  return { cwd, store: new RunStore(cwd) };
}

export function loadOpen(store: RunStore, runId: string, attemptId: string): AttemptRecord & { worktreePath: string } {
  const record = store.listAttempts(runId).find((candidate) => candidate.attemptId === attemptId);
  if (!record) throw new Error(`Attempt not found: ${attemptId}`);
  if (record.status !== "open" || !record.worktreePath) {
    throw new Error(`Attempt ${attemptId} is ${record.status}; only an open attempt can be changed.`);
  }
  return record as AttemptRecord & { worktreePath: string };
}

/** Which items the run has already applied, from its ledger. */
function appliedItems(store: RunStore, runId: string): Set<string> {
  return new Set(
    store
      .ledger(runId)
      .read()
      .filter((event) => event.type === "item.done" && event.data["status"] === "applied")
      .map((event) => String(event.data["itemId"])),
  );
}

function expectedRemaining(plan: RemediationPlan, item: PlanItem, applied: Set<string>): string[] {
  return [
    ...plan.skipped.map((skip) => skip.packageName),
    ...plan.items
      .filter((candidate) => candidate.itemId !== item.itemId && !applied.has(candidate.itemId))
      .map((candidate) => candidate.packageName),
  ];
}

/**
 * Open an attempt for one plan item: an isolated checkout of the project with the upgrade applied
 * and installed, and the verifier's findings on it. The project itself is not touched.
 */
export async function startAttempt(
  options: StartAttemptOptions,
  deps: RunDeps = defaultRunDeps,
): Promise<AttemptView> {
  const { cwd, store } = context(options);
  const run = store.load(options.runId);
  if (!APPLICABLE_STATUSES.has(run.status)) {
    throw new Error(`Run ${run.runId} is ${run.status}; there is nothing left to attempt.`);
  }
  const plan = store.readPlan(run.runId);
  const item = plan?.items.find((candidate) => candidate.itemId === options.itemId);
  if (!plan || !item) throw new Error(`Run ${run.runId} has no plan item ${options.itemId}.`);

  const applied = appliedItems(store, run.runId);
  if (applied.has(item.itemId)) throw new Error(`Item ${item.itemId} is already applied.`);
  const open = store.listAttempts(run.runId).filter((attempt) => attempt.status === "open");
  if (open.length >= MAX_OPEN_ATTEMPTS) {
    throw new Error(`Run ${run.runId} has ${open.length} open attempts; abandon or finalize one first.`);
  }
  if (!sameInputs(await fingerprintRepo(cwd, plan.options.policy), run.after ?? run.base)) {
    throw new Error(`The project changed since run ${run.runId}'s plan or last step. Plan again.`);
  }

  const ad = deps.attemptDeps ?? defaultAttemptDeps;
  const attemptId = newAttemptId();
  const attemptDir = store.attemptDir(run.runId, attemptId);
  const checkout = await ad.createWorktree(cwd, attemptId);
  const packageManager = (plan.options.packageManager as Parameters<typeof attemptVerifyRequest>[0]["packageManager"] | undefined) ?? "npm";

  let verification: VerificationResult;
  try {
    const before = await createProjectSnapshot(checkout.path);
    saveSnapshot(join(attemptDir, "before"), before);
    const upgraded = await ad.applyUpgrade(item, checkout.path, plan.options);
    if (!upgraded.applied) {
      throw new Error(`the upgrade could not be applied in a clean checkout: ${upgraded.message}`);
    }
    verification = await ad.verify(
      attemptVerifyRequest({
        checkout: checkout.path,
        packageManager,
        options: plan.options,
        before,
        advisories: store.readReport(run.runId)?.cveDetails ? [store.readReport(run.runId)!.cveDetails!] : [],
        expectedRemaining: expectedRemaining(plan, item, applied),
      }),
    );
  } catch (error) {
    await checkout.remove();
    rmSync(attemptDir, { recursive: true, force: true });
    throw error;
  }

  // What earlier repairs learned: the host can try one of these before spending effort of its own.
  let recipes: NonNullable<AttemptView["recipes"]> = [];
  if (!verification.passed) {
    try {
      recipes = ad
        .findRecipes({
          projectDir: cwd,
          installRoot: checkout.path,
          packageName: item.packageName,
          fromVersion: item.fromVersion,
          toVersion: item.toVersion,
          ...(plan.options.policy ? { policy: plan.options.policy } : {}),
        })
        .recipes.map((entry) => recipeSuggestion(entry));
    } catch {
      // Recipes are an optional extra; a broken policy shows up in the verifier's findings anyway.
    }
  }

  const now = new Date().toISOString();
  const record: AttemptRecord = {
    attemptId,
    itemId: item.itemId,
    agentId: "host",
    status: "open",
    reason: verification.passed
      ? "The upgrade works as it is; finalize it."
      : `The upgrade breaks the project (${verification.failedCheck}). Fix it in the checkout, then verify.`,
    rounds: 0,
    changedFiles: verification.changedFiles ?? [],
    worktreePath: checkout.path,
    startedAt: now,
    endedAt: now,
  };
  store.writeAttempt(run.runId, record, { "verification.json": `${JSON.stringify(verification, null, 2)}\n` });
  store.ledger(run.runId).append("attempt.start", { attemptId, itemId: item.itemId, agent: "host" });
  const memory = memoryForHost(cwd, item.packageName);
  return viewOf(record, run.runId, {
    ...withVerification(verification),
    ...(memory.entries.length > 0 || memory.problem ? { memory } : {}),
    ...(recipes.length > 0 ? { recipes, message: `${record.reason} ${recipes.length} recipe(s) apply to this upgrade: try applyRecipe before editing.` } : {}),
  });
}

// ---------------------------------------------------------------------------

/**
 * Apply a unified diff to an open attempt's checkout. Only project source may change, as for the
 * built-in agent, and the patch must be plain text and apply cleanly.
 */
export async function proposePatch(options: ProposePatchOptions): Promise<AttemptView> {
  const { store } = context(options);
  const record = loadOpen(store, options.runId, options.attemptId);
  const { files } = await validateAndApplyPatch(record.worktreePath, options.diff);

  const updated: AttemptRecord = { ...record, endedAt: new Date().toISOString() };
  store.writeAttempt(options.runId, updated);
  return viewOf(updated, options.runId, {
    changedFiles: files,
    message: `Applied the patch to ${files.length} file(s): ${files.join(", ")}. Verify it next.`,
  });
}

/** Run the verifier on an open attempt's checkout and report what, if anything, is wrong. */
export async function verifyAttempt(
  options: VerifyAttemptOptions,
  deps: RunDeps = defaultRunDeps,
): Promise<AttemptView> {
  const { store } = context(options);
  const record = loadOpen(store, options.runId, options.attemptId);
  const run = store.load(options.runId);
  const plan = store.readPlan(run.runId);
  const item = plan?.items.find((candidate) => candidate.itemId === record.itemId);
  if (!plan || !item) throw new Error(`Attempt ${record.attemptId} refers to a plan item that no longer exists.`);

  const before = loadSnapshot(join(store.attemptDir(run.runId, record.attemptId), "before"));
  const ad = deps.attemptDeps ?? defaultAttemptDeps;
  const verification = await ad.verify(
    attemptVerifyRequest({
      checkout: record.worktreePath,
      packageManager: (plan.options.packageManager as Parameters<typeof attemptVerifyRequest>[0]["packageManager"] | undefined) ?? "npm",
      options: plan.options,
      before,
      advisories: store.readReport(run.runId)?.cveDetails ? [store.readReport(run.runId)!.cveDetails!] : [],
      expectedRemaining: expectedRemaining(plan, item, appliedItems(store, run.runId)),
      ...(options.checks ? { checks: options.checks } : {}),
    }),
  );

  const updated: AttemptRecord = {
    ...record,
    reason: verification.passed ? "Verified: finalize it." : `Not yet: ${verification.failedCheck} fails.`,
    changedFiles: verification.changedFiles ?? record.changedFiles,
    endedAt: new Date().toISOString(),
  };
  store.writeAttempt(run.runId, updated, { "verification.json": `${JSON.stringify(verification, null, 2)}\n` });
  store.ledger(run.runId).append("attempt.verify", {
    attemptId: record.attemptId,
    passed: verification.passed,
    ...(verification.failedCheck ? { failedCheck: verification.failedCheck } : {}),
  });
  return viewOf(updated, run.runId, withVerification(verification));
}

/**
 * Put an attempt's change in the project, if it verifies. The checkout is verified again first,
 * then the change is applied as a patch, re-checked in place and undone if that fails: exactly the
 * path the built-in agent's results take.
 */
export async function finalizeAttempt(
  options: AttemptQuery,
  deps: RunDeps = defaultRunDeps,
): Promise<AttemptView> {
  const { cwd, store } = context(options);
  const record = loadOpen(store, options.runId, options.attemptId);
  const run = store.load(options.runId);
  const plan = store.readPlan(run.runId);
  const item = plan?.items.find((candidate) => candidate.itemId === record.itemId);
  if (!plan || !item) throw new Error(`Attempt ${record.attemptId} refers to a plan item that no longer exists.`);
  if (!APPLICABLE_STATUSES.has(run.status)) throw new Error(`Run ${run.runId} is ${run.status}; nothing can be finalized.`);
  // Earned autonomy (opt-in via the policy): below L2 nothing is put in the project.
  assertAutonomyAllows(cwd, plan.options.policy, "apply", `Finalizing attempt ${record.attemptId}`);
  const applied = appliedItems(store, run.runId);
  if (applied.has(item.itemId)) throw new Error(`Item ${item.itemId} is already applied.`);
  if (!sameInputs(await fingerprintRepo(cwd, plan.options.policy), run.after ?? run.base)) {
    throw new Error("The project changed since this attempt began; abandon it and start again.");
  }

  const checked = await verifyAttempt(options, deps);
  if (!checked.verification?.passed) {
    return { ...checked, finalized: false, message: `Not finalized: ${checked.verification?.failedCheck} fails. Fix it and verify again.` };
  }

  const ad = deps.attemptDeps ?? defaultAttemptDeps;
  const release = store.acquireApplyLock(run.runId);
  try {
    await ensureRunSnapshot(store, run.runId, cwd);
    const advisories = store.readReport(run.runId)?.cveDetails;
    const promoted = await promoteChange({
      cwd,
      runDir: store.runDir(run.runId),
      diff: await ad.diff(record.worktreePath),
      policy: plan.options.policy,
      packageManager: plan.options.packageManager as Parameters<typeof attemptVerifyRequest>[0]["packageManager"],
      advisories: advisories ? [advisories] : [],
      expectedRemaining: expectedRemaining(plan, item, applied),
      deps: { verify: deps.verify, reinstall: () => deps.reinstall({ cwd, options: plan.options }) },
    });

    const ledger = store.ledger(run.runId);
    const closed: AttemptRecord = {
      ...record,
      status: promoted.ok ? "promoted" : "promotion-failed",
      reason: promoted.ok ? "Applied to the project." : promoted.message,
      endedAt: new Date().toISOString(),
    };
    delete closed.worktreePath;
    store.writeAttempt(run.runId, closed);
    await discardWorktree(cwd, record.worktreePath);
    ledger.append("attempt.done", { attemptId: record.attemptId, itemId: item.itemId, status: closed.status, rounds: 0 });

    const recordProblem = (problem: string) => ledger.append("autonomy.record-failed", { message: problem });
    // What the verifier established is what memory may keep: the tests ran in the checkout, and a
    // rejection in the project is the verifier's own finding.
    await recordMemory(
      cwd,
      run.runId,
      promoted.ok
        ? passedTestCommands(checked.verification).map((command) => testCommandEntry(command))
        : [rejectedUpgradeEntry(item, promoted.verification)],
      (problem) => ledger.append("memory.record-failed", { message: problem }),
    );
    if (!promoted.ok) {
      await recordOutcomes(cwd, plan.options.policy, [finalizeEvent(run, item.itemId, item.packageName, { promoted: false, message: promoted.message })], recordProblem);
      return viewOf(closed, run.runId, { finalized: false, verification: promoted.verification ?? checked.verification });
    }
    await recordOutcomes(
      cwd,
      plan.options.policy,
      [finalizeEvent(run, item.itemId, item.packageName, { promoted: true, message: "", verification: checked.verification })],
      recordProblem,
    );

    const after = await fingerprintRepo(cwd, plan.options.policy);
    ledger.append("item.done", {
      itemId: item.itemId,
      status: "applied",
      message: `Upgraded ${item.packageName} to ${item.toVersion} with a host agent's repair.`,
      verified: true,
      repair: { attemptId: record.attemptId, status: "promoted", rounds: 0, reason: record.reason },
      filesSha256: after.filesSha256,
    });
    applied.add(item.itemId);
    store.update(run.runId, {
      after,
      allowSourceEdits: true,
      status: plan.items.every((candidate) => applied.has(candidate.itemId)) ? "applied" : "partial",
    });
    return viewOf(closed, run.runId, { finalized: true, verification: promoted.verification ?? checked.verification, message: "Applied to the project." });
  } finally {
    release();
  }
}

/** Throw an open attempt away: its checkout is removed and nothing reaches the project. */
export async function abandonAttempt(options: AttemptQuery): Promise<AttemptView> {
  const { cwd, store } = context(options);
  const record = loadOpen(store, options.runId, options.attemptId);
  await discardWorktree(cwd, record.worktreePath);
  const closed: AttemptRecord = {
    ...record,
    status: "abandoned",
    reason: "Abandoned.",
    endedAt: new Date().toISOString(),
  };
  delete closed.worktreePath;
  store.writeAttempt(options.runId, closed);
  store.ledger(options.runId).append("attempt.done", { attemptId: record.attemptId, itemId: record.itemId, status: "abandoned", rounds: 0 });
  return viewOf(closed, options.runId);
}

