/**
 * The part of applying a package override that does not depend on where the override is written:
 * prove the bug first (optional), write the override, reinstall, check it took effect, run tests,
 * prove the fix (optional), and undo everything if any step fails. The two ways of writing an
 * override (a `deno.json` import map, or a manifest/workspace file) plug in as an `OverrideEdit`.
 */
import { rm } from "node:fs/promises";

import type { RemediationConstraints } from "../../../infra/policy/types.js";
import { errorMessage } from "../../../shared/errors.js";
import { safeExecaCommand } from "../../../shared/exec/safe-exec-command.js";
import { LONG_RUNNING_TIMEOUT_MS } from "../../../shared/timeouts.js";
import type { PackageManager } from "../../../shared/types.js";
import type { PatchResult } from "../../remediate/types.js";
import {
  assembleProofOfFixVerification,
  prepareReproductionTestFile,
  runProofOfFixPhase,
} from "../../verify/proof-of-fix/runner.js";
import type { ProofOfFixPhaseResult, ProofOfFixVerification } from "../../verify/types.js";

type UnresolvedReason = NonNullable<PatchResult["unresolvedReason"]>;

/** What an override attempt is about and which commands verify it. */
export interface OverrideContext {
  cwd: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  dryRun: boolean;
  runTests: boolean;
  installCommand: string[];
  testCommand: string[];
  dedupeCommand: string[];
  /** ` Dependency trace: ...`, or empty. Appended to every message that follows an install. */
  traceSuffix: string;
  patchesDir: string;
  proofOfFix?: boolean | string | undefined;
  reproductionTest?: string | undefined;
  requireProofOfFix?: boolean | undefined;
}

/** An override request as `execute` resolves it, before a dependency trace is attached. */
export interface OverrideRequest extends Omit<OverrideContext, "traceSuffix"> {
  pm: PackageManager;
  /** The key the override is written under: the package name unless the caller gave a selector. */
  overrideSelector: string;
  commandConstraints: RemediationConstraints;
}

/** One way of writing (and undoing) an override. */
export interface OverrideEdit {
  /** Completes "... failed after <this>": `updating deno.json imports for "x" to 1.2.3`. */
  appliedPhrase: string;
  /** Completes "Successfully <this> from A to B": `applied overrides for "x"`. */
  successPhrase: string;
  /** Run `dedupeCommand` after success. Only manifest-based overrides do. */
  dedupe: boolean;
  write(): void;
  restore(): void;
  /** After the install: a message when the override had no effect, otherwise undefined. */
  checkEffective?: () => string | undefined;
}

/** A result that changed nothing, with the reason and message that explain why. */
export function unresolvedResult(
  context: Pick<OverrideContext, "packageName" | "fromVersion" | "toVersion" | "dryRun">,
  reason: UnresolvedReason,
  message: string,
  strategy: PatchResult["strategy"] = "override",
): PatchResult {
  return {
    packageName: context.packageName,
    strategy,
    fromVersion: context.fromVersion,
    toVersion: context.toVersion,
    applied: false,
    dryRun: context.dryRun,
    unresolvedReason: reason,
    message,
  };
}

function runInstall(context: OverrideContext): Promise<unknown> {
  return safeExecaCommand(context.installCommand, {
    timeoutMs: LONG_RUNNING_TIMEOUT_MS,
    cwd: context.cwd,
    stdio: "pipe",
  });
}

/** Put the project back: restore the files, then reinstall. A failed reinstall is not fatal. */
async function rollback(context: OverrideContext, edit: OverrideEdit): Promise<void> {
  edit.restore();
  try {
    await runInstall(context);
  } catch {
    // The files are restored; a failed reinstall is reported by the next run.
  }
}

interface ProofSetup {
  /** Set when the proof stage already decided the outcome. */
  early?: PatchResult;
  reproTestPath: string | undefined;
  createdTestFile: boolean;
  negative: ProofOfFixPhaseResult | undefined;
}

async function removeCreatedTest(setup: ProofSetup): Promise<void> {
  if (setup.createdTestFile && setup.reproTestPath) {
    await rm(setup.reproTestPath, { force: true }).catch(() => {});
  }
}

