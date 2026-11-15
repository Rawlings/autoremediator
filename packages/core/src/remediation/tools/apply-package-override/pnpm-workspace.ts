import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

import { parsePnpmLockDocument } from "../../../scanner/pnpm-lock-document.js";

/**
 * pnpm 11 and later read `overrides` from `pnpm-workspace.yaml` and ignore the `pnpm` field of
 * `package.json`; earlier versions are the other way round. Writing to the wrong one is silent: the
 * install succeeds and nothing changes.
 */
export const PNPM_WORKSPACE_OVERRIDES_FROM = 11;

const workspacePath = (dir: string): string => join(dir, "pnpm-workspace.yaml");

/** The current text of `pnpm-workspace.yaml`, or undefined when there is none. */
export function readWorkspaceYaml(dir: string): string | undefined {
  return existsSync(workspacePath(dir)) ? readFileSync(workspacePath(dir), "utf8") : undefined;
}

/** Put the file back as it was: the original text, or no file if there was none. */
export function restoreWorkspaceYaml(dir: string, original: string | undefined): void {
  if (original === undefined) rmSync(workspacePath(dir), { force: true });
  else writeFileSync(workspacePath(dir), original, "utf8");
}

/** Set `overrides.<selector>` in `pnpm-workspace.yaml`, keeping everything else (comments included). */
export function setWorkspaceOverride(dir: string, selector: string, version: string): void {
  const original = readWorkspaceYaml(dir);
  const document = original === undefined ? new YAML.Document({}) : YAML.parseDocument(original);
  document.setIn(["overrides", selector], version);
  writeFileSync(workspacePath(dir), document.toString(), "utf8");
}

/**
 * Did pnpm record the override in its lockfile? `undefined` when there is no lockfile to ask.
 * An install that ignored the override leaves the lockfile without it, which is how a silent no-op
 * shows up.
 */
export function pnpmLockRecordsOverride(dir: string, selector: string): boolean | undefined {
  const lockPath = join(dir, "pnpm-lock.yaml");
  if (!existsSync(lockPath)) return undefined;
  try {
    const data = parsePnpmLockDocument(readFileSync(lockPath, "utf8")) as
      | { overrides?: Record<string, unknown> }
      | undefined;
    return data?.overrides !== undefined && Object.hasOwn(data.overrides, selector);
  } catch {
    return undefined;
  }
}
