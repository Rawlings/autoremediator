/** Git hooks Autoremediator can install. */
export const HOOK_NAMES = ["pre-push", "post-merge"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** Tools that manage git hooks; `git` means plain `.git/hooks` (or `core.hooksPath`). */
export const HOOK_MANAGERS = ["husky", "lefthook", "pre-commit", "git"] as const;
export type HookManager = (typeof HOOK_MANAGERS)[number];

/**
 * - `create`: the file does not exist yet.
 * - `update`: the file exists and will change.
 * - `delete`: the file only held Autoremediator's block and will be removed.
 * - `unchanged`: already as `hook install` would write it (or nothing to remove).
 * - `conflict`: the file exists but cannot be changed safely; it is left alone.
 */
export type HookChangeAction = "create" | "update" | "delete" | "unchanged" | "conflict";

/** One file `installHooks` would touch. `path` is relative to the repository root when inside it. */
export interface HookFileChange {
  path: string;
  /** Absolute path used for reading and writing. */
  absolutePath: string;
  action: HookChangeAction;
  reason: string;
  before?: string;
  after: string;
  /** The file must be executable (plain git hooks). */
  executable?: boolean;
}

export interface HookChangeSummary {
  path: string;
  action: HookChangeAction;
  reason: string;
  /** Line diff of the change; empty when nothing changes. */
  diff: string;
}

/**
 * - `installed`: the hook is present and as `hook install` would write it.
 * - `missing`: not installed.
 * - `modified`: Autoremediator's block is present but differs (edited, or from another version).
 * - `conflict`: the file exists and cannot be changed safely.
 */
export type HookState = "installed" | "missing" | "modified" | "conflict";

export interface HookStatus {
  hook: HookName;
  state: HookState;
  /** File that holds (or would hold) the hook. */
  path: string;
  detail: string;
}

export interface HooksOptions {
  cwd?: string;
  /** Hooks to handle. Default: `pre-push` and `post-merge`. */
  hooks?: HookName[];
  /** Override the detected hook manager. */
  manager?: HookManager;
  /** Remove Autoremediator's hooks instead of installing them. */
  uninstall?: boolean;
  /** Write the changes. Without it, only report what would change. */
  yes?: boolean;
  /** Report drift only; never writes. */
  check?: boolean;
  /**
   * Write into a hooks folder outside the repository (a global `core.hooksPath`, shared by every
   * repository that uses it). Without it such a folder is reported as a conflict.
   */
  allowSharedHooksPath?: boolean;
}

export interface HooksResult {
  cwd: string;
  /** Repository root where hook files and manager configuration live. */
  root: string;
  manager: HookManager;
  /** Why this manager was chosen. */
  managerReason: string;
  action: "install" | "uninstall";
  hooks: HookStatus[];
  changes: HookChangeSummary[];
  /** True when at least one file would change (or did). */
  drift: boolean;
  /** True when files were written. */
  applied: boolean;
  /** Files left alone because they could not be changed safely. */
  conflicts: string[];
  /** What to do next, such as syncing the hook manager. */
  nextSteps: string[];
}