/** Before touching anything: make sure the reproduction fails on the vulnerable version. */
async function proveBugFirst(context: OverrideContext): Promise<ProofSetup> {
  const prepared = await prepareReproductionTestFile({
    cwd: context.cwd,
    packageName: context.packageName,
    vulnerableVersion: context.fromVersion,
    patchesDir: context.patchesDir,
    proofOfFix: context.proofOfFix,
    reproductionTest: context.reproductionTest,
  });
  const setup: ProofSetup = {
    reproTestPath: prepared.testFilePath,
    createdTestFile: prepared.isCreated,
    negative: undefined,
  };
  const proofActive = Boolean(
    setup.reproTestPath || context.proofOfFix || context.requireProofOfFix,
  );
  if (!proofActive) return setup;
  if (!setup.reproTestPath) {
    if (context.requireProofOfFix) {
      setup.early = unresolvedResult(
        context,
        "policy-blocked",
        "Proof-of-fix verification required, but no reproduction test or script was supplied.",
        "none",
      );
    }
    return setup;
  }
  setup.negative = await runProofOfFixPhase({
    stage: "negative",
    testFilePath: setup.reproTestPath,
    cwd: context.cwd,
  });
  if (!setup.negative.passed) {
    await removeCreatedTest(setup);
    setup.early = unresolvedResult(
      context,
      context.requireProofOfFix ? "policy-blocked" : "proof-of-fix-failed",
      `Proof-of-fix negative phase failed: ${setup.negative.error}`,
    );
  }
  return setup;
}

/** After the override: the same reproduction must now pass. */
async function proveFixAfter(
  context: OverrideContext,
  edit: OverrideEdit,
  setup: ProofSetup,
): Promise<{ failure?: PatchResult; verification?: ProofOfFixVerification }> {
  if (!setup.reproTestPath || !setup.negative?.passed) return {};
  const positive = await runProofOfFixPhase({
    stage: "positive",
    testFilePath: setup.reproTestPath,
    cwd: context.cwd,
  });
  if (!positive.passed) {
    await rollback(context, edit);
    await removeCreatedTest(setup);
    return {
      failure: unresolvedResult(
        context,
        context.requireProofOfFix ? "policy-blocked" : "proof-of-fix-failed",
        `Proof-of-fix positive phase failed: ${positive.error}`,
      ),
    };
  }
  return {
    verification: assembleProofOfFixVerification({
      reproductionTestPath: setup.reproTestPath,
      negativePhase: setup.negative,
      positivePhase: positive,
      regressionPhase: { executed: context.runTests, passed: true },
    }),
  };
}

/** Run the project's tests; on failure undo the override and say what failed. */
async function testsOrRollback(
  context: OverrideContext,
  edit: OverrideEdit,
): Promise<PatchResult | undefined> {
  if (!context.runTests) return undefined;
  try {
    await safeExecaCommand(context.testCommand, {
      timeoutMs: LONG_RUNNING_TIMEOUT_MS,
      cwd: context.cwd,
      stdio: "pipe",
    });
    return undefined;
  } catch (error) {
    await rollback(context, edit);
    return unresolvedResult(
      context,
      "validation-failed",
      `${context.testCommand.join(" ")} failed after ${edit.appliedPhrase}. Reverted. Error: ${errorMessage(error)}${context.traceSuffix}`,
    );
  }
}

/** Dedupe is best effort: a failure is a note on the result, never a rollback. */
async function dedupeNote(context: OverrideContext): Promise<string> {
  if (context.dedupeCommand.length === 0) return "";
  try {
    await safeExecaCommand(context.dedupeCommand, {
      timeoutMs: LONG_RUNNING_TIMEOUT_MS,
      cwd: context.cwd,
      stdio: "pipe",
    });
    return "";
  } catch (error) {
    return ` Dedupe warning: ${context.dedupeCommand.join(" ")} failed (${errorMessage(error)}).`;
  }
}

function successMessage(context: OverrideContext, edit: OverrideEdit, note: string): string {
  const tested = context.runTests ? ` and passed ${context.testCommand.join(" ")}` : "";
  return `Successfully ${edit.successPhrase} from ${context.fromVersion} to ${context.toVersion}, then ran ${context.installCommand.join(" ")}${tested}.${note}${context.traceSuffix}`;
}

/** Applies one override end to end. The caller holds the repository lock. */
export async function runOverrideTransaction(
  context: OverrideContext,
  edit: OverrideEdit,
): Promise<PatchResult> {
  const setup = await proveBugFirst(context);
  if (setup.early) return setup.early;

  edit.write();
  try {
    await runInstall(context);
  } catch (error) {
    edit.restore();
    return unresolvedResult(
      context,
      "override-apply-failed",
      `${context.installCommand.join(" ")} failed after ${edit.appliedPhrase}. Reverted. Error: ${errorMessage(error)}${context.traceSuffix}`,
    );
  }

  const ineffective = edit.checkEffective?.();
  if (ineffective !== undefined) {
    await rollback(context, edit);
    return unresolvedResult(
      context,
      "override-apply-failed",
      `${ineffective}${context.traceSuffix}`,
    );
  }

  const testFailure = await testsOrRollback(context, edit);
  if (testFailure) return testFailure;

  const proof = await proveFixAfter(context, edit, setup);
  if (proof.failure) return proof.failure;

  const note = edit.dedupe ? await dedupeNote(context) : "";
  return {
    packageName: context.packageName,
    strategy: "override",
    fromVersion: context.fromVersion,
    toVersion: context.toVersion,
    applied: true,
    dryRun: false,
    proofOfFix: proof.verification,
    message: successMessage(context, edit, note),
  };
}
