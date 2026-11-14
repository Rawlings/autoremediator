import { join, relative, resolve } from "node:path";

import type { RepairAgent, RepairBudget } from "../../platform/repair-agent.js";
import {
  createProjectSnapshot,
  discoverProjectFiles,
  restoreProjectSnapshot,
} from "../../platform/rollback.js";
import { safeExeca } from "../../platform/safe-exec.js";
import type { CveDetails, LlmUsageMetrics } from "../../platform/types.js";
import type { AttemptRequest, AttemptResult } from "../../remediation/repair/attempt.js";
import type { VerificationResult, VerifyRequest } from "../../remediation/verify/types.js";
import { recipeId, serializeRecipe } from "../../recipes/schema.js";
import { newAttemptId } from "../../runs/ids.js";
import type { PlanItem, RemediationPlan } from "../../runs/plan.js";
import type { AttemptRecord, AttemptStatus, RunStatus, RunStore } from "../../runs/run-store.js";
import { addToSnapshot, saveSnapshot } from "../../runs/snapshot-store.js";
import { recipeFromAttempt } from "./recipes.js";

export const SNAPSHOT_DIR = "snapshot";
export const SNAPSHOT_MANIFEST = `${SNAPSHOT_DIR}/snapshot.json`;

/** States in which a run still has changes to make. */
export const APPLICABLE_STATUSES = new Set<RunStatus>(["planned", "applying", "failed", "partial"]);

/**
 * Take the run's rollback snapshot before its first change; later calls do nothing, because the
 * state before the first change is the one a rollback must return to.
 */
export async function ensureRunSnapshot(store: RunStore, runId: string, cwd: string): Promise<void> {
  if (store.hasFile(runId, SNAPSHOT_MANIFEST)) return;
  saveSnapshot(join(store.runDir(runId), SNAPSHOT_DIR), await createProjectSnapshot(cwd));
  store.ledger(runId).append("snapshot.saved", { dir: SNAPSHOT_DIR });
}

/** The cheap checks run on the real project after a verified change is applied to it. */
const PROMOTION_CHECKS = ["scope", "policy", "supply-chain", "vuln-gone"] as const;

export interface PromoteDeps {
  verify: (request: VerifyRequest) => Promise<VerificationResult>;
  reinstall: () => Promise<void>;
}

export interface PromotionResult {
  ok: boolean;
  message: string;
  verification?: VerificationResult;
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await safeExeca("git", args, {
    cwd,
    stdio: "pipe",
    ...(input === undefined ? {} : { input }),
  });
  return result.stdout;
}

/** Files a patch touches, relative to the repository root. */
async function patchFiles(root: string, diff: string): Promise<string[]> {
  const stat = await git(root, ["apply", "--numstat", "-"], diff);
  return stat
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[2] ?? "")
    .filter(Boolean);
}

/**
 * Apply a change that an attempt verified in its own checkout to the real project. It is checked
 * again where it lands: a patch that no longer applies, or fails the cheap checks in place, is
 * taken back out and the project is left as it was.
 */
export async function promoteChange(params: {
  cwd: string;
  runDir: string;
  diff: string;
  policy?: string;
  packageManager?: VerifyRequest["packageManager"];
  advisories: readonly CveDetails[];
  expectedRemaining: readonly string[];
  deps: PromoteDeps;
}): Promise<PromotionResult> {
  const { cwd, diff, deps } = params;
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!root) return { ok: false, message: "the project is not a git repository" };

  const files = await patchFiles(root, diff).catch(() => undefined);
  if (!files) return { ok: false, message: "the verified change is not a valid patch" };
  const absolute = files.map((file) => resolve(root, file));
  const outside = absolute.filter((file) => relative(resolve(cwd), file).startsWith(".."));
  if (outside.length > 0) {
    return { ok: false, message: `the change touches files outside the project directory: ${outside.join(", ")}` };
  }

  try {
    await git(root, ["apply", "--check", "-"], diff);
  } catch {
    return { ok: false, message: "the verified change no longer applies to the project (it changed since the attempt began)" };
  }

  // Everything the change touches, plus the usual dependency files, so a failure can be undone.
  const before = await createProjectSnapshot(cwd, [...discoverProjectFiles(cwd), ...absolute]);
  addToSnapshot(
    `${params.runDir}/${SNAPSHOT_DIR}`,
    new Map(files.map((file) => [relative(resolve(cwd), resolve(root, file)), before.fileSnapshots.get(relative(resolve(cwd), resolve(root, file))) ?? null])),
  );

  const undo = async (message: string, verification?: VerificationResult): Promise<PromotionResult> => {
    await restoreProjectSnapshot(before);
    await deps.reinstall().catch(() => undefined);
    return { ok: false, message, ...(verification ? { verification } : {}) };
  };

  try {
    await git(root, ["apply", "-"], diff);
  } catch (error) {
    return undo(`applying the verified change failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }

  try {
    await deps.reinstall();
  } catch (error) {
    return undo(`installing after applying the change failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }

  const verification = await deps.verify({
    cwd,
    ...(params.packageManager ? { packageManager: params.packageManager } : {}),
    policy: params.policy,
    baseFiles: before.fileSnapshots,
    statusBefore: before.isGit ? (before.gitStatusBefore ?? []) : undefined,
    advisories: params.advisories,
    expectedRemaining: params.expectedRemaining,
    options: { allowSourceEdits: true },
    checks: PROMOTION_CHECKS,
  });
  if (!verification.passed) {
    const failed = verification.checks.find((check) => check.name === verification.failedCheck);
    return undo(`the change failed verification in the project (${verification.failedCheck}): ${failed?.message ?? ""}`, verification);
  }
  return { ok: true, message: "applied to the project", verification };
}

