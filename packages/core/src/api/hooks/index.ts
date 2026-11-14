import { chmodSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { renderDiff } from "../init/diff.js";
import { detectGit, detectManager } from "./detect.js";
import { planHooks } from "./plan.js";
import { HOOK_NAMES, type HookFileChange, type HooksOptions, type HooksResult } from "./types.js";

export { HOOK_MANAGERS, HOOK_NAMES } from "./types.js";
export type {
  HookChangeSummary,
  HookManager,
  HookName,
  HooksOptions,
  HooksResult,
  HookState,
  HookStatus,
} from "./types.js";

/** Diff text for a change; a removed file shows every line as removed. */
function diffFor(change: HookFileChange): string {
  if (change.action !== "delete") return renderDiff(change.path, change.before, change.after);
  const lines = (change.before ?? "").replace(/\n$/, "").split("\n");
  return [`--- a/${change.path}`, "+++ /dev/null", ...lines.map((line) => `-${line}`)].join("\n");
}

function write(change: HookFileChange): void {
  if (change.action === "delete") {
    unlinkSync(change.absolutePath);
    return;
  }
  mkdirSync(dirname(change.absolutePath), { recursive: true });
  writeFileSync(change.absolutePath, change.after, "utf8");
  if (change.executable) {
    chmodSync(change.absolutePath, statSync(change.absolutePath).mode | 0o755);
  }
}

/**
 * Install, remove or check the git hooks that run Autoremediator: `pre-push` blocks a push whose
 * dependency changes make the project less safe, `post-merge` prints a one-line advisory.
 *
 * It finds the hook manager (husky, lefthook, the pre-commit framework, else plain git hooks) and
 * writes what that tool expects. Everything it writes sits in a marked block or a named entry;
 * a file it cannot extend safely is reported as a conflict and left alone. Without `yes` it only
 * reports what it would change.
 */
export async function installHooks(options: HooksOptions = {}): Promise<HooksResult> {
  const context = await detectGit(resolve(options.cwd ?? process.cwd()));
  const choice = detectManager(context, options.manager);
  const hooks =
    options.hooks && options.hooks.length > 0
      ? HOOK_NAMES.filter((hook) => options.hooks?.includes(hook))
      : [...HOOK_NAMES];
  const uninstall = options.uninstall === true;
  const plan = planHooks({ context, choice, hooks, uninstall });

  const pending = plan.changes.filter(
    (change) =>
      change.action === "create" || change.action === "update" || change.action === "delete",
  );
  let applied = false;
  if (options.yes && !options.check) {
    for (const change of pending) write(change);
    applied = pending.length > 0;
  }

  return {
    cwd: context.cwd,
    root: context.root,
    manager: choice.manager,
    managerReason: choice.reason,
    action: uninstall ? "uninstall" : "install",
    hooks: plan.statuses,
    changes: plan.changes.map((change) => ({
      path: change.path,
      action: change.action,
      reason: change.reason,
      diff: pending.includes(change) ? diffFor(change) : "",
    })),
    drift: pending.length > 0,
    applied,
    conflicts: plan.changes
      .filter((change) => change.action === "conflict")
      .map((change) => change.path),
    nextSteps: pending.length > 0 || applied ? plan.nextSteps : [],
  };
}
