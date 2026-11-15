/**
 * The track record: `.autoremediator/track-record.json`, a small file meant to be committed.
 *
 * It holds one summary per outcome (never command output or secrets), in order, with the run id each
 * came from, so a person can read the history in a diff and a run's own ledger holds the detail.
 * Events are only ever appended. Concurrent writers (two CI jobs, two terminals) are serialized
 * with a lock directory and the file is replaced atomically, so no reader sees a partial file and
 * no event is lost or numbered twice.
 */
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
  })
  .strict();

const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    events: z.array(eventSchema),
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
  return { schemaVersion: 1, events };
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
  return `{\n  "schemaVersion": ${record.schemaVersion},\n  "events": [${
    lines.length > 0 ? `\n${lines.join(",\n")}\n  ` : ""
  }]\n}\n`;
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
    const added: TrackEvent[] = events.map((event, index) => ({
      seq: record.events.length + index + 1,
      at: event.at ?? stamp,
      type: event.type,
      runId: event.runId,
      ...(event.itemId ? { itemId: event.itemId } : {}),
      cveIds: event.cveIds,
      packages: event.packages,
      coverage: event.coverage,
      detail: oneLine(event.detail),
    }));
    const next: TrackRecord = { schemaVersion: 1, events: [...record.events, ...added] };

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
