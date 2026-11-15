/**
 * The memory file: Markdown that people may edit freely, with one fenced block of entries.
 *
 *     ```autoremediator-memory
 *     {"kind":"pinned-package","status":"active","package":"left-pad", ...}
 *     ```
 *
 * Everything outside the block is the person's own prose and is never touched. Inside it, each line
 * is one JSON entry; lines that are not entries (blank, `#` comments, mistakes) are kept exactly
 * as they are, and a line is only rewritten when its entry is changed. A document therefore
 * round-trips: `serialize(parse(text)) === text`, and an edit changes only the lines it is about.
 */
import {
  entryId,
  entryLine,
  isAutoRecorded,
  isExpired,
  MEMORY_LIMITS,
  type MemoryEntry,
  parseEntry,
  type StoredEntry,
} from "./entries.js";

export const FENCE_INFO = "autoremediator-memory";

/** The file as first written; the prose is a person's to replace. */
export const TEMPLATE_HEAD = `# Autoremediator memory

What Autoremediator has learned about this repository: how its tests run, which tests are flaky,
packages that must stay pinned, upgrades that were tried and rejected, install quirks. It is read at
the start of every run and shown to agents as data, never as instructions.

Write whatever you like outside the block below; it is yours and is never changed. Inside the block
each line is one entry. Add one with \`autoremediator memory add\`, or edit a line by hand: lines
that are not valid entries are reported by \`autoremediator memory list\` and ignored. Delete an entry
by deleting its line. \`status: "proposed"\` entries came from an agent and do nothing until you
accept them with \`autoremediator memory accept <id>\`.
`;

/** What one line of the block is. */
export type BlockLine =
  | { type: "entry"; raw: string; entry: MemoryEntry }
  /** Blank, a `#` comment, or something that is not an entry. Kept as it is. */
  | { type: "other"; raw: string; problem?: string };

export interface MemoryDocument {
  /** Everything up to and including the opening fence line (with the line break). */
  head: string;
  lines: BlockLine[];
  /** The closing fence line and everything after it. */
  tail: string;
  /** The line break the file uses. */
  eol: "\n" | "\r\n";
  /** The file has a block (a new one is added on the first write when it has not). */
  hasBlock: boolean;
  /** Fence trouble that makes writing unsafe, such as a block that never closes. */
  broken?: string;
  /** The text as read, kept when `broken` so it can still be reproduced exactly. */
  original?: string;
  /** Problems with lines in the block, for `memory list`. */
  problems: string[];
}

const OPEN = new RegExp(`^(\`{3,})${FENCE_INFO}[ \\t]*\\r?$`);
/** A fence line naming the memory block, however it is indented or fenced, or the template's heading. */
const MARKER = new RegExp(
  `^[ \\t]*(?:(?:\`{3,}|~{3,})[ \\t]*${FENCE_INFO}\\b|#{1,6}[ \\t]+Autoremediator memory[ \\t]*\\r?$)`,
  "im",
);
const ANY_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** Locate the first `autoremediator-memory` fence that is not inside some other fenced block. */
function findBlock(rows: string[]): { open: number; close: number | undefined } | undefined {
  let outer: { char: string; length: number } | undefined;
  for (const [index, row] of rows.entries()) {
    if (outer) {
      const closer = ANY_OPEN.exec(row);
      if (
        closer &&
        closer[2]![0] === outer.char &&
        closer[2]!.length >= outer.length &&
        closer[3]!.trim() === ""
      ) {
        outer = undefined;
      }
      continue;
    }
    const ours = OPEN.exec(row);
    if (ours) {
      const length = ours[1]!.length;
      const closeAt = rows.findIndex(
        (candidate, at) => at > index && new RegExp(`^\`{${length},}[ \\t]*\\r?$`).test(candidate),
      );
      return { open: index, close: closeAt === -1 ? undefined : closeAt };
    }
    const opener = ANY_OPEN.exec(row);
    // CommonMark: the info string of a backtick fence cannot contain a backtick, so a prose line
    // like "```npm test``` runs tests" is inline code, not the start of a fenced block.
    if (opener && !(opener[2]![0] === "`" && opener[3]!.includes("`"))) outer = { char: opener[2]![0]!, length: opener[2]!.length };
  }
  return undefined;
}

