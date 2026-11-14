import { guardPackages } from "./index.js";
import { extractInstallSpecs } from "./spec.js";
import type { GuardReport } from "./types.js";

/** What a coding agent's pre-tool hook should do with a command. */
export interface HookDecision {
  decision: "allow" | "ask" | "deny";
  reason: string;
}

const MAX_SPECS = 10;

function describe(report: GuardReport): string {
  const lines = report.findings
    .filter((finding) => finding.severity !== "info")
    .map((finding) => `- ${finding.message}`);
  const alt = report.alternative
    ? `  Instead: ${report.alternative.packageName}${report.alternative.version ? `@${report.alternative.version}` : ""} (${report.alternative.reason}).`
    : "";
  return `${report.spec}: ${report.verdict}\n${lines.join("\n")}${alt ? `\n${alt}` : ""}`;
}

/**
 * Decide on a shell command an agent wants to run. Commands that do not install packages are
 * allowed untouched. This catches the plain forms of install commands (see `extractInstallSpecs`);
 * it is a guard rail against an agent's mistakes, not a security boundary.
 */
export async function decideForCommand(
  command: string,
  check: (specs: string[]) => Promise<GuardReport[]> = (specs) => guardPackages(specs),
): Promise<HookDecision> {
  const specs = extractInstallSpecs(command).slice(0, MAX_SPECS);
  if (specs.length === 0) return { decision: "allow", reason: "no packages are being installed" };

  const reports = await check(specs);
  const blocked = reports.filter((report) => report.verdict === "block");
  const warned = reports.filter((report) => report.verdict === "warn");
  if (blocked.length > 0) {
    return {
      decision: "deny",
      reason: `Autoremediator blocked this install:\n${[...blocked, ...warned].map((entry) => describe(entry)).join("\n")}\nTell the user what was found and ask how to proceed; do not work around it.`,
    };
  }
  if (warned.length > 0) {
    return {
      decision: "ask",
      reason: `Autoremediator found something to check before installing:\n${warned.map((entry) => describe(entry)).join("\n")}`,
    };
  }
  return { decision: "allow", reason: "no problems found" };
}

/** The JSON a Claude Code PreToolUse hook prints, or nothing when the command should proceed as usual. */
export function claudeCodeHookOutput(decision: HookDecision): string | undefined {
  if (decision.decision === "allow") return undefined;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  });
}

/**
 * Handle one hook call: `stdin` is the hook's JSON input. Never throws and never blocks on its own
 * failure: malformed input or an internal error lets the command through (lookup failures inside the
 * guard are warnings, which ask).
 */
export async function runClaudeCodeHook(
  stdin: string,
  check?: (specs: string[]) => Promise<GuardReport[]>,
): Promise<string | undefined> {
  try {
    const input = JSON.parse(stdin) as { tool_name?: unknown; tool_input?: { command?: unknown } };
    if (input.tool_name !== undefined && input.tool_name !== "Bash") return undefined;
    const command = input.tool_input?.command;
    if (typeof command !== "string") return undefined;
    return claudeCodeHookOutput(await decideForCommand(command, check));
  } catch {
    return undefined;
  }
}

/** Exit code for the `guard` command: 0 clear, 3 something to check, 4 blocked. */
export function guardExitCode(reports: readonly GuardReport[]): number {
  if (reports.some((report) => report.verdict === "block")) return 4;
  return reports.some((report) => report.verdict === "warn") ? 3 : 0;
}
