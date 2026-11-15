/**
 * The track record: `.autoremediator/track-record.json`, a small file meant to be committed.
 *
 * It holds one summary per outcome (never command output or secrets), in order, with the run id each
 * came from, so a person can read the history in a diff and a run's own ledger holds the detail.
 * Events are only ever appended. Concurrent writers (two CI jobs, two terminals) are serialized
 * with a lock directory and the file is replaced atomically, so no reader sees a partial file and
 * no event is lost or numbered twice.
 *
 * Each event carries the hash of the one before it and the record carries the hash of the last, so
 * editing, removing or reordering an event is detected and the level falls to L0. This is
 * tamper-evidence for accidents and casual edits, not authentication: someone with write access who
 * rebuilds the whole chain cannot be told apart from a genuine record. Review in version control is
 * the real control.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { TRACK_RECORD_PATH } from "../platform/track-record-path.js";
import {
  type NewTrackEvent,
  TRACK_EVENT_TYPES,
  type TrackEvent,
  type TrackRecord,
} from "./types.js";

export { TRACK_RECORD_PATH };
const LOCK_DIR = ".autoremediator/locks/track-record.lock";

const MAX_DETAIL = 240;

const HASH = /^[0-9a-f]{64}$/;
/** The `prev` of the first event in a chain. */
const GENESIS = "0".repeat(64);

/** JSON with object keys sorted at every level, so the same event always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The hash that the event after `event` carries as its `prev`. */
const hashOf = (event: TrackEvent): string =>
  createHash("sha256").update(canonical(event)).digest("hex");

/** Give every event the hash of the one before it. */
function chained(events: readonly TrackEvent[]): TrackEvent[] {
  const out: TrackEvent[] = [];
  for (const event of events) {
    out.push({ ...event, prev: out.length === 0 ? GENESIS : hashOf(out.at(-1)!) });
  }
  return out;
}

const eventSchema = z
  .object({
    seq: z.number().int().min(1),
    at: z.iso.datetime({ offset: true }),
    type: z.enum(TRACK_EVENT_TYPES),
    runId: z.string().regex(/^run_[0-9a-z]{20}$/),
    itemId: z.string().optional(),
    cveIds: z.array(z.string()),
    packages: z.array(z.string()),
    coverage: z.object({ tests: z.boolean(), typecheck: z.boolean() }).strict(),
    detail: z.string().max(MAX_DETAIL),
    prev: z.string().regex(HASH).optional(),
  })
  .strict();

const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    events: z.array(eventSchema),
    head: z.string().regex(HASH).optional(),
  })
  .strict();

export const recordPathOf = (cwd: string): string => join(cwd, TRACK_RECORD_PATH);

/** A record that cannot be trusted: reading it fails loudly instead of defaulting to "no history". */
export class TrackRecordError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TrackRecordError";
  }
}

function parseRecord(text: string, path: string): TrackRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new TrackRecordError(`Track record ${path} is not valid JSON.`, { cause });
  }
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") || "(root)";
    throw new TrackRecordError(
      `Track record ${path} is invalid at ${where}: ${parsed.error.issues[0]?.message}.`,
    );
  }
  const events = parsed.data.events as TrackEvent[];
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1) {
      throw new TrackRecordError(
        `Track record ${path}: expected event ${index + 1} but found ${event.seq}; events must be consecutive and never removed.`,
      );
    }
  }
  const hashed = events.filter((event) => event.prev !== undefined).length;
  // A record from before hashes existed has none and is accepted as it is; it is chained on the next append.
  if (hashed === 0 && parsed.data.head === undefined) return { schemaVersion: 1, events };
  if (hashed !== events.length || (events.length > 0 && parsed.data.head === undefined)) {
    throw new TrackRecordError(
      `Track record ${path}: some events carry a hash and some do not (or the head hash is missing); once a record is chained every event must be. Restore the file from version control, or review and remove it deliberately.`,
    );
  }
  for (const [index, event] of events.entries()) {
    const expected = index === 0 ? GENESIS : hashOf(events[index - 1]!);
    if (event.prev !== expected) {
      throw new TrackRecordError(
        `Track record ${path}: the hash chain is broken at event ${event.seq}: an event before it was edited, removed or reordered. Review the file's history in version control and restore it; the level stays L0 until then.`,
      );
    }
  }
  if (events.length > 0 && parsed.data.head !== hashOf(events.at(-1)!)) {
    throw new TrackRecordError(
      `Track record ${path}: the hash chain is broken at the latest event (${events.at(-1)!.seq}): it was edited, or events were removed after it. Review the file's history in version control and restore it; the level stays L0 until then.`,
    );
  }
  return { schemaVersion: 1, events, ...(parsed.data.head ? { head: parsed.data.head } : {}) };
}

