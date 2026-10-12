/**
 * Proof-of-Fix Runner
 *
 * Implements dual-stage exploit reproduction and independent verification:
 * Stage 1 (Negative Phase): Must FAIL assertion on unpatched / vulnerable target (proving exploitability).
 * Stage 2 (Positive Phase): Must PASS on patched target (proving remediation).
 * Stage 3 (Regression Phase): Must PASS on full project test suite (proving zero regressions).
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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

export interface HarnessFailureContext {
  exitCode?: number;
  output: string;
  errorMsg?: string;
  testFilePath?: string;
  signal?: string;
}

/**
 * Sanitizes file paths and directory names from diagnostic text
 * to prevent repository paths from colliding with error classification tokens.
 */
export function sanitizePathLeakage(text: string, paths: (string | undefined)[] = []): string {
  let sanitized = text;
  for (const p of paths) {
    if (!p || p.trim().length === 0) continue;
    sanitized = sanitized.split(p).join("<path>");
  }
  return sanitized;
}

/**
 * Strips V8 / Node.js call site stack frames (`    at ...`) from diagnostic text
 * so that directory names and file paths in stack traces never leak into token matching.
 */
export function stripStackTraceFrames(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*at\s+/.test(line))
    .join("\n");
}

/**
 * Determines whether a process failure was caused by harness / execution defects
 * (syntax error, missing module, missing file, bad CLI flag, fatal signal, or runtime crash)
 * rather than a genuine exploit assertion failure.
 */
export function isHarnessFailure(context: HarnessFailureContext): boolean {
  const { exitCode, output, errorMsg = "", signal } = context;
  const errorMsgEmbedsPath =
    errorMsg.includes("Command failed") ||
    (context.testFilePath && errorMsg.includes(context.testFilePath)) ||
    errorMsg.includes("/") ||
    errorMsg.includes("\\");
  const filteredErrorMsg = errorMsgEmbedsPath ? "" : errorMsg;
  const combined = filteredErrorMsg ? `${output}\n${filteredErrorMsg}` : output;

  // 1. Process termination signals or non-executable / invalid exit codes
  if (signal !== undefined) {
    return true;
  }
  if (typeof exitCode === "number" && (exitCode === 126 || exitCode === 127 || exitCode > 128)) {
    return true;
  }

  // 2. Missing test file or missing binary (ENOENT)
  if (combined.includes("ENOENT") || combined.includes("no such file or directory")) {
    return true;
  }

  // 3. Node CLI invocation / bad option errors
  if (
    combined.includes("bad option:") ||
    combined.includes("bad option") ||
    combined.includes("Unrecognized option") ||
    combined.includes("illegal option") ||
    combined.includes("invalid option")
  ) {
    return true;
  }

  // 4. Syntax errors in reproduction test or imported target code
  if (
    combined.includes("SyntaxError") ||
    combined.includes("Unexpected token") ||
    combined.includes("Cannot use import statement outside a module")
  ) {
    return true;
  }

  // 5. Module resolution and import failures
  if (
    combined.includes("Cannot find module") ||
    combined.includes("Cannot find package") ||
    combined.includes("MODULE_NOT_FOUND") ||
    combined.includes("ERR_MODULE_NOT_FOUND") ||
    combined.includes("ERR_REQUIRE_ESM") ||
    combined.includes("ERR_UNKNOWN_FILE_EXTENSION") ||
    combined.includes("ERR_PACKAGE_PATH_NOT_EXPORTED") ||
    combined.includes("ERR_PACKAGE_IMPORT_NOT_DEFINED") ||
    combined.includes("ERR_UNSUPPORTED_DIR_IMPORT") ||
    combined.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    combined.includes("ERR_INVALID_MODULE_SPECIFIER")
  ) {
    return true;
  }

  // 6. Test harness runtime crashes / memory exhaustion / unhandled runtime errors
  if (
    combined.includes("Allocation failed - JavaScript heap out of memory") ||
    combined.includes("FATAL ERROR:") ||
    combined.includes("UnhandledPromiseRejection:") ||
    combined.includes("ERR_UNHANDLED_REJECTION") ||
    combined.includes("(Use `node --trace-uncaught") ||
    /^\s*(?!(?:AssertionError)\b)[A-Z]\w*Error:\s/m.test(combined)
  ) {
    return true;
  }

  return false;
}

