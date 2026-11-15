/**
 * Runs a script that came from a model as untrusted code.
 *
 * What is enforced, and by what:
 *  - Node's permission model (`--permission`): no network (net, dns, http, udp), no child
 *    processes, no worker threads, no native addons, no filesystem writes, and reads only inside
 *    the one directory the script lives in. Self-tested by `verifySandbox`, never assumed.
 *  - An empty environment: no variable of the parent is passed on, so no token or secret is there
 *    to read.
 *  - A preload that refuses `process.kill` for any pid but the process's own. The permission model
 *    does not cover signals, and without this a script could kill the caller or, with `-1`, every
 *    process of the user.
 *  - A wall-clock timeout, an output cap and a heap cap. The process runs in its own process group,
 *    and the group is killed when it times out, floods its output or ends.
 *
 * What is NOT enforced: CPU time (only wall-clock), memory outside the V8 heap (large buffers),
 * and anything an exploit of Node itself would allow. Node documents the permission model as a
 * guard against mistakes and misbehaving code, not as a boundary against a determined attacker.
 * Where those limits matter, run the whole tool in a container.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Variables macOS adds to every process whatever it is started with. It holds the user id and a
 * text encoding, nothing secret; it is allowed in the self-test and never passed on by us.
 */
export const PLATFORM_INJECTED_ENV: ReadonlySet<string> = new Set(["__CF_USER_TEXT_ENCODING"]);

/** The only environment a sandboxed script sees. */
export const SANDBOX_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: "test",
  TZ: "UTC",
  LANG: "C.UTF-8",
};

const PRELOAD_NAME = ".proof-sandbox-preload.cjs";

const PRELOAD = `"use strict";
const self = process.pid;
const refuse = () => {
  const error = new Error("signalling other processes is not permitted in the proof sandbox");
  error.code = "ERR_ACCESS_DENIED";
  throw error;
};
const guarded = (original) =>
  function (pid, signal) {
    if (pid !== self) refuse();
    return original.call(process, pid, signal);
  };
const lock = (name, value) =>
  Object.defineProperty(process, name, { value, writable: false, configurable: false });
lock("kill", guarded(process.kill));
if (typeof process._kill === "function") lock("_kill", guarded(process._kill));
`;

export interface SandboxOptions {
  /** Directory holding the script. The only place the script may read. */
  dir: string;
  /** File name of the script inside `dir`. */
  script: string;
  timeoutMs: number;
  /** Stdout plus stderr beyond this many bytes ends the run. */
  maxOutputBytes: number;
  /** V8 old-space limit in MiB. */
  maxHeapMb?: number;
}

export interface SandboxResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxUnavailableError";
  }
}

