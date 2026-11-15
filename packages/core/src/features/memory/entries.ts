/**
 * Remediation memory entries: what a repository has learned that should survive between runs.
 *
 * Entries are short, single-line, validated facts. They are data for people and agents to read and
 * for the planner to act on; they are never instructions. Everything that enters the file goes
 * through `parseEntry`, so a hostile or careless string cannot reach a prompt or a command.
 */

import { z } from "zod";

import { sha256 } from "../../shared/hash.js";

export const MEMORY_KINDS = [
  "test-command",
  "flaky-test",
  "pinned-package",
  "rejected-upgrade",
  "install-quirk",
  "note",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** `proposed` entries (from an agent) change nothing until a person accepts them. */
export const MEMORY_STATUSES = ["active", "proposed"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_LIMITS = {
  /** Entries in the file, whatever their state. A hard cap: a file past it is read only up to it. */
  maxEntries: 200,
  /** Bytes of entry lines. A hard cap, as above. */
  maxBytes: 64 * 1024,
  /** Entries waiting for a person; an agent cannot flood the file. */
  maxProposed: 20,
  maxText: 200,
  maxCommand: 120,
  maxName: 214,
  maxSource: 60,
  /** What an auto-recorded rejection lasts: long enough to stop a retry loop, short enough to be revisited. */
  rejectionTtlDays: 90,
  /** What an auto-recorded test command lasts before a later run records it afresh. */
  testCommandTtlDays: 180,
} as const;

/** Whitespace-like characters become a space. */
const SPACE_LIKE = new Set([9, 10, 11, 12, 13, 133, 8232, 8233]);
/**
 * Other control characters, soft hyphens and fillers, zero-width characters, variation selectors
 * and bidirectional overrides: invisible to a reader, so they are removed. Code point ranges, not a
 * regular expression, so this file contains none of the characters it removes.
 */
const STRIPPED: ReadonlyArray<readonly [number, number]> = [
  "0-1f",
  "7f-9f",
  "ad",
  "34f",
  "61c",
  "115f-1160",
  "17b4-17b5",
  "180b-180f",
  "200b-200f",
  "202a-202e",
  "2060-206f",
  "3164",
  "fe00-fe0f",
  "feff",
  "ffa0",
  "fff9-fffb",
  "e0000-e0fff",
].map((range) => {
  const [from, to = from] = range.split("-").map((hex) => Number.parseInt(hex, 16));
  return [from!, to!] as const;
});

const isStripped = (code: number): boolean =>
  STRIPPED.some(([from, to]) => code >= from && code <= to);

/** One line of plain text: control and invisible characters gone, whitespace collapsed, trimmed. */
export function cleanLine(text: string): string {
  let out = "";
  for (const char of text.toWellFormed()) {
    const code = char.codePointAt(0)!;
    if (SPACE_LIKE.has(code)) out += " ";
    else if (!isStripped(code)) out += char;
  }
  return out.replaceAll(/\s+/g, " ").trim();
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const SOURCE =
  /^(?:human(?::[A-Za-z0-9 ._@-]{1,40})?|run_[0-9a-z]{20}|agent(?::run_[0-9a-z]{20}(?:\/attempt_[0-9a-z]{12})?)?)$/;
const COMMAND_TOKEN = /^[A-Za-z0-9_@:./=+-]+$/;
const COMMAND_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "deno"]);
/** Package manager scripts only: `dlx`, `exec` and `npx` would run code the project never installed. */
const COMMAND_VERBS = new Set(["test", "t", "run", "run-script", "task"]);

/** The command as an argument list, or why it is not an acceptable test command. */
export function parseTestCommand(command: string): string[] | string {
  const tokens = command.split(" ").filter((token) => token !== "");
  if (tokens.length === 0) return "the command is empty";
  if (tokens.length > 12) return "the command has more than 12 words";
  if (!tokens.every((token) => COMMAND_TOKEN.test(token))) {
    return "only letters, digits and _ @ : . / = + - are allowed (no quotes, pipes or variables)";
  }
  const runner = tokens[0]!;
  if (!COMMAND_RUNNERS.has(runner)) return "it must start with npm, pnpm, yarn, bun or deno";
  const rest = tokens.slice(1);
  // pnpm puts its workspace filter before the verb.
  const verbAt = runner === "pnpm" && rest[0] === "--filter" ? 2 : 0;
  const verb = rest[verbAt];
  if (verb === undefined || !COMMAND_VERBS.has(verb)) {
    return "after the package manager it must run `test`, `run <script>` or `task <name>`";
  }
  if (verb !== "test" && verb !== "t" && rest[verbAt + 1] === undefined) {
    return `\`${verb}\` needs a script name`;
  }
  return tokens;
}

const line = (max: number) =>
  z
    .string()
    .transform(cleanLine)
    .pipe(z.string().min(1, "must not be empty").max(max, `must be at most ${max} characters`));

const packageName = z
  .string()
  .transform(cleanLine)
  .pipe(
    z
      .string()
      .max(MEMORY_LIMITS.maxName)
      .regex(NPM_NAME, "must be an npm package name such as lodash or @scope/name"),
  );
const version = z
  .string()
  .transform(cleanLine)
  .pipe(z.string().regex(VERSION, "must be an exact version such as 4.17.21"));
const timestamp = z.iso.datetime({ offset: true });
const source = z
  .string()
  .transform(cleanLine)
  .pipe(
    z
      .string()
      .max(MEMORY_LIMITS.maxSource)
      .regex(SOURCE, 'must be "human", "human:<name>", a run id, or "agent[:<run id>]"'),
  );

const base = {
  status: z.enum(MEMORY_STATUSES),
  createdAt: timestamp,
  source,
  expiresAt: timestamp.optional(),
};

const command = z
  .string()
  .transform(cleanLine)
  .pipe(z.string().max(MEMORY_LIMITS.maxCommand))
  .superRefine((value, context) => {
    const parsed = parseTestCommand(value);
    if (typeof parsed === "string") context.addIssue({ code: "custom", message: parsed });
  });

/** An entry as it is stored: every string already clean. */
export const entrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("test-command"), command, ...base }).strict(),
  z
    .object({
      kind: z.literal("flaky-test"),
      test: line(MEMORY_LIMITS.maxText),
      note: line(MEMORY_LIMITS.maxText).optional(),
      ...base,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pinned-package"),
      package: packageName,
      reason: line(MEMORY_LIMITS.maxText),
      ...base,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rejected-upgrade"),
      package: packageName,
      fromVersion: version.optional(),
      toVersion: version,
      reason: line(MEMORY_LIMITS.maxText),
      /** The verifier check that rejected it, when a run recorded this. */
      check: line(40).optional(),
      ...base,
    })
    .strict(),
  z
    .object({ kind: z.literal("install-quirk"), text: line(MEMORY_LIMITS.maxText), ...base })
    .strict(),
  z.object({ kind: z.literal("note"), text: line(MEMORY_LIMITS.maxText), ...base }).strict(),
]);

