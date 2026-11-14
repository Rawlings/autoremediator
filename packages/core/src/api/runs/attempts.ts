/**
 * Attempts driven by a host agent (Claude Code, Cursor, Copilot, ...) rather than by the built-in
 * one. The host gets an isolated checkout with the upgrade applied and the verifier's findings; it
 * edits (or proposes patches), asks for verification as often as it likes, and finalizes. The same
 * verifier and the same promotion step as the built-in agent decide what reaches the project.
 */
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { createProjectSnapshot } from "../../platform/rollback.js";
import { safeExeca } from "../../platform/safe-exec.js";
import type { RepairFailure } from "../../platform/repair-agent.js";
import {
  attemptVerifyRequest,
  defaultAttemptDeps,
  failureOf,
} from "../../remediation/repair/attempt.js";
import { ScopeGuard, ScopeViolation } from "../../remediation/repair/scope-guard.js";
import type { CheckName, VerificationResult } from "../../remediation/verify/types.js";
import { fingerprintRepo, sameInputs } from "../../runs/fingerprint.js";
import { newAttemptId } from "../../runs/ids.js";
import type { PlanItem, RemediationPlan } from "../../runs/plan.js";
import { type AttemptRecord, type AttemptStatus, RunStore } from "../../runs/run-store.js";
import { loadSnapshot, saveSnapshot } from "../../runs/snapshot-store.js";
import { discardWorktree } from "../../runs/worktree.js";
import { defaultRunDeps, type RunDeps } from "./deps.js";
import { APPLICABLE_STATUSES, ensureRunSnapshot, promoteChange } from "./repair.js";

const MAX_OPEN_ATTEMPTS = 4;
const MAX_PATCH_BYTES = 200_000;

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
  /** `finalizeAttempt` only: whether the change reached the project. */
  finalized?: boolean;
  message: string;
}

function viewOf(record: AttemptRecord, runId: string, extra: Partial<AttemptView> = {}): AttemptView {
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

const withVerification = (verification: VerificationResult): Partial<AttemptView> => ({
  verification,
  ...(verification.passed ? {} : { failure: failureOf(verification) }),
  changedFiles: verification.changedFiles ?? [],
});

function context(options: { cwd?: string; runId: string }) {
  const cwd = options.cwd ?? process.cwd();
  return { cwd, store: new RunStore(cwd) };
}

function loadOpen(store: RunStore, runId: string, attemptId: string): AttemptRecord & { worktreePath: string } {
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
  return viewOf(record, run.runId, withVerification(verification));
}

// ---------------------------------------------------------------------------

const FORBIDDEN_PATCH = [
  [/^GIT binary patch/m, "binary changes"],
  [/^Binary files /m, "binary changes"],
  [/^(old|new) mode /m, "file mode changes"],
  [/^(rename|copy) (from|to) /m, "renames and copies"],
  [/^new file mode 120000/m, "symbolic links"],
] as const;

/**
 * Apply a unified diff to an open attempt's checkout. Only project source may change, as for the
 * built-in agent, and the patch must be plain text and apply cleanly.
 */
export async function proposePatch(options: ProposePatchOptions): Promise<AttemptView> {
  const { store } = context(options);
  const record = loadOpen(store, options.runId, options.attemptId);
  const { diff } = options;

  if (diff.trim().length === 0) throw new Error("The patch is empty.");
  if (Buffer.byteLength(diff) > MAX_PATCH_BYTES) throw new Error(`The patch is larger than ${MAX_PATCH_BYTES} bytes.`);
  for (const [pattern, what] of FORBIDDEN_PATCH) {
    if (pattern.test(diff)) throw new Error(`The patch contains ${what}, which an attempt may not change.`);
  }
  const text = diff.endsWith("\n") ? diff : `${diff}\n`;

  const top = (await safeExeca("git", ["rev-parse", "--show-toplevel"], { cwd: record.worktreePath, stdio: "pipe" })).stdout.trim();
  let files: string[];
  try {
    const numstat = await safeExeca("git", ["apply", "--numstat", "-"], { cwd: top, input: text, stdio: "pipe" });
    files = numstat.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[2] ?? "").filter(Boolean);
  } catch (cause) {
    throw new Error("The patch is not a valid unified diff.", { cause });
  }
  if (files.length === 0) throw new Error("The patch changes no files.");

  const guard = new ScopeGuard(record.worktreePath);
  for (const file of files) {
    try {
      guard.assertWritable(resolve(top, file));
    } catch (error) {
      if (error instanceof ScopeViolation) throw new Error(`Patch refused: ${error.message}`, { cause: error });
      throw error;
    }
  }

  try {
    await safeExeca("git", ["apply", "--check", "-"], { cwd: top, input: text, stdio: "pipe" });
  } catch (cause) {
    throw new Error("The patch does not apply to the checkout as it is now (read the files again and rebase it).", { cause });
  }
  await safeExeca("git", ["apply", "-"], { cwd: top, input: text, stdio: "pipe" });

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

    if (!promoted.ok) return viewOf(closed, run.runId, { finalized: false, verification: promoted.verification ?? checked.verification });

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