function classify(
  raw: string,
  seen: Map<string, number>,
  problems: string[],
  at: number,
): BlockLine {
  const text = raw.replace(/\r$/, "");
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return { type: "other", raw };
  if (!trimmed.startsWith("{")) {
    const problem = `line ${at}: not an entry (expected a JSON object)`;
    problems.push(problem);
    return { type: "other", raw, problem };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    const problem = `line ${at}: not valid JSON (${(error as Error).message.slice(0, 60)})`;
    problems.push(problem);
    return { type: "other", raw, problem };
  }
  // A stored id is ignored: it is derived, so an edit cannot make two entries disagree.
  const { id: _id, ...withoutId } =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : { id: undefined };
  const parsed = parseEntry(withoutId);
  if ("error" in parsed) {
    const problem = `line ${at}: ${parsed.error}`;
    problems.push(problem);
    return { type: "other", raw, problem };
  }
  const entry: MemoryEntry = { ...parsed.entry, id: entryId(parsed.entry) };
  const first = seen.get(entry.id);
  if (first !== undefined) {
    const problem = `line ${at}: duplicates ${entry.id} on line ${first}; ignored`;
    problems.push(problem);
    return { type: "other", raw, problem };
  }
  seen.set(entry.id, at);
  if (seen.size > MEMORY_LIMITS.maxEntries) {
    seen.delete(entry.id);
    const problem = `line ${at}: more than ${MEMORY_LIMITS.maxEntries} entries; this one is ignored`;
    problems.push(problem);
    return { type: "other", raw, problem };
  }
  return { type: "entry", raw, entry };
}

export function parseDocument(text: string): MemoryDocument {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const rows = text.split("\n");
  const located = findBlock(rows);
  if (!located) {
    // The file looks like it should have a block, but none can be read (swallowed by another
    // fence, indented, or deleted): say so rather than showing an empty memory.
    const problems = MARKER.test(text)
      ? [
          `the file mentions the \`${FENCE_INFO}\` fence or heading but has no readable block; entries (including pins) are not being used. Check that the \`\`\`${FENCE_INFO} line starts at the beginning of a line and is not inside another fenced block.`,
        ]
      : [];
    return { head: text, lines: [], tail: "", eol, hasBlock: false, problems };
  }
  const bodyEnd = located.close ?? rows.length;
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const lines = rows
    .slice(located.open + 1, bodyEnd)
    .map((raw, index) => classify(raw, seen, problems, located.open + 2 + index));
  const head = `${rows.slice(0, located.open + 1).join("\n")}\n`;
  const tail = located.close === undefined ? "" : rows.slice(located.close).join("\n");
  const broken =
    located.close === undefined
      ? `the \`${FENCE_INFO}\` block is never closed; add a closing \`\`\` line`
      : undefined;
  if (broken) problems.push(broken);
  // Without a closing fence the last row is the file's final (possibly empty) line, not an entry.
  if (located.close === undefined && lines.at(-1)?.raw === "") lines.pop();
  return {
    head,
    lines,
    tail,
    eol,
    hasBlock: true,
    ...(broken ? { broken, original: text } : {}),
    problems,
  };
}

export function serializeDocument(doc: MemoryDocument): string {
  if (!doc.hasBlock) return doc.head;
  if (doc.broken && doc.original !== undefined) return doc.original;
  return `${doc.head}${doc.lines.map((line) => `${line.raw}\n`).join("")}${doc.tail}`;
}

export const entriesOf = (doc: MemoryDocument): MemoryEntry[] =>
  doc.lines.flatMap((line) => (line.type === "entry" ? [line.entry] : []));

const byteSize = (doc: MemoryDocument): number =>
  doc.lines.reduce(
    (total, line) => total + (line.type === "entry" ? Buffer.byteLength(line.raw) + 1 : 0),
    0,
  );

export class MemoryFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryFileError";
  }
}

export class MemoryFullError extends MemoryFileError {
  constructor(message: string) {
    super(message);
    this.name = "MemoryFullError";
  }
}

function assertWritable(doc: MemoryDocument): void {
  if (doc.broken) {
    throw new MemoryFileError(`Cannot change the memory file: ${doc.broken}.`);
  }
}

/** The document with its first block created, when the file has none. */
function withBlock(doc: MemoryDocument): MemoryDocument {
  if (doc.hasBlock) return doc;
  const eol = doc.eol;
  const prose = doc.head === "" ? TEMPLATE_HEAD.replaceAll("\n", eol) : doc.head;
  const separated =
    prose === "" || prose.endsWith(`${eol}${eol}`)
      ? prose
      : `${prose}${prose.endsWith("\n") ? "" : eol}${eol}`;
  return {
    ...doc,
    head: `${separated}\`\`\`${FENCE_INFO}${eol}`,
    tail: `\`\`\`${eol}`,
    hasBlock: true,
    lines: [],
  };
}

const withEol = (raw: string, doc: MemoryDocument): string =>
  doc.eol === "\r\n" ? `${raw}\r` : raw;

const oldestFirst = (entries: MemoryEntry[]): MemoryEntry[] =>
  entries.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

export interface AddResult {
  doc: MemoryDocument;
  entry: MemoryEntry;
  created: boolean;
  /** Ids dropped to make room. */
  evicted: string[];
}

