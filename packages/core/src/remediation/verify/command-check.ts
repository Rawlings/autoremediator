import { LONG_RUNNING_TIMEOUT_MS } from "../../platform/timeouts.js";
import { safeExecaCommand } from "../../platform/safe-exec-command.js";

export interface CommandOutcome {
  passed: boolean;
  /** Combined stdout, stderr and error message of a failed run. */
  output: string;
}

/** What a failed command printed, so the failure is explainable. */
export function describeCommandFailure(error: unknown): string {
  const failure = error as { stdout?: string; stderr?: string; message?: string };
  const combined = [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n");
  return combined || (error instanceof Error ? error.message : String(error));
}

/** The last lines of command output; the start of a failing test run is rarely what matters. */
export function tail(output: string, lines = 20): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-lines);
}

export async function runCommandCheck(
  command: readonly string[],
  cwd: string,
  timeoutMs: number = LONG_RUNNING_TIMEOUT_MS,
): Promise<CommandOutcome> {
  try {
    await safeExecaCommand(command, { timeoutMs, cwd, stdio: "pipe" });
    return { passed: true, output: "" };
  } catch (error) {
    return { passed: false, output: describeCommandFailure(error) };
  }
}
