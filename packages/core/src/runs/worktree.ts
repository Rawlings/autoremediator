import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

import { safeExeca } from "../platform/safe-exec.js";
import { sha256 } from "./hash.js";

export interface Worktree {
  /** Checkout directory, laid out like the project (same relative paths). */
  path: string;
  /**
   * The commit the checkout started from. When the project had uncommitted changes, that is a
   * commit made in the checkout holding them, so a diff against it is exactly what an attempt did
   * and applies to the project as it is now.
   */
  base: string;
  /** Removes the checkout and its git registration; safe to call twice. */
  remove: () => Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await safeExeca("git", args, { cwd, stdio: "pipe" })).stdout;
}

/** A patch must keep its final newline, which `execa` strips by default. */
async function gitPatch(cwd: string, args: string[]): Promise<string> {
  return (await safeExeca("git", args, { cwd, stdio: "pipe", stripFinalNewline: false })).stdout;
}

/** Where worktrees live: outside the project, so tests, tsc and workspace globs never see them. */
export function worktreeRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const cache = env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return join(cache, "autoremediator", "worktrees", sha256(cwd).slice(0, 16));
}

/**
 * An isolated checkout of the project at HEAD, carrying over uncommitted changes (tracked edits and
 * untracked files that are not ignored), so attempts start from what the project looks like now.
 * `cwd` may be a subdirectory of the repository; the returned path then points at the same
 * subdirectory inside the checkout.
 */
export async function createWorktree(
  cwd: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Worktree> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!root) throw new Error("Attempts need a git repository: this directory is not one.");
  const head = (await git(root, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  if (!head) throw new Error("Attempts need at least one commit in the repository.");

  const repoWorktree = join(worktreeRoot(root, env), name);
  mkdirSync(dirname(repoWorktree), { recursive: true });
  await git(root, ["worktree", "add", "--detach", repoWorktree, head]);

  try {
    // Uncommitted tracked changes.
    const tracked = await gitPatch(root, ["diff", "HEAD", "--binary"]);
    if (tracked.trim().length > 0) {
      await safeExeca("git", ["apply", "--whitespace=nowarn", "-"], {
        cwd: repoWorktree,
        input: tracked,
        stdio: "pipe",
      });
    }
    // Untracked files that are not ignored.
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    for (const file of untracked) {
      const target = join(repoWorktree, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, file), target);
    }
    // Record the carried-over state as the starting point (the commit lives only in the checkout's
    // detached HEAD and is never referenced by a branch).
    if ((await git(repoWorktree, ["status", "--porcelain"])).trim().length > 0) {
      await git(repoWorktree, ["add", "--all"]);
      await safeExeca(
        "git",
        [
          "-c", "user.name=autoremediator",
          "-c", "user.email=autoremediator@localhost",
          "-c", "commit.gpgsign=false",
          "commit", "--no-verify", "--quiet", "-m", "autoremediator: working tree at attempt start",
        ],
        { cwd: repoWorktree, stdio: "pipe" },
      );
    }
  } catch (error) {
    await removeWorktree(root, repoWorktree);
    throw error;
  }

  // `git` reports real paths; compare like with like (macOS /var is a symlink to /private/var).
  const sub = relative(realpathSync(root), realpathSync(cwd));
  return {
    path: sub ? join(repoWorktree, sub) : repoWorktree,
    base: (await git(repoWorktree, ["rev-parse", "HEAD"])).trim(),
    remove: () => removeWorktree(root, repoWorktree),
  };
}

async function removeWorktree(root: string, path: string): Promise<void> {
  await git(root, ["worktree", "remove", "--force", path]).catch(() => undefined);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await git(root, ["worktree", "prune"]).catch(() => undefined);
  // Leave no empty per-project directory behind in the cache.
  const parent = dirname(path);
  try {
    if (readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {
    // Already gone, or in use by another attempt.
  }
}

/**
 * The change made in a worktree since its base commit, as a patch that `git apply` accepts (new
 * files included). Empty when nothing changed.
 */
export async function worktreeDiff(worktree: string): Promise<string> {
  // Intent-to-add makes new files part of `git diff` without committing anything.
  await git(worktree, ["add", "--intent-to-add", "--all"]);
  return gitPatch(worktree, ["diff", "HEAD", "--binary"]);
}

/**
 * Remove a checkout made by `createWorktree`, given only its path (an attempt can outlive the
 * process that created it). Safe to call for a checkout that is already gone.
 */
export async function discardWorktree(projectCwd: string, checkoutPath: string): Promise<void> {
  const root = (await git(projectCwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!root) return;
  const top = existsSync(checkoutPath)
    ? (await git(checkoutPath, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim()
    : "";
  await removeWorktree(root, top || checkoutPath);
}
