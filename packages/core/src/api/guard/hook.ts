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
  const all = extractInstallSpecs(command);
  const specs = all.slice(0, MAX_SPECS);
  const unchecked = all.length - specs.length;
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
  if (unchecked > 0) {
    // Never wave through what was not looked at.
    return {
      decision: "ask",
      reason: `Autoremediator checked the first ${specs.length} packages in this command and found no problems, but ${unchecked} more were not checked. Install them in smaller commands, or check them with \`autoremediator guard\`.`,
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

/** Agent hosts whose pre-command hook `guard-hook` can answer. */
export const HOOK_HOSTS = ["claude-code", "cursor", "copilot"] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];

/**
 * The JSON a Cursor `beforeShellExecution` hook prints. Always JSON, including for allow: Cursor
 * blocks the action when the output is not valid JSON for its schema, and the schema is
 * `{ permission: "allow" | "deny" | "ask", user_message?, agent_message? }`.
 * Source: https://cursor.com/docs/agent/hooks (beforeShellExecution).
 */
export function cursorHookOutput(decision: HookDecision): string {
  if (decision.decision === "allow") return JSON.stringify({ permission: "allow" });
  return JSON.stringify({
    permission: decision.decision,
    user_message: decision.reason,
    agent_message: decision.reason,
  });
}

/**
 * The JSON a Copilot `preToolUse` hook prints (Copilot CLI, the cloud agent, and the Copilot
 * harness in VS Code): `{ permissionDecision: "allow" | "deny" | "ask", permissionDecisionReason }`.
 * Nothing is printed to allow, which leaves the normal permission flow in charge instead of
 * pre-approving the command. Under the cloud agent and CLI autopilot `ask` becomes a deny.
 * Source: docs.github.com/en/copilot/reference/hooks-reference (preToolUse decision control).
 */
export function copilotHookOutput(decision: HookDecision): string | undefined {
  if (decision.decision === "allow") return undefined;
  return JSON.stringify({ permissionDecision: decision.decision, permissionDecisionReason: decision.reason });
}

/** What `host` expects on stdout for `decision`; `undefined` means print nothing. */
export function hookOutputFor(host: HookHost, decision: HookDecision): string | undefined {
  if (host === "cursor") return cursorHookOutput(decision);
  if (host === "copilot") return copilotHookOutput(decision);
  return claudeCodeHookOutput(decision);
}

const SHELL_TOOLS = /^(?:bash|powershell)$/i;

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return objectOf(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The shell command a hook call is about to run, or undefined when it is not a shell call.
 *
 * - Claude Code: `{ tool_name: "Bash", tool_input: { command } }`
 * - Cursor `beforeShellExecution`: `{ command, cwd }`
 * - Copilot `preToolUse`: `{ toolName: "bash", toolArgs: "{\"command\":\"ls\"}" }` (toolArgs is a JSON
 *   string), or for the PascalCase `PreToolUse` alias `{ tool_name: "Bash", tool_input }`.
 */
export function commandFromHookInput(host: HookHost, input: Record<string, unknown>): string | undefined {
  if (host === "cursor") return typeof input.command === "string" ? input.command : undefined;
  const tool = host === "copilot" ? (input.toolName ?? input.tool_name) : input.tool_name;
  if (tool !== undefined) {
    const shell = host === "claude-code" ? tool === "Bash" : typeof tool === "string" && SHELL_TOOLS.test(tool);
    if (!shell) return undefined;
  }
  const args = host === "copilot" ? (input.toolArgs ?? input.tool_input) : input.tool_input;
  const command = objectOf(args)?.command;
  return typeof command === "string" ? command : undefined;
}

/**
 * Handle one hook call for any supported host: `stdin` is the hook's JSON input, the result is what
 * to print (or nothing). Never throws and never blocks on its own failure: malformed input or an
 * internal error lets the command through (Cursor still gets an explicit allow, because it rejects
 * output that is not valid JSON).
 */
export async function runHostHook(
  host: HookHost,
  stdin: string,
  check?: (specs: string[]) => Promise<GuardReport[]>,
): Promise<string | undefined> {
  const proceed: HookDecision = { decision: "allow", reason: "not checked" };
  try {
    const input = objectOf(stdin);
    const command = input ? commandFromHookInput(host, input) : undefined;
    if (command === undefined) return hookOutputFor(host, proceed);
    return hookOutputFor(host, await decideForCommand(command, check));
  } catch {
    return hookOutputFor(host, proceed);
  }
}

/** Exit code for the `guard` command: 0 clear, 3 something to check, 4 blocked. */
export function guardExitCode(reports: readonly GuardReport[]): number {
  if (reports.some((report) => report.verdict === "block")) return 4;
  return reports.some((report) => report.verdict === "warn") ? 3 : 0;
}