// ---------------------------------------------------------------------------

export interface RepairItemContext {
  cwd: string;
  store: RunStore;
  runId: string;
  item: PlanItem;
  plan: RemediationPlan;
  advisories: readonly CveDetails[];
  expectedRemaining: readonly string[];
  /** Without one, only recipes are tried. */
  agent: RepairAgent | undefined;
  budget: RepairBudget;
  signal: AbortSignal;
}

export interface RepairItemResult {
  attemptId: string;
  status: AttemptStatus;
  message: string;
  rounds: number;
  usage: LlmUsageMetrics[];
  /** `recipe:<id>` when a recipe did it. */
  agentId: string;
  verification?: VerificationResult;
}

export interface RepairItemDeps {
  attempt: (request: AttemptRequest) => Promise<AttemptResult>;
  promote: PromoteDeps;
}

const sum = (usage: readonly LlmUsageMetrics[], key: "inputTokens" | "outputTokens") =>
  usage.reduce((total, entry) => total + (entry[key] ?? 0), 0);

/**
 * Have an agent make an upgrade work, then put the verified result in the project. Everything the
 * attempt did is kept with the run: the patch, what the agent said and did, and what the verifier
 * made of it.
 */
export async function repairItem(
  context: RepairItemContext,
  deps: RepairItemDeps,
): Promise<RepairItemResult> {
  const { store, runId, item } = context;
  const attemptId = newAttemptId();
  const ledger = store.ledger(runId);
  const startedAt = new Date().toISOString();
  ledger.append("attempt.start", { attemptId, itemId: item.itemId, agent: context.agent?.id ?? "recipes" });

  const attempt = await deps.attempt({
    cwd: context.cwd,
    runId,
    attemptId,
    item,
    options: context.plan.options,
    advisories: context.advisories,
    expectedRemaining: context.expectedRemaining,
    agent: context.agent,
    budget: context.budget,
    signal: context.signal,
  });

  let status: AttemptStatus = attempt.status;
  let reason = attempt.reason;
  let verification = attempt.verification;
  let recipeJson: string | undefined;

  if (attempt.status === "verified" && attempt.diff.trim().length > 0) {
    const promoted = await promoteChange({
      cwd: context.cwd,
      runDir: store.runDir(runId),
      diff: attempt.diff,
      policy: context.plan.options.policy,
      packageManager: context.plan.options.packageManager as VerifyRequest["packageManager"],
      advisories: context.advisories,
      expectedRemaining: context.expectedRemaining,
      deps: deps.promote,
    });
    status = promoted.ok ? "promoted" : "promotion-failed";
    reason = promoted.ok ? attempt.reason : promoted.message;
    verification = promoted.verification ?? verification;

    // What an agent learned is kept with the attempt, ready for `recipes capture`. A recipe's own fix is not recaptured.
    if (promoted.ok && !attempt.agentId.startsWith("recipe:")) {
      const captured = recipeFromAttempt({
        diff: attempt.diff,
        packageName: item.packageName,
        fromVersion: item.fromVersion,
        toVersion: item.toVersion,
        runId,
        attemptId,
        agentId: attempt.agentId,
        failure: attempt.initialFailure,
        verification: attempt.verification,
        summary: attempt.reason,
      });
      if ("recipe" in captured) {
        recipeJson = serializeRecipe(captured.recipe);
        ledger.append("recipe.captured", { attemptId, itemId: item.itemId, recipeId: recipeId(captured.recipe) });
      } else {
        ledger.append("recipe.not-captured", { attemptId, itemId: item.itemId, reason: captured.error });
      }
    }
  }

  const record: AttemptRecord = {
    attemptId,
    itemId: item.itemId,
    agentId: attempt.agentId,
    status,
    reason,
    rounds: attempt.rounds,
    changedFiles: attempt.changedFiles,
    ...(attempt.usage.length > 0
      ? { inputTokens: sum(attempt.usage, "inputTokens"), outputTokens: sum(attempt.usage, "outputTokens") }
      : {}),
    startedAt,
    endedAt: new Date().toISOString(),
  };
  store.writeAttempt(runId, record, {
    ...(attempt.diff ? { "diff.patch": attempt.diff } : {}),
    ...(recipeJson ? { "recipe.json": recipeJson } : {}),
    ...(verification ? { "verification.json": `${JSON.stringify(verification, null, 2)}\n` } : {}),
    ...(attempt.transcript.length > 0
      ? { "transcript.jsonl": `${attempt.transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n` }
      : {}),
  });
  ledger.append("attempt.done", { attemptId, itemId: item.itemId, status, rounds: attempt.rounds });

  return {
    attemptId,
    status,
    message: reason,
    rounds: attempt.rounds,
    usage: attempt.usage,
    agentId: attempt.agentId,
    ...(verification ? { verification } : {}),
  };
}