/**
 * Add an entry. The same fact twice is not added twice. When the file is at its cap, expired
 * entries go first (oldest first); a run's own auto-recorded entries may then make room by
 * replacing the oldest auto-recorded ones. A person's entries are never evicted.
 */
export function addToDocument(doc: MemoryDocument, stored: StoredEntry, now: Date): AddResult {
  assertWritable(doc);
  const entry: MemoryEntry = { ...stored, id: entryId(stored) };
  const existing = entriesOf(doc).find((candidate) => candidate.id === entry.id);
  if (existing) return { doc, entry: existing, created: false, evicted: [] };

  if (entry.status === "proposed") {
    const waiting = entriesOf(doc).filter((candidate) => candidate.status === "proposed").length;
    if (waiting >= MEMORY_LIMITS.maxProposed) {
      throw new MemoryFullError(
        `There are already ${waiting} proposed entries; accept or remove some first.`,
      );
    }
  }

  let next: MemoryDocument = { ...withBlock(doc) };
  const evicted: string[] = [];
  const raw = withEol(entryLine(stored), next);
  const fits = (candidate: MemoryDocument): boolean =>
    entriesOf(candidate).length < MEMORY_LIMITS.maxEntries &&
    byteSize(candidate) + Buffer.byteLength(raw) + 1 <= MEMORY_LIMITS.maxBytes;

  const evict = (victims: MemoryEntry[]): void => {
    for (const victim of victims) {
      if (fits(next)) return;
      next.lines = next.lines.filter(
        (line) => line.type !== "entry" || line.entry.id !== victim.id,
      );
      evicted.push(victim.id);
    }
  };
  if (!fits(next))
    evict(oldestFirst(entriesOf(next).filter((candidate) => isExpired(candidate, now))));
  if (!fits(next) && isAutoRecorded(stored)) {
    evict(oldestFirst(entriesOf(next).filter((candidate) => isAutoRecorded(candidate))));
  }
  if (!fits(next)) {
    throw new MemoryFullError(
      `The memory file is full (${entriesOf(next).length} entries, ${MEMORY_LIMITS.maxEntries} allowed). Remove some with \`autoremediator memory remove <id>\` or \`memory prune\`.`,
    );
  }

  // After the last entry, so blank lines and comments the person left at the end stay at the end.
  const lastEntry = next.lines.findLastIndex((line) => line.type === "entry");
  const line: BlockLine = { type: "entry", raw, entry };
  const lines =
    lastEntry === -1 ? [...next.lines, line] : next.lines.toSpliced(lastEntry + 1, 0, line);
  next = { ...next, lines };
  return { doc: next, entry, created: true, evicted };
}

export function removeFromDocument(
  doc: MemoryDocument,
  id: string,
): { doc: MemoryDocument; removed: MemoryEntry | undefined } {
  const removed = entriesOf(doc).find((entry) => entry.id === id);
  if (!removed) return { doc, removed };
  assertWritable(doc);
  return {
    doc: {
      ...doc,
      lines: doc.lines.filter((line) => line.type !== "entry" || line.entry.id !== id),
    },
    removed,
  };
}

/** Make a proposed entry active, with a new expiry only when the caller gives one. */
export function acceptInDocument(
  doc: MemoryDocument,
  id: string,
): { doc: MemoryDocument; accepted: MemoryEntry | undefined; alreadyActive: boolean } {
  const current = entriesOf(doc).find((entry) => entry.id === id);
  if (!current) return { doc, accepted: undefined, alreadyActive: false };
  if (current.status === "active") return { doc, accepted: current, alreadyActive: true };
  assertWritable(doc);
  const { id: _id, ...stored } = current;
  const updated = { ...stored, status: "active" as const } satisfies StoredEntry;
  const accepted: MemoryEntry = { ...updated, id };
  return {
    doc: {
      ...doc,
      lines: doc.lines.map((line) =>
        line.type === "entry" && line.entry.id === id
          ? { type: "entry", raw: withEol(entryLine(updated), doc), entry: accepted }
          : line,
      ),
    },
    accepted,
    alreadyActive: false,
  };
}

/** Remove expired entries. */
export function pruneDocument(
  doc: MemoryDocument,
  now: Date,
): { doc: MemoryDocument; removed: MemoryEntry[] } {
  const removed = entriesOf(doc).filter((entry) => isExpired(entry, now));
  if (removed.length === 0) return { doc, removed };
  assertWritable(doc);
  const ids = new Set(removed.map((entry) => entry.id));
  return {
    doc: {
      ...doc,
      lines: doc.lines.filter((line) => line.type !== "entry" || !ids.has(line.entry.id)),
    },
    removed,
  };
}
