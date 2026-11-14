import { createProjectSnapshot, type ProjectSnapshot } from "../../platform/rollback.js";
import type {
  RepairAgent,
  RepairBudget,
  RepairCommands,
  RepairFailure,
  RepairOutcome,
  TranscriptEntry,
} from "../../platform/repair-agent.js";
import {
  detectPackageManager,
  resolveTestCommand,
  resolveTypecheckCommand,
} from "../../platform/package-manager/index.js";
import type {
  CveDetails,
  LlmUsageMetrics,
  PackageManager,
  PatchResult,
} from "../../platform/types.js";
import { createWorktree, worktreeDiff, type Worktree } from "../../runs/worktree.js";
import { applyPackageOverrideTool } from "../tools/apply-package-override/index.js";
import { applyVersionBumpTool } from "../tools/apply-version-bump.js";
import type { PlanItem, PlanOptions } from "../../runs/plan.js";
import { verify } from "../verify/verifier.js";
import type { CheckName, VerificationResult, VerifyRequest } from "../verify/types.js";

/** Everything except `install`: the agent cannot change dependencies, and the upgrade already installed. */
export const ATTEMPT_CHECKS: readonly CheckName[] = [
  "scope",
  "policy",
  "supply-chain",
  "vuln-gone",
  "typecheck",
  "tests",
  "proof-of-fix",
];

export type AttemptStatus = "verified" | "rejected" | "failed";

export interface AttemptResult {
  status: AttemptStatus;
  /** Why it did not verify, or what the agent said it did. */
  reason: string;
  /** Times the agent was handed the verifier's findings. */
  rounds: number;
  /** The change, as a patch against the project's HEAD (only meaningful when verified). */
  diff: string;
  verification?: VerificationResult;
  changedFiles: string[];
  usage: LlmUsageMetrics[];
  transcript: TranscriptEntry[];
  agentId: string;
}

export interface AttemptRequest {
  /** The project. */
  cwd: string;
  runId: string;
  attemptId: string;
  item: PlanItem;
  options: PlanOptions;
  advisories: readonly CveDetails[];
  /** Packages the plan knowingly leaves vulnerable. */
  expectedRemaining: readonly string[];
  agent: RepairAgent;
  budget: RepairBudget;
  signal: AbortSignal;
}

export interface AttemptDeps {
  createWorktree: (cwd: string, name: string) => Promise<Worktree>;
  /** Make the upgrade in the checkout and install it, without validating it. */
  applyUpgrade: (item: PlanItem, checkout: string, options: PlanOptions) => Promise<PatchResult>;
  verify: (request: VerifyRequest) => Promise<VerificationResult>;
  diff: (checkout: string) => Promise<string>;
}

export const defaultAttemptDeps: AttemptDeps = {
  createWorktree: (cwd, name) => createWorktree(cwd, name),
  async applyUpgrade(item, checkout, options) {
    const shared = {
      cwd: checkout,
      packageName: item.packageName,
      fromVersion: item.fromVersion,
      toVersion: item.toVersion,
      dryRun: false,
      policy: options.policy,
      // Only the upgrade and its install: whether the project still works is what the agent is for.
      runTests: false,
      installMode: options.constraints?.installMode,
      installPreferOffline: options.constraints?.installPreferOffline,
      workspace: options.constraints?.workspace,
      ...(options.packageManager
        ? { packageManager: options.packageManager as PackageManager }
        : {}),
    };
    return item.strategy === "version-bump"
      ? applyVersionBumpTool.execute({ ...shared, typecheck: false, breakingChangeRefactor: false })
      : applyPackageOverrideTool.execute(shared);
  },
  verify,
  diff: worktreeDiff,
};

/** The verification of an attempt's checkout against what the project was when it began. */
export function attemptVerifyRequest(params: {
  checkout: string;
  packageManager: PackageManager;
  options: PlanOptions;
  before: Pick<ProjectSnapshot, "fileSnapshots" | "isGit" | "gitStatusBefore">;
  advisories: readonly CveDetails[];
  expectedRemaining: readonly string[];
  checks?: readonly CheckName[];
}): VerifyRequest {
  const { options, before } = params;
  return {
    cwd: params.checkout,
    packageManager: params.packageManager,
    policy: options.policy,
    baseFiles: before.fileSnapshots,
    statusBefore: before.isGit ? (before.gitStatusBefore ?? []) : undefined,
    advisories: params.advisories,
    expectedRemaining: params.expectedRemaining,
    options: {
      ...(options.runTests === undefined ? {} : { runTests: options.runTests }),
      ...(options.typecheck === undefined ? {} : { typecheck: options.typecheck }),
      ...(options.proofOfFix === undefined ? {} : { proofOfFix: options.proofOfFix }),
      ...(options.requireProofOfFix === undefined ? {} : { requireProofOfFix: options.requireProofOfFix }),
      ...(options.reproductionTest ? { reproductionTest: options.reproductionTest } : {}),
      ...(options.constraints ? { constraints: options.constraints } : {}),
      allowSourceEdits: true,
    },
    checks: params.checks ?? ATTEMPT_CHECKS,
  };
}

