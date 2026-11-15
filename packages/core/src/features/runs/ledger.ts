import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { sha256 } from "../../shared/hash.js";
import { canonicalJson } from "./hash.js";

export interface StepEvent {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
  /** Hash of the previous event (zeros for the first). */
  prevHash: string;
  /** Hash over `prevHash` and this event's content: editing or removing any line breaks the chain. */
  hash: string;
}

export type LedgerCheck = { ok: true } | { ok: false; seq: number; reason: string };

const GENESIS = "0".repeat(64);

function hashEvent(prevHash: string, event: Omit<StepEvent, "prevHash" | "hash">): string {
  return sha256(
    prevHash + canonicalJson({ seq: event.seq, at: event.at, type: event.type, data: event.data }),
  );
}

/** Append-only, hash-chained record of what a run did (`steps.jsonl`). */
export class Ledger {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): StepEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as StepEvent);
  }

  append(type: string, data: Record<string, unknown> = {}): StepEvent {
    // Always continue from what is on disk: other holders of this file (one per code path that
    // asked the store for the ledger) may have appended since.
    const tail = this.read().at(-1);
    const last = tail ? { seq: tail.seq, hash: tail.hash } : { seq: 0, hash: GENESIS };
    const base = { seq: last.seq + 1, at: new Date().toISOString(), type, data };
    const event: StepEvent = { ...base, prevHash: last.hash, hash: hashEvent(last.hash, base) };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  verify(): LedgerCheck {
    let prevHash = GENESIS;
    let expectedSeq = 1;
    let events: StepEvent[];
    try {
      events = this.read();
    } catch {
      return { ok: false, seq: expectedSeq, reason: "unreadable line" };
    }
    for (const event of events) {
      if (event.seq !== expectedSeq) {
        return {
          ok: false,
          seq: expectedSeq,
          reason: `expected event ${expectedSeq}, found ${event.seq}`,
        };
      }
      if (event.prevHash !== prevHash) {
        return { ok: false, seq: event.seq, reason: "chain broken: previous hash does not match" };
      }
      if (event.hash !== hashEvent(prevHash, event)) {
        return { ok: false, seq: event.seq, reason: "event content does not match its hash" };
      }
      prevHash = event.hash;
      expectedSeq += 1;
    }
    return { ok: true };
  }
}
