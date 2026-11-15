import {
  EXIT_CODES,
  installHooks,
  HOOK_MANAGERS,
  HOOK_NAMES,
  type HookManager,
  type HookName,
  type HooksResult,
} from "../../../api/index.js";
import { logJson } from "../output.js";
import { confirmInteractively } from "../prompt.js";
import type { OutputFormat } from "../types.js";

export interface HookCliOptions {
  cwd: string;
  outputFormat: OutputFormat;
  hooks?: string;
  manager?: string;
  yes?: boolean;
  allowSharedHooksPath?: boolean;
}

function parseHookNames(value: string | undefined): HookName[] | undefined {
  if (!value) return undefined;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !(HOOK_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown hook: ${unknown.join(", ")}. Choose from ${HOOK_NAMES.join(", ")}.`);
  }
  return names as HookName[];
}

function parseHookManager(value: string | undefined): HookManager | undefined {
  if (!value) return undefined;
  if (!(HOOK_MANAGERS as readonly string[]).includes(value)) {
    throw new Error(`Unknown hook manager: ${value}. Choose from ${HOOK_MANAGERS.join(", ")}.`);
  }
  return value as HookManager;
}

function describeHooks(result: HooksResult, header: string): string {
  const lines = [header, `Hook manager: ${result.manager} (${result.managerReason})`];
  for (const hook of result.hooks) {
    lines.push(`  ${hook.state.padEnd(9)} ${hook.hook.padEnd(10)} ${hook.path}  (${hook.detail})`);
  }
  for (const change of result.changes) {
    if (change.action === "conflict") lines.push(`  conflict  ${change.reason}`);
  }
  return lines.join("\n");
}

function planHeader(mode: "install" | "uninstall" | "status"): string {
  if (mode === "status") return "Hook status";
  return mode === "uninstall" ? "Hook removal plan" : "Hook install plan";
}

function nothingToDoMessage(mode: "install" | "uninstall" | "status"): string {
  if (mode === "uninstall") return "\nNothing to remove.\n";
  return mode === "status" ? "\nAll hooks are installed.\n" : "\nAlready installed.\n";
}

/** `hook install`, `hook uninstall` and `hook status`; same approval rules as `init`. */
export async function runHook(
  mode: "install" | "uninstall" | "status",
  opts: HookCliOptions,
): Promise<void> {
  const base = {
    cwd: opts.cwd,
    hooks: parseHookNames(opts.hooks),
    manager: parseHookManager(opts.manager),
    uninstall: mode === "uninstall",
    allowSharedHooksPath: opts.allowSharedHooksPath === true,
  };
  const check = mode === "status";
  let result = await installHooks({ ...base, check, yes: check ? false : opts.yes });
  const json = opts.outputFormat === "json";
  const interactive = !json && !check && !opts.yes && process.stdin.isTTY && process.stdout.isTTY;

  if (!json) {
    process.stdout.write(`${describeHooks(result, planHeader(mode))}\n`);
    if (!result.applied && !check) {
      for (const change of result.changes) {
        if (change.diff) process.stdout.write(`\n${change.diff}\n`);
      }
    }
  }

  if (interactive && result.drift) {
    if (
      await confirmInteractively(
        `\nWrite ${result.changes.filter((c) => c.diff || c.action === "update").length} file(s)? [y/N] `,
      )
    ) {
      result = await installHooks({ ...base, yes: true });
      process.stdout.write("Done.\n");
      for (const step of result.nextSteps) process.stdout.write(`Next: ${step}\n`);
    }
    return;
  }

  if (json) logJson(result);
  else {
    if (result.applied) process.stdout.write("\nWritten.\n");
    else if (!check && result.drift) {
      process.stdout.write("\nNothing written. Run again with --yes to apply.\n");
    } else if (!result.drift && result.conflicts.length === 0) {
      process.stdout.write(nothingToDoMessage(mode));
    }
    for (const step of result.nextSteps) process.stdout.write(`Next: ${step}\n`);
  }

  if (check) {
    if (result.drift || result.conflicts.length > 0) process.exitCode = EXIT_CODES.failed;
  } else if (!result.applied && result.drift) {
    // Changes are waiting for a yes that this run could not get.
    process.exitCode = EXIT_CODES.needsApproval;
  } else if (result.conflicts.length > 0) {
    process.exitCode = EXIT_CODES.failed;
  }
}