/**
 * Validates whether output indicates a genuine exploit assertion failure.
 *
 * Requirements:
 * 1. Process must exit with code 1.
 * 2. Unhandled runtime crashes (TypeError, ReferenceError, RangeError, URIError, EvalError, SyntaxError)
 *    veto assertion qualification even if preceded by stdout debug logs or keywords.
 * 3. Stack frames (`    at ...`) are stripped so directory paths never collide with assertion tokens.
 * 4. Assertion matching requires structured line-anchored headers (e.g. `AssertionError:`, `AssertionError [ERR_ASSERTION]:`),
 *    error codes (`ERR_ASSERTION`), or explicit exploit reproduction token (`EXPLOIT_REPRODUCED`).
 */
export function isAssertionFailure(output: string, exitCode?: number): boolean {
  if (exitCode !== 1) {
    return false;
  }

  // 1. Strip stack frames so call site file paths never leak into token matching
  const nonStackOutput = stripStackTraceFrames(output);

  // 2. Reject unhandled runtime crashes that are not assertions
  const hasUnhandledCrash =
    /^\s*(?:(?!(?:AssertionError)\b)[A-Z]\w*Error|Error|UnhandledPromiseRejection):\s/m.test(
      nonStackOutput,
    ) ||
    /^\s*FATAL ERROR:/m.test(nonStackOutput) ||
    /\(Use `node --trace-uncaught/m.test(nonStackOutput);

  if (hasUnhandledCrash) {
    return false;
  }

  // 3. Match structured line-anchored assertion headers and explicit reproduction tokens
  return (
    /^\s*AssertionError(?:\s*\[ERR_ASSERTION\])?(?::|$)/m.test(nonStackOutput) ||
    /^\s*(?:Error\s*)?\[ERR_ASSERTION\](?::|$)/m.test(nonStackOutput) ||
    /^\s*ERR_ASSERTION(?::|\s*$)/m.test(nonStackOutput) ||
    /^\s*EXPLOIT_REPRODUCED(?::|\s*$)/m.test(nonStackOutput) ||
    /^\s*Assertion failed(?::|$)/im.test(nonStackOutput)
  );
}

export interface PrepareReproductionTestParams {
  cwd: string;
  packageName: string;
  vulnerableVersion: string;
  patchesDir?: string;
  proofOfFix?: boolean | string;
  reproductionTest?: string;
}

export interface PreparedReproductionTest {
  testFilePath?: string;
  isCreated: boolean;
}

/**
 * Prepares reproduction test artifact on disk if provided as script string,
 * or verifies existence of path if provided as file reference.
 */
export async function prepareReproductionTestFile(
  params: PrepareReproductionTestParams,
): Promise<PreparedReproductionTest> {
  const {
    cwd,
    packageName,
    vulnerableVersion,
    patchesDir = "./patches",
    proofOfFix,
    reproductionTest,
  } = params;
  const patchesDirPath = isAbsolute(patchesDir) ? patchesDir : join(cwd, patchesDir);
  const safeName = packageName.replace(/^@/, "").replace(/\//g, "+");
  const defaultTestPath = join(patchesDirPath, `${safeName}+${vulnerableVersion}.test.cjs`);

  if (typeof proofOfFix === "string" && proofOfFix.trim().length > 0) {
    const resolvedPath = isAbsolute(proofOfFix) ? proofOfFix : join(cwd, proofOfFix);
    if (existsSync(resolvedPath)) {
      return { testFilePath: resolvedPath, isCreated: false };
    }
    await mkdir(patchesDirPath, { recursive: true });
    await writeFile(defaultTestPath, proofOfFix, "utf8");
    return { testFilePath: defaultTestPath, isCreated: true };
  }

  if (reproductionTest && reproductionTest.trim().length > 0) {
    const resolvedPath = isAbsolute(reproductionTest)
      ? reproductionTest
      : join(cwd, reproductionTest);
    if (existsSync(resolvedPath)) {
      return { testFilePath: resolvedPath, isCreated: false };
    }
    await mkdir(patchesDirPath, { recursive: true });
    await writeFile(defaultTestPath, reproductionTest, "utf8");
    return { testFilePath: defaultTestPath, isCreated: true };
  }

  if (proofOfFix === true && existsSync(defaultTestPath)) {
    return { testFilePath: defaultTestPath, isCreated: false };
  }

  return { testFilePath: undefined, isCreated: false };
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
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    const output = `${stdout}\n${stderr}`.trim();

    if (stage === "negative") {
      // In negative phase, passing cleanly (exitCode 0) means vulnerability was NOT reproduced (false negative).
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

    // In positive phase, exit code 0 means remediation succeeded cleanly.
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
      signal?: string;
      code?: string;
    };
    const exitCode = typeof execaErr.exitCode === "number" ? execaErr.exitCode : 1;
    const errorMsg = execaErr.message || String(err);
    const rawStdout = String(execaErr.stdout ?? "").trim();
    const rawStderr = String(execaErr.stderr ?? "").trim();
    const processOutput = [rawStdout, rawStderr].filter(Boolean).join("\n").trim();
    const output = processOutput || errorMsg;

    if (stage === "negative") {
      // 1. Timeout handling
      if (
        execaErr.timedOut ||
        errorMsg.includes("timed out") ||
        output.includes("timed out") ||
        execaErr.code === "ETIMEDOUT"
      ) {
        return {
          executed: true,
          passed: false,
          harnessFailure: true,
          exitCode,
          output,
          durationMs,
          error: "Exploit reproduction test timed out (execution hung).",
        };
      }

      // 2. Reject harness execution failures (syntax error, missing module, missing file, bad CLI, crash)
      if (
        isHarnessFailure({
          exitCode,
          output,
          errorMsg,
          testFilePath,
          signal: execaErr.signal,
        })
      ) {
        return {
          executed: false,
          passed: false,
          harnessFailure: true,
          exitCode,
          output,
          durationMs,
          error: `Reproduction test failed to execute (harness error): ${errorMsg}`,
        };
      }

      // 3. Verify genuine exploit assertion failure with stream precedence and path decoupling
      const knownPaths = [
        cwd,
        testFilePath,
        isAbsolute(testFilePath) ? testFilePath : join(cwd, testFilePath),
      ];

      // A. Evaluate stderr first (Node.js writes uncaught exceptions and assertions to stderr)
      if (rawStderr) {
        const stderrSanitized = sanitizePathLeakage(stripStackTraceFrames(rawStderr), knownPaths);
        if (isAssertionFailure(stderrSanitized, exitCode)) {
          return {
            executed: true,
            passed: true,
            exitCode,
            output,
            durationMs,
          };
        }

        // Check if stderr contains an unhandled runtime error crash that vetoes stdout
        const hasStderrCrash =
          /^\s*(?:(?!(?:AssertionError)\b)[A-Z]\w*Error|Error|UnhandledPromiseRejection|UnhandledPromiseRejectionWarning):\s/m.test(
            stderrSanitized,
          ) ||
          /^\s*FATAL ERROR:/m.test(stderrSanitized) ||
          stderrSanitized.includes("Allocation failed - JavaScript heap out of memory") ||
          /\(Use `node --trace-uncaught/m.test(rawStderr) ||
          /\bERR_UNHANDLED_REJECTION\b/.test(rawStderr) ||
          /^\s*at\s+/m.test(rawStderr) ||
          /Node\.js v\d+/m.test(rawStderr);

        if (hasStderrCrash) {
          return {
            executed: false,
            passed: false,
            harnessFailure: true,
            exitCode,
            output,
            durationMs,
            error: `Reproduction test failed with runtime error instead of exploit assertion: ${errorMsg}`,
          };
        }
      }

      // B. If stderr did not contain a crash, evaluate stdout for explicit assertion tokens
      if (rawStdout) {
        const stdoutSanitized = sanitizePathLeakage(stripStackTraceFrames(rawStdout), knownPaths);
        if (isAssertionFailure(stdoutSanitized, exitCode)) {
          return {
            executed: true,
            passed: true,
            exitCode,
            output,
            durationMs,
          };
        }
      }

      // C. If stderr/stdout did not match but errorMsg contains an assertion (e.g. simulated rejections)
      if (errorMsg) {
        const errorMsgSanitized = sanitizePathLeakage(stripStackTraceFrames(errorMsg), knownPaths);
        if (isAssertionFailure(errorMsgSanitized, exitCode)) {
          return {
            executed: true,
            passed: true,
            exitCode,
            output,
            durationMs,
          };
        }
      }

      // 4. Non-zero exit code without genuine exploit assertion is an unhandled runtime error
      return {
        executed: false,
        passed: false,
        harnessFailure: true,
        exitCode,
        output,
        durationMs,
        error: `Reproduction test failed with runtime error instead of exploit assertion: ${errorMsg}`,
      };
    }

    // In positive phase, non-zero exit code means exploit still reproduced or target crashed.
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
