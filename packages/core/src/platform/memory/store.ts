/**
 * Reading and writing `.autoremediator/memory.md`. Writes are serialized with a lock directory and
 * replace the file atomically, so two terminals or CI jobs never lose each other's entries and no
 * reader sees half a file. Everything that changes the file is one of five operations; none can
 * touch the prose a person wrote.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  addDays,
  freeText,
  instructionShaped,
  isExpired,
  MEMORY_LIMITS,
  type MemoryEntry,
  type MemoryKind,
  type MemoryStatus,
  parseEntry,
  type StoredEntry,
} from "./entries.js";
import {
  acceptInDocument,
  addToDocument,
  entriesOf,
  MemoryFileError,
  type MemoryDocument,
  parseDocument,
  pruneDocument,
  removeFromDocument,
  serializeDocument,
} from "./format.js";
import { MEMORY_PATH } from "./path.js";

export { MEMORY_PATH };

const LOCK_DIR = ".autoremediator/locks/memory.lock";
const STALE_LOCK_MS = 30_000;
/** A memory file past this is refused outright rather than read. */
const MAX_FILE_BYTES = 1024 * 1024;

export const memoryPathOf = (cwd: string): string => join(cwd, MEMORY_PATH);

export interface MemoryState {
  path: string;
  exists: boolean;
  doc: MemoryDocument;
  /** Every valid entry, whatever its state. */
  entries: MemoryEntry[];
  /** Lines of the block that are not valid entries, and what is wrong with the block. */
  problems: string[];
}

