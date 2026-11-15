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

/** Split a TOML key (`a.b."c.d"`) into its parts; undefined when it is not a plain key. */
function splitTomlKey(text: string): string[] | undefined {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest !== "") {
    const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(rest);
    const bare = /^[A-Za-z0-9_-]+/.exec(rest);
    const token = quoted ?? bare;
    if (!token) return undefined;
    parts.push(quoted ? (quoted[1] ?? quoted[2] ?? "") : token[0]);
    rest = rest.slice(token[0].length).trimStart();
    if (rest === "") break;
    if (!rest.startsWith(".")) return undefined;
    rest = rest.slice(1).trimStart();
  }
  return parts.length > 0 ? parts : undefined;
}

/** Codex keeps MCP servers as `[mcp_servers.<name>]` tables in TOML. */
export function mergeCodexToml(existing: string | undefined, entry: McpServerEntry): MergeResult {
  const crlf = existing?.includes("\r\n") === true;
  const eol = crlf ? "\r\n" : "\n";
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    "",
  ].join(eol);
  if (existing === undefined || existing.trim() === "") return { content: block };

  // Find how (if at all) the autoremediator server is already defined, in any TOML spelling.
  let table: string[] = [];
  let hasTable = false;
  for (const raw of existing.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    const header = /^\[(?!\[)\s*(.+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = splitTomlKey(header[1] ?? "") ?? [];
      if (table[0] === "mcp_servers" && table[1] === SERVER_NAME) hasTable = true;
      continue;
    }
    const assignment = /^([^=#]+?)\s*=/.exec(line);
    if (!assignment) continue;
    const key = splitTomlKey(assignment[1] ?? "");
    if (!key) continue;
    const path = [...table, ...key];
    if (path[0] === "mcp_servers" && path.length === 1) {
      return { conflict: 'defines mcp_servers inline, so it was left alone; add the autoremediator server to it by hand' };
    }
    if (path[0] === "mcp_servers" && path[1] === SERVER_NAME && !(table[0] === "mcp_servers" && table[1] === SERVER_NAME)) {
      return { conflict: "defines the autoremediator server with dotted or inline keys, so it was left alone" };
    }
  }
  if (hasTable) return { content: existing };
  const separator = existing.endsWith("\n") ? eol : `${eol}${eol}`;
  return { content: `${existing}${separator}${block}` };
}

const BEGIN = "<!-- autoremediator:begin -->";
const END = "<!-- autoremediator:end -->";

/** Insert or refresh a marked section in a Markdown file. Text outside the markers is never touched. */
export function mergeMarkedSection(existing: string | undefined, body: string): MergeResult {
  // A file that uses CRLF line endings gets CRLF lines, so it does not end up with mixed endings.
  const crlf = existing !== undefined && /^[^\n]*\r\n/.test(existing);
  const eol = crlf ? "\r\n" : "\n";
  const section = `${[BEGIN, ...body.trim().split("\n"), END].join(eol)}${eol}`;
  if (existing === undefined || existing.trim() === "") return { content: section };
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end > start) {
    return {
      content: existing.slice(0, start) + section + existing.slice(end + END.length).replace(/^\r?\n/, ""),
    };
  }
  if (start !== -1 || end !== -1) {
    return { conflict: "has an unmatched autoremediator marker, so it was left alone" };
  }
  const separator = existing.endsWith("\n") ? eol : `${eol}${eol}`;
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

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

/** Add a PreToolUse hook to `.claude/settings.json`, keeping everything else. Present already: unchanged. */
export function mergeClaudeGuardHook(existing: string | undefined, command: string): MergeResult {
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
  const hooks = doc.hooks;
  if (hooks !== undefined && (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))) {
    return { conflict: 'has a "hooks" that is not an object, so it was left alone' };
  }
  const events = { ...(hooks as Record<string, unknown> | undefined) };
  const pre = events.PreToolUse;
  if (pre !== undefined && !Array.isArray(pre)) {
    return { conflict: 'has a "hooks.PreToolUse" that is not a list, so it was left alone' };
  }
  const groups = [...((pre as unknown[] | undefined) ?? [])];
  let present = false;
  for (const group of groups) {
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      return { conflict: 'has a "hooks.PreToolUse" entry that is not an object, so it was left alone' };
    }
    const inner = (group as HookGroup).hooks;
    if (inner === undefined) continue;
    if (!Array.isArray(inner)) {
      return { conflict: 'has a "hooks.PreToolUse" entry whose "hooks" is not a list, so it was left alone' };
    }
    for (const hook of inner as unknown[]) {
      if (typeof hook !== "object" || hook === null || Array.isArray(hook)) {
        return { conflict: 'has a hook in "hooks.PreToolUse" that is not an object, so it was left alone' };
      }
      const hookCommand = (hook as { command?: unknown }).command;
      if (hookCommand !== undefined && typeof hookCommand !== "string") {
        return { conflict: 'has a hook in "hooks.PreToolUse" whose command is not text, so it was left alone' };
      }
      if (hookCommand?.includes("guard-hook")) present = true;
    }
  }
  if (!present) {
    groups.push({ matcher: "Bash", hooks: [{ type: "command", command }] });
  }
  return { content: `${JSON.stringify({ ...doc, hooks: { ...events, PreToolUse: groups } }, null, indent)}\n` };
}

/**
 * Add a hook entry to a `{ "version": 1, "hooks": { "<event>": [...] } }` file, the shape Cursor
 * (`.cursor/hooks.json`) and Copilot (`.github/hooks/*.json`) both read. Keeps everything the user
 * wrote; an entry that already runs `guard-hook` leaves the file unchanged.
 * Sources: https://cursor.com/docs/agent/hooks and docs.github.com/en/copilot/reference/hooks-reference
 */
export function mergeHooksFile(existing: string | undefined, event: string, entry: Record<string, unknown>): MergeResult {
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
  const hooks = doc.hooks;
  if (hooks !== undefined && (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))) {
    return { conflict: 'has a "hooks" that is not an object, so it was left alone' };
  }
  const events = { ...(hooks as Record<string, unknown> | undefined) };
  const current = events[event];
  if (current !== undefined && !Array.isArray(current)) {
    return { conflict: `has a "hooks.${event}" that is not a list, so it was left alone` };
  }
  const list = [...((current as unknown[] | undefined) ?? [])];
  const present = list.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      Object.values(item).some((value) => typeof value === "string" && value.includes("guard-hook")),
  );
  if (!present) list.push(entry);
  return {
    content: `${JSON.stringify({ version: 1, ...doc, hooks: { ...events, [event]: list } }, null, indent)}\n`,
  };
}
/**
 * Ignore run state but keep the few files meant to be committed (recipes, the autonomy track record).
 * Git cannot re-include a file under an ignored directory, so the directory entry `.autoremediator/`
 * is replaced by `.autoremediator/*` plus the negations.
 */
