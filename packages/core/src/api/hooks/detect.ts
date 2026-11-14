import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { safeExeca } from "../../platform/safe-exec.js";
import type { HookManager } from "./types.js";

const LEFTHOOK_FILES = [
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
  ".config/lefthook.yml",
  ".config/lefthook.yaml",
];
const PRE_COMMIT_FILE = ".pre-commit-config.yaml";

export interface GitContext {
  /** Real path of the folder the command ran in. */
  cwd: string;
  /** Top of the working tree: hook files and manager configuration live here. */
  root: string;
  /** Project folder relative to `root`, `.` when they are the same. */
  projectDir: string;
  /** Folder git runs hooks from (`core.hooksPath` when set, else the repository's hooks folder). */
  hooksDir: string;
  /** Raw `core.hooksPath`, when set. */
  hooksPath?: string;
}

export interface ManagerChoice {
  manager: HookManager;
  reason: string;
  /** Existing configuration file (relative to `root`) for managers that keep one. */
  configFile?: string;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await safeExeca("git", args, { cwd, stdio: "pipe", timeoutMs: 15_000 });
    const text = result.stdout.trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Find the repository around `cwd` and where its hooks live. Throws when `cwd` is not in a repository. */
export async function detectGit(cwd: string): Promise<GitContext> {
  const real = realpathSync(cwd);
  const top = await git(real, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error(`${cwd} is not inside a git repository. Run "git init" first.`);
  const root = realpathSync(top);
  const hooksPath = await git(real, ["config", "--get", "core.hooksPath"]);

  let hooksDir: string;
  if (hooksPath) {
    const expanded = hooksPath.startsWith("~/") ? join(homedir(), hooksPath.slice(2)) : hooksPath;
    hooksDir = isAbsolute(expanded) ? expanded : resolve(root, expanded);
  } else {
    const gitPath = await git(real, ["rev-parse", "--git-path", "hooks"]);
    hooksDir = resolve(real, gitPath ?? ".git/hooks");
  }
  const projectDir = relative(root, real).split("\\").join("/") || ".";
  return { cwd: real, root, projectDir, hooksDir, ...(hooksPath ? { hooksPath } : {}) };
}

/** Which tool manages the hooks: husky, lefthook, the pre-commit framework, or plain git. */
export function detectManager(context: GitContext, requested?: HookManager): ManagerChoice {
  const { root, hooksPath } = context;
  const lefthook = LEFTHOOK_FILES.find((file) => existsSync(join(root, file)));
  const preCommit = existsSync(join(root, PRE_COMMIT_FILE)) ? PRE_COMMIT_FILE : undefined;
  const husky = existsSync(join(root, ".husky")) || /^\.?\/?\.husky(\/|$)/.test(hooksPath ?? "");

  if (requested) {
    const configFile =
      requested === "lefthook"
        ? (lefthook ?? "lefthook.yml")
        : requested === "pre-commit"
          ? PRE_COMMIT_FILE
          : undefined;
    return {
      manager: requested,
      reason: "chosen with --manager",
      ...(configFile ? { configFile } : {}),
    };
  }
  if (husky) {
    return {
      manager: "husky",
      reason: hooksPath?.includes(".husky")
        ? `core.hooksPath is ${hooksPath}`
        : "found a .husky folder",
    };
  }
  if (lefthook) return { manager: "lefthook", reason: `found ${lefthook}`, configFile: lefthook };
  if (preCommit)
    return { manager: "pre-commit", reason: `found ${preCommit}`, configFile: preCommit };
  return {
    manager: "git",
    reason: hooksPath
      ? `core.hooksPath is ${hooksPath}`
      : "no hook manager found, using the repository's own hooks folder",
  };
}
