import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { safeExeca } from "../platform/safe-exec.js";
import { foldTraceText } from "./fold.js";
import { TRACE_ENV, type TraceReport } from "./types.js";

export interface TraceRunOptions {
  /** The program and its arguments, run without a shell: `["node", "--test"]`, `["pnpm", "test"]`. */
  command: readonly string[];
  /** Directory to run the command in (default: process.cwd()). */
  cwd?: string;
  /** Packages whose exported functions are wrapped to count calls. Required with `calls`. */
  packages?: readonly string[];
  /** Count calls to the exports of `packages`. Off by default; adds overhead to the wrapped calls. */
  calls?: boolean;
  /** Where to write the folded trace (default: `<cwd>/.autoremediator/trace.json`). */
  out?: string;
  /**
   * What happens to the command's own output: `inherit` passes it through, `capture` returns it in
   * the result, `stderr` sends the command's stdout to this process's stderr so stdout stays free.
   */
  output?: "inherit" | "capture" | "stderr";
  /** Kill the command after this many milliseconds (default: no limit). */
  timeoutMs?: number;
  /** Environment for the command (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface TraceRunResult {
  /** The command's exit code, or null when a signal ended it. */
  exitCode: number | null;
  signal?: string;
  /** Where the folded trace was written. */
  traceFile: string;
  report: TraceReport;
  stdout?: string;
  stderr?: string;
}

/** The hook module this package ships, which the traced command loads with `--import`. */
export function traceHookPath(): string {
  return fileURLToPath(new URL("./register.js", import.meta.url));
}

const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;

export function validateTraceRunOptions(options: TraceRunOptions): void {
  if (options.command.length === 0 || options.command[0] === "") {
    throw new Error('traceRun needs a command to run, for example ["node", "--test"]');
  }
  for (const name of options.packages ?? []) {
    if (!PACKAGE_NAME.test(name)) {
      throw new Error(`Invalid package name in packages: ${JSON.stringify(name)}`);
    }
  }
  if (options.calls && (options.packages ?? []).length === 0) {
    throw new Error(
      "Counting calls needs the packages to watch: pass packages (--packages a,b), for example the package a CVE affects.",
    );
  }
}

/**
 * Run a command with the trace hook injected into every Node.js process it starts (through
 * NODE_OPTIONS), then fold what the processes recorded into one report. The command's exit code is
 * returned, not thrown: a failing test run still produces a trace, which says so.
 */
export async function runTrace(options: TraceRunOptions): Promise<TraceRunResult> {
  validateTraceRunOptions(options);
  const cwd = resolve(options.cwd ?? process.cwd());
  const hook = traceHookPath();
  const traceFile = resolve(cwd, options.out ?? join(".autoremediator", "trace.json"));
  const scratch = mkdtempSync(join(tmpdir(), "autoremediator-trace-"));
  const raw = join(scratch, "trace.jsonl");
  const [program = "", ...args] = options.command;

  const base = options.env ?? process.env;
  const nodeOptions = [base.NODE_OPTIONS, `--import=${pathToFileURL(hook).href}`]
    .filter(Boolean)
    .join(" ");
  const env: NodeJS.ProcessEnv = {
    ...base,
    NODE_OPTIONS: nodeOptions,
    [TRACE_ENV.file]: raw,
  };
  if (options.packages && options.packages.length > 0) {
    env[TRACE_ENV.packages] = options.packages.join(",");
  }
  if (options.calls) env[TRACE_ENV.calls] = "1";

  const output = options.output ?? "capture";
  try {
    const result = await safeExeca(program, args, {
      cwd,
      env,
      allowNodeOptions: true,
      timeoutMs: options.timeoutMs ?? 0,
      reject: false,
      stdin: "inherit",
      stdout: output === "inherit" ? "inherit" : output === "stderr" ? process.stderr : "pipe",
      stderr: output === "inherit" ? "inherit" : output === "stderr" ? process.stderr : "pipe",
    });
    if (result.exitCode === undefined && !result.signal && !result.timedOut) {
      throw new Error(`Could not run ${JSON.stringify(program)}: ${result.shortMessage}`, {
        cause: result.cause,
      });
    }
    let text = "";
    try {
      text = readFileSync(raw, "utf8");
    } catch {
      // No file means the hook never wrote: no process loaded it. The report says processes: 0.
    }
    const exitCode = result.exitCode ?? null;
    const report = foldTraceText(text, {
      argv: [...options.command],
      exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
    });
    mkdirSync(dirname(traceFile), { recursive: true });
    writeFileSync(traceFile, `${JSON.stringify(report, null, 2)}\n`);
    return {
      exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      traceFile,
      report,
      ...(output === "capture" ? { stdout: result.stdout ?? "", stderr: result.stderr ?? "" } : {}),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
