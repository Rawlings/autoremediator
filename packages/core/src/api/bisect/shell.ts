import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { sanitizeEnvironment } from "../../platform/safe-exec.js";

export interface ProcessResult {
  /** `null` when the process was killed by a signal. */
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** Interleaved stdout and stderr; only the end is kept when it is long. */
  output: string;
}

export interface ProcessSpec {
  /** A program and its arguments, run without a shell. */
  argv?: readonly string[];
  /** A shell command line, run by `/bin/sh -c` (`cmd.exe` on Windows). */
  shell?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** How much output to keep, counted from the end (default 256 KiB). */
  keepBytes?: number;
}

const GRACE_MS = 2000;

/**
 * Run a process to completion in its own process group, so a timeout or Ctrl-C ends the whole tree
 * (the shell, the test runner, whatever it spawned) and nothing keeps running in a checkout that is
 * about to be deleted. Never rejects: failing to start is reported as exit code 127.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  const keep = spec.keepBytes ?? 256 * 1024;
  const started = Date.now();
  const env = sanitizeEnvironment(spec.env ?? process.env);
  const windows = process.platform === "win32";

  return new Promise<ProcessResult>((resolve) => {
    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const timers: { timeout?: NodeJS.Timeout; kill?: NodeJS.Timeout } = {};

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timers.timeout);
      clearTimeout(timers.kill);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, timedOut, aborted, durationMs: Date.now() - started, output });
    };

    let child;
    try {
      if (spec.shell !== undefined) {
        child = spawn(spec.shell, {
          cwd: spec.cwd,
          env,
          shell: true,
          detached: !windows,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        const [file, ...args] = spec.argv ?? [];
        if (!file) throw new Error("empty command");
        child = spawn(file, args, {
          cwd: spec.cwd,
          env,
          detached: !windows,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (error) {
      output = `could not start: ${error instanceof Error ? error.message : String(error)}`;
      resolve({ exitCode: 127, timedOut: false, aborted: false, durationMs: 0, output });
      return;
    }

    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > keep * 2) output = output.slice(-keep);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const killTree = (signalName: NodeJS.Signals) => {
      try {
        if (windows || child.pid === undefined) child.kill(signalName);
        else process.kill(-child.pid, signalName);
      } catch {
        // Already gone.
      }
    };
    const stop = () => {
      killTree("SIGTERM");
      timers.kill = setTimeout(() => {
        killTree("SIGKILL");
        // Descendants may hold the pipes open after the group is killed.
        setTimeout(() => finish(null), 500).unref();
      }, GRACE_MS);
    };

    timers.timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      output += `\ncould not start: ${error.message}`;
      finish(127);
    });
    child.on("close", (code) => {
      // A process that ended after its group was signalled still leaves orphans behind sometimes.
      if (timedOut || aborted) killTree("SIGKILL");
      finish(code);
    });
  });
}

// ---------------------------------------------------------------------------
// Output that goes into a report
// ---------------------------------------------------------------------------

const ANSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH|CREDENTIAL|PRIVATE)/i;
const SECRET_PATTERNS: RegExp[] = [
  /npm_[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(_authToken|_auth|_password)=[^\s'"]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /(?<=:\/\/)[^\s/@:]+:[^\s/@]+(?=@)/g,
];

export interface SanitizeOptions {
  /** Paths to show as `<name>` instead of their real value. */
  paths?: ReadonlyArray<[path: string, label: string]>;
  env?: NodeJS.ProcessEnv;
  /** Keep this many characters from the end (default 1500). */
  maxChars?: number;
}

/**
 * Make command output safe to put in a report: no terminal escapes, no credentials (known token
 * shapes, and the value of any secret-looking environment variable), no home directory or checkout
 * paths, and only the end of it.
 */
export function sanitizeOutput(text: string, options: SanitizeOptions = {}): string {
  let result = text.replaceAll(ANSI, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  const env = options.env ?? process.env;
  const secrets = Object.entries(env)
    .filter(
      ([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8,
    )
    .map(([, value]) => value!)
    .toSorted((a, b) => b.length - a.length);
  for (const secret of secrets) result = result.replaceAll(secret, "[redacted]");
  for (const pattern of SECRET_PATTERNS) result = result.replaceAll(pattern, "[redacted]");

  const paths = [...(options.paths ?? []), [homedir(), "~"] as [string, string]]
    .filter(([path]) => path.length > 1)
    .toSorted((a, b) => b[0].length - a[0].length);
  for (const [path, label] of paths) result = result.replaceAll(path, label);

  const max = options.maxChars ?? 1500;
  result = result.trimEnd().replace(/^\n+/, "");
  if (result.length > max) {
    const tail = result.slice(-max);
    const cut = tail.indexOf("\n");
    result = `...${cut !== -1 && cut < 200 ? tail.slice(cut) : tail}`;
  }
  return result;
}
