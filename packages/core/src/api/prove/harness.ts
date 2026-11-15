/**
 * The deterministic judge. A reproduction script is accepted only if, in the sandbox, it
 *   - fails on the vulnerable version the way the existing proof-of-fix check expects (exit code 1
 *     with an assertion failure or an explicit EXPLOIT_REPRODUCED line, not a crash), and
 *   - exits 0 on the fixed version,
 * and does the same again on a second run. What a model said about its own script is never an input.
 *
 * What this establishes is that the script tells the two versions apart through the package's API
 * and that it is repeatable. It cannot establish that the difference it finds IS the advisory's
 * vulnerability; that is for the person who reviews the kept script.
 */
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  isAssertionFailure,
  sanitizePathLeakage,
  stripStackTraceFrames,
} from "../../remediation/proof-of-fix/runner.js";
import { runSandboxed, type SandboxOptions, type SandboxResult } from "./sandbox.js";
import { screenScript } from "./screen.js";
import type { JudgedRun, RunRecord, TrialResult } from "./types.js";

export const SCRIPT_FILE = "repro.cjs";
/** How many times the vulnerable/fixed pair must hold. */
export const CONFIRM_RUNS = 2;
const TAIL_CHARS = 2000;

export interface HarnessOptions {
  packageName: string;
  vulnerableVersion: string;
  fixedVersion: string;
  /** Directory with the vulnerable version installed under node_modules. */
  vulnerableDir: string;
  /** Directory with the fixed version installed under node_modules. */
  fixedDir: string;
  /** Wall-clock limit of one run. */
  timeoutMs: number;
  maxOutputBytes: number;
  /** How many times the pair must hold. At least 1; default `CONFIRM_RUNS`. */
  confirmRuns?: number;
  /** Replaceable for tests. */
  run?: (options: SandboxOptions) => Promise<SandboxResult>;
}

export interface Harness {
  prove(script: string): Promise<TrialResult>;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function record(result: SandboxResult, dirs: string[]): RunRecord {
  const combined = [result.stderr, result.stdout].filter((part) => part.trim() !== "").join("\n");
  const shown = sanitizePathLeakage(combined, dirs);
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    durationMs: result.durationMs,
    outputTail: shown.slice(-TAIL_CHARS),
  };
}

function outputOf(result: SandboxResult, dirs: string[]): string {
  return sanitizePathLeakage(stripStackTraceFrames(`${result.stderr}\n${result.stdout}`), dirs);
}

function judgeVulnerable(result: SandboxResult, dirs: string[]): JudgedRun["verdict"] {
  if (result.timedOut) return "timeout";
  if (result.outputLimitExceeded) return "output-limit";
  const output = outputOf(result, dirs);
  if (output.includes("ERR_ACCESS_DENIED")) return "sandbox-violation";
  if (result.exitCode === 0) return "no-reproduction";
  return isAssertionFailure(output, result.exitCode ?? undefined) ? "reproduced" : "crashed";
}

function judgeFixed(result: SandboxResult, dirs: string[]): JudgedRun["verdict"] {
  if (result.timedOut) return "timeout";
  if (result.outputLimitExceeded) return "output-limit";
  if (outputOf(result, dirs).includes("ERR_ACCESS_DENIED")) return "sandbox-violation";
  if (result.exitCode === 0) return "clean";
  return result.exitCode === 1 && isAssertionFailure(outputOf(result, dirs), 1)
    ? "still-failing"
    : "crashed";
}

const VULNERABLE_PROBLEM: Partial<Record<JudgedRun["verdict"], string>> = {
  "no-reproduction":
    "The script exits 0 on the vulnerable version, so it does not detect the vulnerability. It must fail there with an assertion error or an `EXPLOIT_REPRODUCED:` line and exit code 1.",
  crashed:
    "The script crashes on the vulnerable version instead of failing an assertion (a TypeError, a missing module, a syntax error or a non-1 exit). Fix the script so the vulnerable behaviour is asserted, not tripped over.",
  timeout: "The script ran past the time limit on the vulnerable version and was killed.",
  "output-limit": "The script produced too much output on the vulnerable version and was killed.",
  "sandbox-violation":
    "The script tried something the sandbox forbids (network, files outside its directory, processes, signals) on the vulnerable version.",
};

