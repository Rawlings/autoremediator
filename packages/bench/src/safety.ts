/**
 * What keeps a benchmark run from touching the machine it runs on.
 *
 * The fixture packages are published software, so three things are enforced here and by tests rather than
 * left to care: library code runs without write, spawn or network permission, a run can only live in
 * a directory it is allowed to delete, and no child process inherits a credential.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The `test` script every consumer project carries. Node's permission model is on and nothing is
 * granted except reading the project: no writes, no child processes, no workers, no addons and no
 * network. `--test-isolation=none` runs the test files in this one process, because the default
 * runner spawns a child per file and that would need the spawn permission.
 *
 * The `typecheck` script is not sandboxed: the compiler only reads declaration files and never runs
 * dependency code, and TypeScript 7 launches a native binary, which the permission model would block.
 */
export const SANDBOXED_TEST_SCRIPT =
  'node --permission --allow-fs-read="$PWD" --test-isolation=none --test test/*.test.ts';

/** Resolve symlinks in the part of `path` that exists, and keep the rest as written. */
export function realPathLoose(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

/**
 * Refuse a work directory that a run could not safely delete: it must lie strictly inside one of
 * the allowed parents (after resolving symlinks), so `/`, the home directory and the parents
 * themselves are all rejected.
 */
export function assertContainedWorkRoot(workRoot: string, allowedParents: readonly string[]): void {
  const target = realPathLoose(workRoot);
  const home = realPathLoose(homedir());
  for (const parent of allowedParents) {
    const root = realPathLoose(parent);
    if (target !== root && target !== home && target.startsWith(root + sep)) return;
  }
  throw new Error(
    `Refusing to use ${workRoot} as the work directory: it must be a new directory inside ${allowedParents.join(" or ")}`,
  );
}

const SECRET_NAME =
  /(?:TOKEN|SECRET|PASSW(?:OR)?D|API_?KEY|PRIVATE_KEY|SIGNING_KEY|ACCESS_KEY|CREDENTIALS?)/i;

/** Whether an environment variable name looks like it carries a credential. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** A copy of `env` without credentials, for every child process the benchmark starts. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isSecretEnvName(name)) clean[name] = value;
  }
  return clean;
}