/** The record, or an empty one when none exists yet. Throws `TrackRecordError` when it is damaged. */
export function readTrackRecord(cwd: string): TrackRecord {
  const path = recordPathOf(cwd);
  if (!existsSync(path)) return { schemaVersion: 1, events: [] };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new TrackRecordError(`Track record ${path} cannot be read: ${(cause as Error).message}`, {
      cause,
    });
  }
  return parseRecord(text, path);
}

/** One event per line, so appending one shows up as one added line in a diff. */
export function serializeRecord(record: TrackRecord): string {
  const lines = record.events.map((event) => `    ${JSON.stringify(event)}`);
  const last = record.events.at(-1);
  const head = last?.prev === undefined ? "" : `,\n  "head": "${record.head ?? hashOf(last)}"`;
  return `{\n  "schemaVersion": ${record.schemaVersion},\n  "events": [${
    lines.length > 0 ? `\n${lines.join(",\n")}\n  ` : ""
  }]${head}\n}\n`;
}

const oneLine = (text: string): string => {
  const line = (text.split("\n")[0] ?? "").replaceAll(/\s+/g, " ").trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
};

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** A lock directory older than this belongs to a process that died. */
const STALE_LOCK_MS = 30_000;

async function acquire(cwd: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lock = join(cwd, LOCK_DIR);
  await mkdir(join(cwd, ".autoremediator", "locks"), { recursive: true });
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
        // The holder released it between our attempt and the check: try again straight away.
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for the track record lock at ${lock}.`, { cause });
      }
      await sleep(25);
    }
  }
}

/**
 * Append events to the record. Events get their sequence numbers and timestamps here, under the
 * lock, from the record as it is on disk at that moment. Refuses to touch a damaged record.
 */
export async function appendTrackEvents(
  cwd: string,
  events: readonly NewTrackEvent[],
  options: { timeoutMs?: number; now?: () => Date } = {},
): Promise<TrackEvent[]> {
  if (events.length === 0) return [];
  const release = await acquire(cwd, options.timeoutMs ?? 10_000);
  try {
    const record = readTrackRecord(cwd);
    const stamp = (options.now ?? (() => new Date()))().toISOString();
    // A record from before hashes existed is chained now, once; every event keeps its content.
    const existing = chained(record.events);
    const added: TrackEvent[] = [];
    for (const [index, event] of events.entries()) {
      const before = added.at(-1) ?? existing.at(-1);
      added.push({
        seq: record.events.length + index + 1,
        at: event.at ?? stamp,
        type: event.type,
        runId: event.runId,
        ...(event.itemId ? { itemId: event.itemId } : {}),
        cveIds: event.cveIds,
        packages: event.packages,
        coverage: event.coverage,
        detail: oneLine(event.detail),
        prev: before ? hashOf(before) : GENESIS,
      });
    }
    const next: TrackRecord = { schemaVersion: 1, events: [...existing, ...added] };

    // Validate what is about to be written, so a bad event can never poison the file.
    parseRecord(serializeRecord(next), recordPathOf(cwd));

    mkdirSync(join(cwd, ".autoremediator"), { recursive: true });
    const target = recordPathOf(cwd);
    const temp = `${target}.tmp-${process.pid}`;
    writeFileSync(temp, serializeRecord(next), "utf8");
    renameSync(temp, target);
    return added;
  } finally {
    await release();
  }
}
