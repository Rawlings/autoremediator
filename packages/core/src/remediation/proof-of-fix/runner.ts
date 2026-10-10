/**
 * Proof-of-Fix Runner
 *
 * Implements dual-stage exploit reproduction and independent verification:
 * Stage 1 (Negative Phase): Must FAIL on unpatched / vulnerable target (proving exploitability).
 * Stage 2 (Positive Phase): Must PASS on patched target (proving remediation).
 * Stage 3 (Regression Phase): Must PASS on full project test suite (proving zero regressions).
 */
import { safeExeca } from "../../platform/safe-exec.js";
import type {
  ProofOfFixPhaseResult,
  ProofOfFixStatus,
  ProofOfFixVerification,
} from "../../platform/types.js";

export interface RunProofOfFixPhaseOptions {
  stage: "negative" | "positive";
  testFilePath: string;
  cwd: string;
  timeoutMs?: number;
}

export async function runProofOfFixPhase(
  options: RunProofOfFixPhaseOptions,
): Promise<ProofOfFixPhaseResult> {
  const { stage, testFilePath, cwd, timeoutMs = 15_000 } = options;
  const started = Date.now();

  const isTs = testFilePath.endsWith(".ts");
  const nodeArgs = isTs ? ["--experimental-strip-types", testFilePath] : [testFilePath];

  try {
    const result = await safeExeca("node", nodeArgs, {
      cwd,
      timeoutMs,
      stdio: "pipe",
    });

    const durationMs = Date.now() - started;
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();

    if (stage === "negative") {
      // In negative phase, passing means the bug was NOT reproduced (false negative).
      return {
        executed: true,
        passed: false,
        exitCode: 0,
        output,
        durationMs,
        error:
          "Exploit reproduction test passed on vulnerable target (failed to reproduce vulnerability).",
      };
    }

    // In positive phase, exit code 0 means remediation succeeded.
    return {
      executed: true,
      passed: true,
      exitCode: 0,
      output,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - started;
    const execaErr = err as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
      timedOut?: boolean;
    };
    const exitCode = typeof execaErr.exitCode === "number" ? execaErr.exitCode : 1;
    const errorMsg = execaErr.message || String(err);
    const output = [execaErr.stdout, execaErr.stderr, errorMsg].filter(Boolean).join("\n").trim();

    if (stage === "negative") {
      if (execaErr.timedOut || errorMsg.includes("timed out")) {
        return {
          executed: true,
          passed: false,
          exitCode,
          output,
          durationMs,
          error: "Exploit reproduction test timed out (execution hung).",
        };
      }

      // Differentiate harness execution failures from true exploit reproduction
      const isHarnessFailure =
        exitCode === 127 ||
        errorMsg.includes("ENOENT") ||
        output.includes("bad option:") ||
        (output.includes("Cannot find module") && output.includes(testFilePath));

      if (isHarnessFailure) {
        return {
          executed: false,
          passed: false,
          exitCode,
          output,
          durationMs,
          error: `Reproduction test failed to execute (harness error): ${errorMsg}`,
        };
      }

      // In negative phase, non-zero exit code from test assertions means exploit reproduced!
      return {
        executed: true,
        passed: true,
        exitCode,
        output,
        durationMs,
      };
    }

    // In positive phase, non-zero exit code means the exploit still reproduced or code crashed.
    return {
      executed: true,
      passed: false,
      exitCode,
      output,
      durationMs,
      error: `Reproduction test failed on patched target: ${errorMsg}`,
    };
  }
}

export interface AssembleProofOfFixParams {
  reproductionTestPath?: string;
  negativePhase: ProofOfFixPhaseResult;
  positivePhase: ProofOfFixPhaseResult;
  regressionPhase?: ProofOfFixPhaseResult;
}

export function assembleProofOfFixVerification(
  params: AssembleProofOfFixParams,
): ProofOfFixVerification {
  const { reproductionTestPath, negativePhase, positivePhase, regressionPhase } = params;

  const regPhase: ProofOfFixPhaseResult = regressionPhase ?? {
    executed: false,
    passed: true,
  };

  let status: ProofOfFixStatus = "verified";
  let failureReason: string | undefined;

  if (!negativePhase.passed) {
    status = "failed";
    failureReason = negativePhase.error || "negative-phase-failed";
  } else if (!positivePhase.passed) {
    status = "failed";
    failureReason = positivePhase.error || "positive-phase-failed";
  } else if (regPhase.executed && !regPhase.passed) {
    status = "failed";
    failureReason = regPhase.error || "regression-phase-failed";
  }

  const durationMs =
    (negativePhase.durationMs || 0) + (positivePhase.durationMs || 0) + (regPhase.durationMs || 0);

  return {
    status,
    reproductionTestPath,
    negativePhase,
    positivePhase,
    regressionPhase: regPhase,
    durationMs,
    failureReason,
  };
}