/** Run `script` under the permission model. Resolves with what happened; rejects only if it cannot start. */
export function runSandboxed(options: SandboxOptions): Promise<SandboxResult> {
  if (process.platform === "win32") {
    return Promise.reject(
      new SandboxUnavailableError(
        "The proof sandbox needs process groups and is not available on Windows.",
      ),
    );
  }
  const { script, timeoutMs, maxOutputBytes, maxHeapMb = 256 } = options;
  const dir = realpathSync(options.dir);
  writeFileSync(join(dir, PRELOAD_NAME), PRELOAD, "utf8");

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${dir}`,
        `--max-old-space-size=${maxHeapMb}`,
        "--require",
        join(dir, PRELOAD_NAME),
        join(dir, script),
      ],
      {
        cwd: dir,
        env: { ...SANDBOX_ENV },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let timedOut = false;
    let outputLimitExceeded = false;

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      if (outputLimitExceeded) return;
      const room = maxOutputBytes - total;
      if (chunk.length > room) {
        if (room > 0) sink.push(chunk.subarray(0, room));
        total = maxOutputBytes;
        outputLimitExceeded = true;
        killGroup();
        return;
      }
      sink.push(chunk);
      total += chunk.length;
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      killGroup();
      reject(new SandboxUnavailableError("Could not start the sandboxed process.", { cause: error }));
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      killGroup();
      resolve({
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

/** What the self-test established, kept in the evidence record. */
export interface SandboxReport {
  node: string;
  platform: string;
  /** Each capability the self-test tried and found refused. */
  denied: string[];
  /** What the sandbox does not limit (stated, not tested). */
  notLimited: string[];
}

export const NOT_LIMITED = [
  "CPU time (only the wall-clock timeout bounds it)",
  "memory outside the V8 heap, such as large buffers",
  "a flaw in Node.js itself (the permission model is a guard against misbehaving code, not a boundary against a determined attacker)",
];

const PROBE = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const out = {};
const attempt = async (name, fn) => {
  try {
    await fn();
    out[name] = "allowed";
  } catch (error) {
    const code = error && (error.code || (error.cause && error.cause.code));
    out[name] = code === "ERR_ACCESS_DENIED" ? "denied" : "failed: " + (code || (error && error.message));
  }
};
(async () => {
  const [outsideFile, serverPort] = process.argv.slice(2);
  await attempt("read-outside-dir", () => fs.readFileSync(outsideFile, "utf8"));
  await attempt("read-system-file", () => fs.readFileSync("/etc/hosts", "utf8"));
  await attempt("list-parent-dir", () => fs.readdirSync(path.dirname(__dirname)));
  await attempt("write-inside-dir", () => fs.writeFileSync(path.join(__dirname, "w.txt"), "x"));
  await attempt("write-outside-dir", () => fs.writeFileSync(outsideFile + ".w", "x"));
  await attempt("network-connect", () => new Promise((resolve, reject) => {
    const socket = require("node:net").connect(Number(serverPort), "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); resolve(); });
    socket.on("error", reject);
  }));
  await attempt("network-fetch", () => fetch("http://127.0.0.1:" + serverPort + "/"));
  await attempt("dns-lookup", () => require("node:dns").promises.lookup("example.com"));
  await attempt("child-process", () => require("node:child_process").execSync("echo x"));
  await attempt("worker-thread", () => new (require("node:worker_threads").Worker)("1", { eval: true }));
  await attempt("signal-other-process", () => process.kill(process.ppid, 0));
  await attempt("signal-all-processes", () => process.kill(-1, 0));
  out.envNames = Object.keys(process.env).sort();
  console.log(JSON.stringify(out));
})();
`;

const REQUIRED_DENIED = [
  "read-outside-dir",
  "read-system-file",
  "list-parent-dir",
  "write-inside-dir",
  "write-outside-dir",
  "network-connect",
  "network-fetch",
  "dns-lookup",
  "child-process",
  "worker-thread",
  "signal-other-process",
  "signal-all-processes",
];

async function probeOnce(): Promise<SandboxReport> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "autoremediator-sandbox-probe-")));
  const inside = join(root, "inside");
  mkdirSync(inside);
  const outsideFile = join(root, "outside.txt");
  writeFileSync(outsideFile, "secret", "utf8");
  writeFileSync(join(inside, "probe.cjs"), PROBE, "utf8");

  // A real listener: if the sandbox lets the probe connect, the server sees it.
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    // The probe's own arguments go after the script, so it is run with the same flags as a trial.
    const result = await runProbe(inside, [outsideFile, String(port)]);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    } catch (cause) {
      throw new SandboxUnavailableError(
        `The sandbox self-test did not run (exit ${String(result.exitCode)}). ${result.stderr.trim().split("\n")[0] ?? ""}`.trim(),
        { cause },
      );
    }
    const notDenied = REQUIRED_DENIED.filter((name) => parsed[name] !== "denied");
    const env = parsed["envNames"];
    if (notDenied.length > 0 || connections > 0 || !Array.isArray(env)) {
      throw new SandboxUnavailableError(
        `This Node.js (${process.version}) does not enforce the proof sandbox: ${
          [
            ...notDenied.map((name) => `${name} was ${String(parsed[name])}`),
            ...(connections > 0 ? ["a network connection was accepted"] : []),
          ].join("; ") || "unexpected self-test output"
        }. Proof-of-fix generation needs Node.js 26 or newer with the permission model.`,
      );
    }
    const unexpectedEnv = (env as string[]).filter(
      (name) => !(name in SANDBOX_ENV) && !PLATFORM_INJECTED_ENV.has(name),
    );
    if (unexpectedEnv.length > 0) {
      throw new SandboxUnavailableError(
        `The sandbox leaked environment variables into the script: ${unexpectedEnv.join(", ")}`,
      );
    }
    return {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      denied: REQUIRED_DENIED,
      notLimited: NOT_LIMITED,
    };
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function runProbe(dir: string, args: string[]): Promise<SandboxResult> {
  // `runSandboxed` runs `script` with no arguments; the probe needs two, so it gets them by file.
  writeFileSync(
    join(dir, "run-probe.cjs"),
    `process.argv.push(...${JSON.stringify(args)});\nrequire("./probe.cjs");\n`,
    "utf8",
  );
  return runSandboxed({ dir, script: "run-probe.cjs", timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
}

let verified: Promise<SandboxReport> | undefined;

/**
 * Prove, on this machine and this Node.js, that the sandbox refuses what it claims to refuse, by
 * trying each thing from inside it. Throws `SandboxUnavailableError` when it does not. Cached.
 */
export function verifySandbox(): Promise<SandboxReport> {
  verified ??= probeOnce().catch((error: unknown) => {
    verified = undefined;
    throw error;
  });
  return verified;
}
