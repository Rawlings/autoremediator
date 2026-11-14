import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { GitContext, ManagerChoice } from "./detect.js";
import {
  lefthookState,
  mergeLefthook,
  mergePreCommit,
  mergeShellBlock,
  preCommitState,
  removeLefthook,
  removePreCommit,
  removeShellBlock,
  shellBlockState,
  type HookMergeResult,
} from "./merge.js";
import { hookBlock } from "./scripts.js";
import type { HookFileChange, HookName, HookState, HookStatus } from "./types.js";

export interface HooksPlan {
  changes: HookFileChange[];
  statuses: HookStatus[];
  nextSteps: string[];
}

interface PlanInput {
  context: GitContext;
  choice: ManagerChoice;
  hooks: HookName[];
  uninstall: boolean;
}

interface FileRead {
  content?: string;
  symlink: boolean;
  mode?: number;
}

function readFile(absolutePath: string): FileRead {
  if (!existsSync(absolutePath) && !isSymlink(absolutePath)) return { symlink: false };
  if (isSymlink(absolutePath)) return { symlink: true };
  return {
    content: readFileSync(absolutePath, "utf8"),
    symlink: false,
    mode: lstatSync(absolutePath).mode,
  };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function displayPath(context: GitContext, absolutePath: string): string {
  const rel = relative(context.root, absolutePath);
  return rel === "" || rel.startsWith("..") ? absolutePath : rel.split("\\").join("/");
}

interface ToChangeInput {
  path: string;
  absolutePath: string;
  reason: string;
  before: string | undefined;
  merged: HookMergeResult;
  uninstall: boolean;
  executable?: boolean;
  /** Existing file lacks the execute bit although the content is right. */
  needsChmod?: boolean;
}

/** Turn a merge outcome into a reviewable change. */
function toChange(input: ToChangeInput): HookFileChange {
  const { path, absolutePath, reason, before, merged, uninstall } = input;
  const base = { path, absolutePath, ...(before === undefined ? {} : { before }) };
  if ("conflict" in merged) {
    return {
      ...base,
      action: "conflict",
      reason: `${path} ${merged.conflict}`,
      after: before ?? "",
    };
  }
  if ("remove" in merged) return { ...base, action: "delete", reason, after: "" };
  if (before === undefined) {
    return uninstall
      ? { ...base, action: "unchanged", reason: "nothing to remove", after: "" }
      : {
          ...base,
          action: "create",
          reason,
          after: merged.content,
          ...(input.executable ? { executable: true } : {}),
        };
  }
  if (before === merged.content) {
    if (input.needsChmod) {
      return {
        ...base,
        action: "update",
        reason: "make the hook executable, git ignores it otherwise",
        after: before,
        executable: true,
      };
    }
    return {
      ...base,
      action: "unchanged",
      reason: uninstall ? "nothing to remove" : "already installed",
      after: before,
    };
  }
  return {
    ...base,
    action: "update",
    reason,
    after: merged.content,
    ...(input.executable ? { executable: true } : {}),
  };
}

function detail(state: HookState, uninstall: boolean): string {
  const text: Record<HookState, [install: string, uninstall: string]> = {
    installed: ["installed", "installed, will be removed"],
    missing: ["not installed yet", "not installed"],
    modified: [
      "differs from what would be written; install refreshes it",
      "differs from what would be written, the block will be removed",
    ],
    conflict: ["cannot be changed safely", "cannot be changed safely"],
  };
  return text[state][uninstall ? 1 : 0];
}

/** Husky and plain git: one script file per hook, with a marked block. */
function planScriptFiles(input: PlanInput, directory: string, strictExec: boolean): HooksPlan {
  const { context, hooks, uninstall } = input;
  const changes: HookFileChange[] = [];
  const statuses: HookStatus[] = [];
  const nextSteps: string[] = [];

  for (const hook of hooks) {
    const absolutePath = join(directory, hook);
    const path = displayPath(context, absolutePath);
    const block = hookBlock(hook, { projectDir: context.projectDir });
    const file = readFile(absolutePath);

    if (file.symlink) {
      changes.push({
        path,
        absolutePath,
        action: "conflict",
        reason: `${path} is a symbolic link, so it was left alone`,
        after: "",
      });
      statuses.push({ hook, state: "conflict", path, detail: "is a symbolic link" });
      continue;
    }

    const state = shellBlockState(file.content, block);
    const notExecutable = strictExec && file.mode !== undefined && (file.mode & 0o111) === 0;
    const huskyV8 = !strictExec && existsSync(join(directory, "_", "husky.sh"));
    const merged = uninstall
      ? removeShellBlock(file.content)
      : mergeShellBlock(
          file.content,
          block,
          huskyV8 ? { preamble: '. "$(dirname -- "$0")/_/husky.sh"' } : {},
        );
    const change = toChange({
      path,
      absolutePath,
      reason: uninstall ? `remove the ${hook} block` : `check dependency changes in ${hook}`,
      before: file.content,
      merged,
      uninstall,
      executable: true,
      needsChmod: !uninstall && notExecutable && state === "installed",
    });
    changes.push(change);
    const effective: HookState =
      change.action === "conflict"
        ? "conflict"
        : state === "installed" && notExecutable
          ? "modified"
          : state;
    statuses.push({
      hook,
      state: effective,
      path,
      detail:
        state === "installed" && notExecutable
          ? "installed but not executable, git ignores it"
          : detail(effective, uninstall),
    });
  }
  return { changes, statuses, nextSteps };
}

type StateFn = (existing: string | undefined, hook: HookName, block: string) => HookState;

/** lefthook and pre-commit: one configuration file holding an entry per hook. */
function planConfigFile(
  input: PlanInput,
  file: string,
  stateOf: StateFn,
  merge: typeof mergeLefthook,
  remove: typeof removeLefthook,
): HooksPlan {
  const { context, hooks, uninstall } = input;
  const absolutePath = join(context.root, file);
  const read = readFile(absolutePath);
  const path = displayPath(context, absolutePath);

  if (read.symlink) {
    return {
      changes: [
        {
          path,
          absolutePath,
          action: "conflict",
          reason: `${path} is a symbolic link, so it was left alone`,
          after: "",
        },
      ],
      statuses: hooks.map((hook) => ({
        hook,
        state: "conflict" as const,
        path,
        detail: "configuration is a symbolic link",
      })),
      nextSteps: [],
    };
  }

  const blocks: Partial<Record<HookName, string>> = {};
  for (const hook of hooks) blocks[hook] = hookBlock(hook, { projectDir: context.projectDir });
  const merged = uninstall ? remove(read.content, hooks) : merge(read.content, blocks);
  const change = toChange({
    path,
    absolutePath,
    reason: uninstall ? "remove the Autoremediator hooks" : "add the Autoremediator hooks",
    before: read.content,
    merged,
    uninstall,
  });
  const statuses = hooks.map((hook): HookStatus => {
    const found = stateOf(read.content, hook, blocks[hook] ?? "");
    // The file as a whole cannot be changed safely, so no hook in it can be installed or removed.
    const state: HookState =
      change.action === "conflict" && found !== "installed" ? "conflict" : found;
    return { hook, state, path, detail: detail(state, uninstall) };
  });
  return { changes: [change], statuses, nextSteps: [] };
}

/** Everything `hook install` (or `uninstall`) would write, in a stable order. Reads; writes nothing. */
export function planHooks(input: PlanInput): HooksPlan {
  const { context, choice, hooks, uninstall } = input;
  const pending = (plan: HooksPlan): boolean =>
    plan.changes.some((change) => change.action === "create" || change.action === "update");
  if (choice.manager === "husky") {
    const plan = planScriptFiles(input, join(context.root, ".husky"), false);
    if (!uninstall && pending(plan) && !/\.husky/.test(context.hooksPath ?? "")) {
      plan.nextSteps.push(
        'Husky is not active yet: run "husky" (or "npx husky init") so git uses .husky/.',
      );
    }
    return plan;
  }
  if (choice.manager === "lefthook") {
    const plan = planConfigFile(
      input,
      choice.configFile ?? "lefthook.yml",
      lefthookState,
      mergeLefthook,
      removeLefthook,
    );
    if (pending(plan)) plan.nextSteps.push('Run "lefthook install" to sync the git hooks.');
    return plan;
  }
  if (choice.manager === "pre-commit") {
    const plan = planConfigFile(
      input,
      choice.configFile ?? ".pre-commit-config.yaml",
      preCommitState,
      mergePreCommit,
      removePreCommit,
    );
    if (pending(plan)) {
      const types = hooks.map((hook) => `--hook-type ${hook}`).join(" ");
      plan.nextSteps.push(
        uninstall
          ? 'Run "pre-commit uninstall --hook-type pre-push --hook-type post-merge" if you no longer use those stages.'
          : `Run "pre-commit install ${types}" to activate the hooks.`,
      );
    }
    return plan;
  }
  return planScriptFiles(input, context.hooksDir, true);
}