/** The project's own commands an agent may run in a checkout. */
export function commandsFor(
  checkout: string,
  options: PlanOptions,
  packageManager: PackageManager,
): RepairCommands {
  const typecheck = resolveTypecheckCommand(packageManager, options.constraints, checkout);
  return {
    ...(typecheck.length > 0 ? { typecheck } : {}),
    tests: resolveTestCommand(packageManager, options.constraints),
  };
}

/** The verifier's findings, in terms an agent (or a host) can act on. */
export function failureOf(result: VerificationResult): RepairFailure {
  const failed = result.checks.find((check) => check.name === result.failedCheck);
  return {
    failedCheck: result.failedCheck ?? "unknown",
    summary: result.checks.map((check) => `${check.name}: ${check.status} (${check.message})`),
    details: failed?.details ?? [],
  };
}

const sum = (usage: readonly LlmUsageMetrics[], key: "inputTokens" | "outputTokens") =>
  usage.reduce((total, entry) => total + (entry[key] ?? 0), 0);

/**
 * Try to make an upgrade work, in an isolated checkout. The upgrade is applied, the verifier says
 * what is wrong, and the agent is asked to fix it; each time it submits, the verifier judges
 * again, and its findings go back to the agent, up to the round limit. Nothing here touches the
 * project: the outcome is a patch that was verified, or a reason it was not.
 */
export async function runRepairAttempt(
  request: AttemptRequest,
  deps: AttemptDeps = defaultAttemptDeps,
): Promise<AttemptResult> {
  const { agent, budget, item, options } = request;
  const usage: LlmUsageMetrics[] = [];
  const transcript: TranscriptEntry[] = [];
  const base = { agentId: agent.id, usage, transcript, changedFiles: [] as string[], diff: "" };
  const fail = (status: AttemptStatus, reason: string, rounds: number, verification?: VerificationResult): AttemptResult => ({
    ...base,
    status,
    reason,
    rounds,
    ...(verification ? { verification } : {}),
  });

  const checkout = await deps.createWorktree(request.cwd, request.attemptId);
  try {
    const packageManager = (options.packageManager as PackageManager | undefined) ?? detectPackageManager(checkout.path);
    const before = await createProjectSnapshot(checkout.path);

    const upgraded = await deps.applyUpgrade(item, checkout.path, options);
    if (!upgraded.applied) {
      return fail("failed", `the upgrade could not be applied in a clean checkout: ${upgraded.message}`, 0);
    }

    const judge = (): Promise<VerificationResult> =>
      deps.verify(
        attemptVerifyRequest({
          checkout: checkout.path,
          packageManager,
          options,
          before,
          advisories: request.advisories,
          expectedRemaining: request.expectedRemaining,
        }),
      );

    let verification = await judge();
    let rounds = 0;
    const previousRounds: string[] = [];

    while (!verification.passed && rounds < budget.maxRepairRounds) {
      if (request.signal.aborted) return fail("rejected", "the attempt was cancelled", rounds, verification);
      const spent = sum(usage, "inputTokens") + sum(usage, "outputTokens");
      if (budget.maxTotalTokens !== undefined && spent >= budget.maxTotalTokens) {
        return fail("rejected", "the token budget was used up", rounds, verification);
      }

      rounds += 1;
      let outcome: RepairOutcome;
      try {
        outcome = await agent.repair(
        {
          runId: request.runId,
          attemptId: request.attemptId,
          cveId: item.cveId,
          packageName: item.packageName,
          fromVersion: item.fromVersion,
          toVersion: item.toVersion,
          round: rounds,
          failure: failureOf(verification),
          previousRounds: [...previousRounds],
        },
        {
          worktree: checkout.path,
          budget: {
            ...budget,
            ...(budget.maxTotalTokens === undefined ? {} : { maxTotalTokens: budget.maxTotalTokens - spent }),
          },
          signal: request.signal,
          commands: commandsFor(checkout.path, options, packageManager),
        },
      );
      } catch (error) {
        return fail("failed", `the agent failed: ${error instanceof Error ? error.message : String(error)}`, rounds, verification);
      }
      usage.push(...outcome.usage);
      transcript.push(...outcome.transcript);

      if (outcome.status !== "submitted") {
        return fail("rejected", `the agent ${outcome.status === "gave-up" ? "gave up" : "ran out of budget"}: ${outcome.rationale}`, rounds, verification);
      }
      previousRounds.push(outcome.rationale);
      verification = await judge();
    }

    if (!verification.passed) {
      const failed = verification.checks.find((check) => check.name === verification.failedCheck);
      return fail(
        "rejected",
        `the verifier still rejects it after ${rounds} round(s): ${verification.failedCheck}: ${failed?.message ?? ""}`,
        rounds,
        verification,
      );
    }

    return {
      ...base,
      status: "verified",
      reason: previousRounds.at(-1) ?? "the upgrade works as it is",
      rounds,
      diff: await deps.diff(checkout.path),
      verification,
      changedFiles: verification.changedFiles ?? [],
    };
  } finally {
    await checkout.remove();
  }
}
