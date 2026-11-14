/**
 * Safe merges for the files `init` touches. Each returns the new content, or a conflict reason.
 * Rules: never remove or reorder anything the user wrote, never overwrite an existing
 * `autoremediator` entry (it may carry their own settings), refuse to touch a file we cannot parse.
 */
export type MergeResult = { content: string } | { conflict: string };

export interface McpServerEntry {
  command: string;
  args: string[];
}

export const SERVER_NAME = "autoremediator";

function detectIndent(text: string): string {
  const match = /^( +|\t)"/m.exec(text);
  return match?.[1] ?? "  ";
}

/**
 * Add the server under `key` of a JSON MCP config (`mcpServers` or `servers`).
 * `extra` carries host-specific fields such as `"type": "stdio"`.
 */
export function mergeJsonMcpConfig(
  existing: string | undefined,
  key: "mcpServers" | "servers",
  entry: McpServerEntry,
  extra: Record<string, unknown> = {},
): MergeResult {
  let doc: Record<string, unknown> = {};
  let indent = "  ";
  if (existing !== undefined && existing.trim() !== "") {
    indent = detectIndent(existing);
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { conflict: "not valid JSON, so it was left alone" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { conflict: "is not a JSON object, so it was left alone" };
    }
    doc = parsed as Record<string, unknown>;
  }
  const current = doc[key];
  if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
    return { conflict: `has a "${key}" that is not an object, so it was left alone` };
  }
  const servers = { ...(current as Record<string, unknown> | undefined) };
  if (!(SERVER_NAME in servers)) {
    servers[SERVER_NAME] = { ...extra, ...entry };
  }
  const merged = { ...doc, [key]: servers };
  return { content: `${JSON.stringify(merged, null, indent)}\n` };
}

/** Codex keeps MCP servers as `[mcp_servers.<name>]` tables in TOML. */
export function mergeCodexToml(existing: string | undefined, entry: McpServerEntry): MergeResult {
  const header = `[mcp_servers.${SERVER_NAME}]`;
  const block = [
    header,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    "",
  ].join("\n");
  if (existing === undefined || existing.trim() === "") return { content: block };
  const lines = existing.split("\n");
  if (lines.some((line) => line.trim() === header || line.trim().startsWith(`[mcp_servers.${SERVER_NAME}.`))) {
    return { content: existing };
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${existing}${separator}${block}` };
}

const BEGIN = "<!-- autoremediator:begin -->";
const END = "<!-- autoremediator:end -->";

/** Insert or refresh a marked section in a Markdown file. Text outside the markers is never touched. */
export function mergeMarkedSection(existing: string | undefined, body: string): MergeResult {
  const section = `${BEGIN}\n${body.trim()}\n${END}\n`;
  if (existing === undefined || existing.trim() === "") return { content: section };
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end > start) {
    return { content: existing.slice(0, start) + section + existing.slice(end + END.length).replace(/^\n/, "") };
  }
  if (start !== -1 || end !== -1) {
    return { conflict: "has an unmatched autoremediator marker, so it was left alone" };
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${existing}${separator}${section}` };
}

/** Ensure each line is present in a `.gitignore`. */
export function mergeGitignore(existing: string | undefined, lines: string[]): MergeResult {
  const present = new Set((existing ?? "").split("\n").map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line) && !present.has(line.replace(/\/$/, "")));
  if (missing.length === 0) return { content: existing ?? "" };
  const base = existing ?? "";
  const prefix = base === "" || base.endsWith("\n") ? base : `${base}\n`;
  return { content: `${prefix}${missing.join("\n")}\n` };
}
