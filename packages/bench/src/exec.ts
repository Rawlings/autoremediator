/**
 * Process helpers and the hermetic environment every benchmark subprocess (and the in-process
 * autoremediator calls) runs in: no user npm or git configuration, caches inside the work
 * directory, a fixed git identity, and the path of the TypeScript compiler the fixtures call.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setGlobalProxyFromEnv } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertContainedWorkRoot, scrubbedEnv } from "./safety.ts";

/** The benchmark's own ignored scratch directory, the one place besides the OS temp directory a run may live. */
export const BENCH_WORK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".work");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string },
): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: scrubbedEnv(options.env ?? process.env),
        timeout: options.timeoutMs ?? 180_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1;
        resolve({
          code,
          stdout,
          stderr: error && !stderr ? error.message : stderr,
          durationMs: Date.now() - started,
        });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Run and throw on a non-zero exit, with the output in the message. */
export async function mustRun(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string },
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.code}) in ${options.cwd}\n${result.stderr || result.stdout}`.trim(),
    );
  }
  return result;
}

/** Absolute path of the TypeScript compiler entry the fixtures' `typecheck` script runs. */
export function resolveTsc(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
}

/**
 * Point this process (and so every subprocess and in-process autoremediator call) at a private
 * environment under `workRoot`. Returns the variables set, for passing to spawned servers.
 */
export function applyHermeticEnv(
  workRoot: string,
  options: { allowNetwork?: boolean } = {},
): Record<string, string> {
  assertContainedWorkRoot(workRoot, [tmpdir(), BENCH_WORK_DIR]);
  mkdirSync(workRoot, { recursive: true });
  // npm refuses to load one file as both its user and its global config, so each gets its own.
  const emptyConfig = join(workRoot, "empty.config");
  const emptyUserConfig = join(workRoot, "empty-user.npmrc");
  const emptyGlobalConfig = join(workRoot, "empty-global.npmrc");
  for (const file of [emptyConfig, emptyUserConfig, emptyGlobalConfig]) writeFileSync(file, "");
  const vars: Record<string, string> = {
    NPM_CONFIG_USERCONFIG: emptyUserConfig,
    NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
    npm_config_cache: join(workRoot, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    XDG_CACHE_HOME: join(workRoot, "xdg-cache"),
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "autoremediator-bench",
    GIT_AUTHOR_EMAIL: "bench@example.invalid",
    GIT_COMMITTER_NAME: "autoremediator-bench",
    GIT_COMMITTER_EMAIL: "bench@example.invalid",
    BENCH_TSC: resolveTsc(),
    // Never let a configured model or registry leak into a scripted run.
    AUTOREMEDIATOR_MODEL: "",
  };
  if (!options.allowNetwork) {
    // A tripwire, not a sandbox: anything that is not the local registry is routed to a port where
    // nothing listens, so an accidental request to the internet fails loudly instead of succeeding.
    const dead = process.env["BENCH_TRIPWIRE_PROXY"] ?? "http://127.0.0.1:9";
    Object.assign(vars, {
      HTTP_PROXY: dead,
      HTTPS_PROXY: dead,
      http_proxy: dead,
      https_proxy: dead,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      NODE_USE_ENV_PROXY: "1",
    });
  }
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  if (!options.allowNetwork) setGlobalProxyFromEnv();
  delete process.env["npm_config_registry"];
  delete process.env["NPM_CONFIG_REGISTRY"];
  return vars;
}
