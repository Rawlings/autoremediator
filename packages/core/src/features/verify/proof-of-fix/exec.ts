/**
 * Runs a reproduction script for the proof-of-fix phases. Kept apart from the phase logic so the
 * phases can be tested without a real sandbox.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { errorMessage } from "../../../shared/errors.js";
import { safeExeca } from "../../../shared/exec/safe-exec.js";
import { runSandboxed, verifySandbox } from "../../../shared/exec/sandbox.js";

export class ProofSandboxError extends Error {}

/** Output of one script run, in the shape the phase logic reads. */
interface ProofScriptOutput {
  stdout?: string;
  stderr?: string;
}

let sandboxCheck: Promise<unknown> | undefined;

/**
 * The script is code a model wrote (or a caller supplied) and it runs against a version that may be
 * malicious, so it runs under the permission-model sandbox: no network, no child processes, no
 * writes, an empty environment. The sandbox is self-tested once per process; if it does not hold on
 * this machine the phase is a harness failure, never a pass. Windows has no sandbox and keeps the
 * plain run.
 */
export async function execProofScript(params: {
  testFilePath: string;
  cwd: string;
  timeoutMs: number;
  isTs: boolean;
}): Promise<ProofScriptOutput> {
  const { testFilePath, cwd, timeoutMs, isTs } = params;
  if (process.platform === "win32") {
    return safeExeca("node", [...(isTs ? ["--experimental-strip-types"] : []), testFilePath], {
      cwd,
      timeoutMs,
      stdio: "pipe",
    });
  }

  const absolute = isAbsolute(testFilePath) ? testFilePath : join(cwd, testFilePath);
  const script = relative(realpathSync(cwd), realpathSync(absolute));
  if (script.startsWith("..") || isAbsolute(script)) {
    throw new ProofSandboxError(
      `The reproduction test must be inside the project: ${testFilePath}`,
    );
  }
  sandboxCheck ??= verifySandbox();
  try {
    await sandboxCheck;
  } catch (error) {
    sandboxCheck = undefined;
    throw new ProofSandboxError(
      `The proof sandbox does not hold on this machine, so the reproduction test was not run: ${errorMessage(
        error,
      )}`,
    );
  }

  const preloadDir = mkdtempSync(join(tmpdir(), "autoremediator-proof-"));
  let run;
  try {
    run = await runSandboxed({
      dir: cwd,
      script,
      timeoutMs,
      maxOutputBytes: 1_000_000,
      preloadDir,
      ...(isTs ? { nodeArgs: ["--experimental-strip-types"] } : {}),
    });
  } catch (error) {
    throw new ProofSandboxError(errorMessage(error));
  } finally {
    rmSync(preloadDir, { recursive: true, force: true });
  }

  if (run.exitCode === 0 && !run.timedOut && !run.outputLimitExceeded) return run;
  let summary = `Command failed with exit code ${run.exitCode}`;
  if (run.timedOut) summary = `Command timed out after ${timeoutMs}ms`;
  else if (run.outputLimitExceeded) summary = "Command produced too much output";
  // Like execa's own message, which the phase logic reads: the summary followed by the output.
  const detail = [run.stderr.trim(), run.stdout.trim()].filter(Boolean).join("\n");
  throw Object.assign(new Error(detail ? `${summary}\n${detail}` : summary), {
    exitCode: run.exitCode ?? 1,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut,
    ...(run.signal ? { signal: run.signal } : {}),
  });
}