export type StoredEntry = z.infer<typeof entrySchema>;
/** A stored entry with its id, which is derived from what makes it the same fact. */
export type MemoryEntry = StoredEntry & { id: string };

/** For the end of an exhaustive switch: a new kind that is not handled fails to compile here. */
export function unreachable(value: never): never {
  throw new Error(`unhandled memory entry ${JSON.stringify(value)}`);
}

/** What distinguishes one entry from another of the same kind. */
function identity(entry: StoredEntry): string[] {
  switch (entry.kind) {
    case "test-command": {
      return [entry.command];
    }
    case "flaky-test": {
      return [entry.test];
    }
    case "pinned-package": {
      return [entry.package];
    }
    case "rejected-upgrade": {
      return [entry.package, entry.toVersion];
    }
    case "install-quirk":
    case "note": {
      return [entry.text];
    }
    default: {
      return unreachable(entry);
    }
  }
}

export function entryId(entry: StoredEntry): string {
  const digest = sha256(JSON.stringify([entry.kind, ...identity(entry)]));
  return `mem_${digest.slice(0, 10)}`;
}

export const MEMORY_ID = /^mem_[0-9a-f]{10}$/;

/** Validate and clean an entry. The result is what gets stored. */
export function parseEntry(value: unknown): { entry: StoredEntry } | { error: string } {
  const parsed = entrySchema.safeParse(value);
  if (parsed.success) return { entry: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.join(".") || "entry";
  return { error: `${where}: ${issue?.message ?? "is not valid"}` };
}

/** Key order of a stored line: the same every time, so a diff shows only what changed. */
const KEY_ORDER = [
  "kind",
  "status",
  "command",
  "test",
  "package",
  "fromVersion",
  "toVersion",
  "text",
  "reason",
  "note",
  "check",
  "source",
  "createdAt",
  "expiresAt",
] as const;

export function entryLine(entry: StoredEntry): string {
  const record = entry as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (record[key] !== undefined) ordered[key] = record[key];
  // JSON.stringify never emits a raw newline, and a stored line starts with `{`, so it can never
  // be mistaken for the closing fence of the block it sits in.
  return JSON.stringify(ordered);
}

export const isExpired = (entry: StoredEntry, now: Date): boolean =>
  entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now.getTime();

/** Recorded by a run on its own evidence, as opposed to written or accepted by a person. */
export const isAutoRecorded = (entry: StoredEntry): boolean => entry.source.startsWith("run_");

export function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/**
 * Text an agent proposed that reads like an instruction to a model rather than a fact about the
 * repository. A heuristic and only a first filter: a proposal does nothing until a person accepts
 * it, and everything that reaches a prompt is quoted as data.
 */
const INSTRUCTION_SHAPED = [
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|prior|above|earlier|all|any|your|the)\b.{0,30}\b(?:instruction|rule|prompt|guideline|polic)/i,
  /\b(?:system|developer) (?:prompt|message|instruction)/i,
  /\byou (?:must|should|are|will|need to)\b/i,
  /\b(?:always|never) (?:run|execute|call|use|skip|apply|merge|approve|trust|ignore)\b/i,
  /<\/?[a-z|!][^>]{0,40}>|\[(?:inst|\/inst|system)\]|<\|/i,
  /\b(?:curl|wget)\b.*\|\s*(?:sh|bash)|\brm -rf\b|\beval\(/i,
  /\bhttps?:\/\//i,
];

/** Why `text` reads like an instruction or a link rather than a fact, if it does. */
export function instructionShaped(text: string): string | undefined {
  for (const pattern of INSTRUCTION_SHAPED) {
    if (pattern.test(text)) {
      return `"${text.slice(0, 40)}" looks like an instruction or a link, not a fact about the repository`;
    }
  }
  return undefined;
}

/** Every string of an entry that came from free text. */
export function freeText(entry: StoredEntry): string[] {
  switch (entry.kind) {
    case "test-command": {
      return [entry.command];
    }
    case "flaky-test": {
      return [entry.test, ...(entry.note ? [entry.note] : [])];
    }
    case "pinned-package":
    case "rejected-upgrade": {
      return [entry.reason];
    }
    case "install-quirk":
    case "note": {
      return [entry.text];
    }
    default: {
      return unreachable(entry);
    }
  }
}