export const RUN_STATE_IGNORE = [
  ".autoremediator/*",
  "!.autoremediator/recipes/",
  "!.autoremediator/track-record.json",
  "!.autoremediator/memory.md",
] as const;

const STAR_ENTRY = RUN_STATE_IGNORE[0];
const NEGATIONS: readonly string[] = RUN_STATE_IGNORE.slice(1);
const DIRECTORY_FORMS = new Set([".autoremediator/", ".autoremediator", "/.autoremediator/", "/.autoremediator"]);
const STAR_FORMS = new Set([".autoremediator/*", "/.autoremediator/*"]);
const trimmed = (line: string): string => line.trim();

export function mergeRunStateIgnore(text = ""): MergeResult {
  const original = text === "" ? [] : text.replace(/\n$/, "").split("\n");

  // Where the star entry goes: where the first star or directory entry is, else the end.
  const firstEntry = original.findIndex((line) => STAR_FORMS.has(trimmed(line)) || DIRECTORY_FORMS.has(trimmed(line)));
  const lines: string[] = [];
  let starAt = -1;
  for (const [index, line] of original.entries()) {
    const entry = trimmed(line);
    if (DIRECTORY_FORMS.has(entry) || STAR_FORMS.has(entry)) {
      // One star entry only: a directory entry next to it would ignore the whole folder again.
      if (starAt === -1) {
        starAt = lines.length;
        lines.push(DIRECTORY_FORMS.has(entry) ? STAR_ENTRY : line);
      }
      continue;
    }
    // A negation above the star entry is overridden by it, so it is dropped here and put back below.
    if (NEGATIONS.includes(entry) && firstEntry !== -1 && index < firstEntry) continue;
    lines.push(line);
  }
  if (starAt === -1) {
    starAt = lines.length;
    lines.push(STAR_ENTRY);
  }
  const present = new Set(lines.slice(starAt + 1).map((line) => trimmed(line)));
  const missing = NEGATIONS.filter((line) => !present.has(line));
  lines.splice(starAt + 1, 0, ...missing);
  const content = `${lines.join("\n")}\n`;
  return { content: content === text ? text : content };
}