/** The file as it is now, or an empty document when there is none. Throws when it cannot be read safely. */
export function readMemory(cwd: string): MemoryState {
  const path = memoryPathOf(cwd);
  if (!existsSync(path) && !isSymlink(path)) {
    const doc = parseDocument("");
    return { path, exists: false, doc, entries: [], problems: [] };
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new MemoryFileError(`${path} must be a regular file, not a link or a directory.`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new MemoryFileError(
      `${path} is ${info.size} bytes; the limit is ${MAX_FILE_BYTES}. Edit it down by hand.`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new MemoryFileError(`${path} cannot be read: ${(cause as Error).message}`, { cause });
  }
  const doc = parseDocument(text);
  return { path, exists: true, doc, entries: entriesOf(doc), problems: doc.problems };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Entries by what they currently do. */
export interface MemoryView {
  /** Active and not expired: these change behavior. */
  active: MemoryEntry[];
  /** Waiting for a person; these change nothing. */
  proposed: MemoryEntry[];
  /** Past their expiry; these change nothing until pruned. */
  expired: MemoryEntry[];
}

export function viewEntries(entries: readonly MemoryEntry[], now: Date): MemoryView {
  const view: MemoryView = { active: [], proposed: [], expired: [] };
  for (const entry of entries) {
    if (isExpired(entry, now)) view.expired.push(entry);
    else if (entry.status === "active") view.active.push(entry);
    else view.proposed.push(entry);
  }
  return view;
}

// ---------------------------------------------------------------------------
// Locking and writing
// ---------------------------------------------------------------------------

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function acquire(cwd: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lock = join(cwd, LOCK_DIR);
  await mkdir(dirname(lock), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner"), String(process.pid), "utf8");
      return async () => {
        await rm(lock, { recursive: true, force: true });
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_MS) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // released between our attempt and the check
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new MemoryFileError(`Timed out waiting for the memory lock at ${lock}.`, { cause });
      }
      await sleep(25);
    }
  }
}

/** Run a change against the file as it is on disk now, under the lock; write only if it changed. */
async function change<T>(
  cwd: string,
  edit: (doc: MemoryDocument) => { doc: MemoryDocument; result: T },
): Promise<T> {
  const release = await acquire(cwd, 10_000);
  try {
    const state = readMemory(cwd);
    const { doc, result } = edit(state.doc);
    // The edits return the document they were given when they changed nothing.
    if (doc !== state.doc) {
      const text = serializeDocument(doc);
      // Prose that leaves a code fence open swallows the block: what we write would never be read back.
      if (entriesOf(parseDocument(text)).length !== entriesOf(doc).length) {
        throw new MemoryFileError(
          `${state.path} has a code fence that is never closed above the memory block, so entries cannot be read back. Close it (or delete the file's block) and try again.`,
        );
      }
      mkdirSync(dirname(state.path), { recursive: true });
      const temp = `${state.path}.tmp-${process.pid}`;
      writeFileSync(temp, text, "utf8");
      renameSync(temp, state.path);
    }
    return result;
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// The five operations
// ---------------------------------------------------------------------------

type Distributive<T> = T extends unknown
  ? Omit<T, "createdAt" | "status" | "source" | "expiresAt">
  : never;

/** What a caller supplies for a new entry; the rest is filled in. */
export type NewMemoryEntry = Distributive<StoredEntry> & {
  /** Who or what is the source. Default `human`. */
  source?: string;
  /** Default `active`; an agent's proposals are `proposed`. */
  status?: MemoryStatus;
  /** When the entry stops counting (ISO 8601). */
  expiresAt?: string;
  /** Alternative to `expiresAt`: days from now. */
  expiresInDays?: number;
};

export interface AddMemoryOptions {
  now?: Date;
  /** Refuse text that reads like an instruction (set for anything an agent wrote). */
  untrusted?: boolean;
}

export interface AddMemoryResult {
  entry: MemoryEntry;
  /** False when the same fact was already in the file. */
  created: boolean;
  /** Entries dropped to make room. */
  evicted: string[];
  path: string;
}

/** Validate a new entry the way the file does, without writing it. */
export function buildEntry(input: NewMemoryEntry, now: Date, untrusted = false): StoredEntry {
  const { expiresInDays, ...rest } = input;
  if (
    expiresInDays !== undefined &&
    (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 3650)
  ) {
    throw new MemoryFileError("expiresInDays must be a number from 1 to 3650.");
  }
  const draft = {
    ...rest,
    status: input.status ?? (untrusted ? "proposed" : "active"),
    source: input.source ?? (untrusted ? "agent" : "human"),
    createdAt: now.toISOString(),
    ...(expiresInDays === undefined ? {} : { expiresAt: addDays(now, expiresInDays) }),
  };
  const parsed = parseEntry(draft);
  if ("error" in parsed) throw new MemoryFileError(`Not a valid memory entry: ${parsed.error}`);
  if (untrusted) {
    for (const text of freeText(parsed.entry)) {
      const why = instructionShaped(text);
      if (why) throw new MemoryFileError(`Refused: ${why}.`);
    }
    if (parsed.entry.status !== "proposed") {
      throw new MemoryFileError("An agent's entry can only be proposed; a person accepts it.");
    }
  }
  return parsed.entry;
}

export async function addMemory(
  cwd: string,
  input: NewMemoryEntry,
  options: AddMemoryOptions = {},
): Promise<AddMemoryResult> {
  const now = options.now ?? new Date();
  const stored = buildEntry(input, now, options.untrusted);
  return change(cwd, (doc) => {
    const added = addToDocument(doc, stored, now);
    return {
      doc: added.doc,
      result: {
        entry: added.entry,
        created: added.created,
        evicted: added.evicted,
        path: memoryPathOf(cwd),
      },
    };
  });
}

export async function removeMemory(cwd: string, id: string): Promise<MemoryEntry> {
  return change(cwd, (doc) => {
    const { doc: next, removed } = removeFromDocument(doc, id);
    if (!removed)
      throw new MemoryFileError(`No memory entry ${id}. See \`autoremediator memory list\`.`);
    return { doc: next, result: removed };
  });
}

export async function acceptMemory(
  cwd: string,
  id: string,
): Promise<{ entry: MemoryEntry; alreadyActive: boolean }> {
  return change(cwd, (doc) => {
    const { doc: next, accepted, alreadyActive } = acceptInDocument(doc, id);
    if (!accepted)
      throw new MemoryFileError(`No memory entry ${id}. See \`autoremediator memory list\`.`);
    return { doc: next, result: { entry: accepted, alreadyActive } };
  });
}

export async function pruneMemory(cwd: string, now: Date = new Date()): Promise<MemoryEntry[]> {
  return change(cwd, (doc) => {
    const { doc: next, removed } = pruneDocument(doc, now);
    return { doc: next, result: removed };
  });
}

/** The kinds an entry list contains, for summaries. */
export function countByKind(entries: readonly MemoryEntry[]): Record<MemoryKind, number> {
  const counts: Record<MemoryKind, number> = {
    "test-command": 0,
    "flaky-test": 0,
    "pinned-package": 0,
    "rejected-upgrade": 0,
    "install-quirk": 0,
    note: 0,
  };
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}

export { MEMORY_LIMITS };