const FIXED_PROBLEM: Partial<Record<JudgedRun["verdict"], string>> = {
  "still-failing":
    "The script also fails on the fixed version, so it does not tell the two versions apart. It must exit 0 there.",
  crashed:
    "The script crashes on the fixed version (not an assertion failure). It must run cleanly there and exit 0.",
  timeout: "The script ran past the time limit on the fixed version and was killed.",
  "output-limit": "The script produced too much output on the fixed version and was killed.",
  "sandbox-violation": "The script tried something the sandbox forbids on the fixed version.",
};

export function createHarness(options: HarnessOptions): Harness {
  const run = options.run ?? runSandboxed;
  const confirmRuns = Math.max(1, options.confirmRuns ?? CONFIRM_RUNS);
  const dirs = [...new Set([options.vulnerableDir, options.fixedDir].flatMap((dir) => [dir, realpathSync(dir)]))];

  const execute = async (
    dir: string,
    judge: (result: SandboxResult, dirs: string[]) => JudgedRun["verdict"],
  ): Promise<JudgedRun> => {
    const result = await run({
      dir,
      script: SCRIPT_FILE,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    return { ...record(result, dirs), verdict: judge(result, dirs) };
  };

  return {
    async prove(script) {
      const scriptSha256 = sha256(script);
      const screened = screenScript(script, {
        packageName: options.packageName,
        versions: [options.vulnerableVersion, options.fixedVersion],
      });
      if (!screened.ok) {
        return {
          accepted: false,
          stage: "screen",
          scriptSha256,
          reason: `The script was refused before it ran: ${screened.violations.join("; ")}.`,
        };
      }

      writeFileSync(join(options.vulnerableDir, SCRIPT_FILE), script, "utf8");
      writeFileSync(join(options.fixedDir, SCRIPT_FILE), script, "utf8");

      let first: { vulnerable: JudgedRun; fixed: JudgedRun } | undefined;
      for (let round = 1; round <= confirmRuns; round++) {
        const stage = round === 1 ? ("vulnerable" as const) : ("confirmed" as const);
        const suffix = round === 1 ? "" : ` (run ${round} of ${confirmRuns}: the result must be repeatable)`;

        const vulnerableRun = await execute(options.vulnerableDir, judgeVulnerable);
        if (vulnerableRun.verdict !== "reproduced") {
          return {
            accepted: false,
            stage,
            scriptSha256,
            vulnerableRun,
            ...(first ? { fixedRun: first.fixed } : {}),
            reason: `${VULNERABLE_PROBLEM[vulnerableRun.verdict] ?? "Unexpected result on the vulnerable version."}${suffix}`,
          };
        }
        const fixedRun = await execute(options.fixedDir, judgeFixed);
        if (fixedRun.verdict !== "clean") {
          return {
            accepted: false,
            stage: round === 1 ? "fixed" : "confirmed",
            scriptSha256,
            vulnerableRun,
            fixedRun,
            reason: `${FIXED_PROBLEM[fixedRun.verdict] ?? "Unexpected result on the fixed version."}${suffix}`,
          };
        }
        first ??= { vulnerable: vulnerableRun, fixed: fixedRun };
      }

      return {
        accepted: true,
        stage: "confirmed",
        scriptSha256,
        vulnerableRun: first!.vulnerable,
        fixedRun: first!.fixed,
        reason: `Fails on ${options.packageName}@${options.vulnerableVersion} and passes on ${options.packageName}@${options.fixedVersion}, ${confirmRuns} times each.`,
      };
    },
  };
}
