import { readFileSync } from "node:fs";

import {
  TRACE_SCHEMA,
  type ModuleFormat,
  type TracePackage,
  type TraceRecord,
  type TraceReport,
} from "./types.js";

const FORMATS: readonly ModuleFormat[] = ["cjs", "esm"];

function isTraceRecord(value: unknown): value is TraceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { v?: unknown; t?: unknown };
  return record.v === 1 && (record.t === "proc" || record.t === "pkg" || record.t === "calls");
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Parse JSONL text into records; lines that are not trace records are counted, not fatal. */
export function parseTraceLines(text: string): { records: TraceRecord[]; skipped: number } {
  const records: TraceRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isTraceRecord(parsed)) records.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

interface Accumulator {
  name: string;
  version: string;
  entries: Set<string>;
  dependents: Set<string>;
  formats: Set<ModuleFormat>;
  calls: Map<string, number>;
  wrapped: Set<string>;
  unwrapped: Map<string, string>;
}

/**
 * Merge records from any number of processes into one report. Folding is order-independent: sets
 * are unioned and call counts (written as deltas) are summed, so appending from several processes
 * to one file, or folding two files together, gives the same result.
 */
export function foldTraceRecords(
  records: readonly TraceRecord[],
  extras: { skipped?: number; command?: TraceReport["command"]; createdAt?: string } = {},
): TraceReport {
  const byPackage = new Map<string, Accumulator>();
  let processes = 0;
  let partialEsm = false;
  let callsEnabled = false;
  const watched = new Set<string>();

  const accumulator = (name: string, version: string): Accumulator => {
    const key = `${name}@${version}`;
    let found = byPackage.get(key);
    if (!found) {
      found = {
        name,
        version,
        entries: new Set(),
        dependents: new Set(),
        formats: new Set(),
        calls: new Map(),
        wrapped: new Set(),
        unwrapped: new Map(),
      };
      byPackage.set(key, found);
    }
    return found;
  };

  for (const record of records) {
    if (record.t === "proc") {
      processes++;
      if (record.observes === "cjs-only") partialEsm = true;
      if (record.calls) {
        callsEnabled = true;
        for (const name of stringsOf(record.listed)) watched.add(name);
      }
    } else if (record.t === "pkg") {
      const found = accumulator(record.name, record.version);
      for (const entry of stringsOf(record.entries)) found.entries.add(entry);
      for (const dependent of stringsOf(record.dependents)) found.dependents.add(dependent);
      for (const format of stringsOf(record.formats)) {
        if ((FORMATS as readonly string[]).includes(format))
          found.formats.add(format as ModuleFormat);
      }
    } else {
      const found = accumulator(record.name, record.version);
      for (const [name, count] of Object.entries(record.calls ?? {})) {
        if (typeof count === "number") found.calls.set(name, (found.calls.get(name) ?? 0) + count);
      }
      for (const name of stringsOf(record.wrapped)) found.wrapped.add(name);
      for (const [name, reason] of Object.entries(record.unwrapped ?? {})) {
        if (typeof reason === "string" && !found.unwrapped.has(name))
          found.unwrapped.set(name, reason);
      }
    }
  }

  const packages: TracePackage[] = [...byPackage.values()]
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map((found) => {
      const result: TracePackage = {
        name: found.name,
        version: found.version,
        entries: [...found.entries].toSorted((a, b) => a.localeCompare(b)),
        dependents: [...found.dependents].toSorted((a, b) => a.localeCompare(b)),
        formats: [...found.formats].toSorted((a, b) => a.localeCompare(b)),
      };
      if (found.wrapped.size > 0 || found.unwrapped.size > 0 || found.calls.size > 0) {
        const wrapped = new Set([...found.wrapped, ...found.calls.keys()]);
        result.wrapped = [...wrapped].toSorted((a, b) => a.localeCompare(b));
        result.calls = Object.fromEntries(
          [...wrapped]
            .toSorted((a, b) => a.localeCompare(b))
            .map((name) => [name, found.calls.get(name) ?? 0]),
        );
        if (found.unwrapped.size > 0) {
          result.unwrapped = Object.fromEntries(
            [...found.unwrapped].toSorted(([a], [b]) => a.localeCompare(b)),
          );
        }
      }
      return result;
    });

  const report: TraceReport = {
    schema: TRACE_SCHEMA,
    createdAt: extras.createdAt ?? new Date().toISOString(),
    processes,
    partialEsm,
    callTracing: {
      enabled: callsEnabled,
      packages: [...watched].toSorted((a, b) => a.localeCompare(b)),
    },
    skippedLines: extras.skipped ?? 0,
    packages,
  };
  if (extras.command) report.command = extras.command;
  return report;
}

/** Fold raw JSONL text (what the hook writes). */
export function foldTraceText(text: string, command?: TraceReport["command"]): TraceReport {
  const { records, skipped } = parseTraceLines(text);
  return foldTraceRecords(records, { skipped, command });
}

/**
 * Read a trace from disk: either the folded JSON that `traceRun` writes or the raw JSONL the hook
 * appends. Throws with the path when the file is missing or is neither.
 */
export function readTraceFile(path: string): TraceReport {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read trace file ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as Partial<TraceReport> | null;
    if (parsed?.schema === TRACE_SCHEMA && Array.isArray(parsed.packages)) {
      return parsed as TraceReport;
    }
  } catch {
    // Not one JSON document: read it as JSONL, which reports what it could not parse.
  }
  const { records, skipped } = parseTraceLines(text);
  if (records.length === 0) {
    throw new Error(
      `${path} is not an Autoremediator trace (no ${TRACE_SCHEMA} report and no trace records). Produce one with "autoremediator trace run".`,
    );
  }
  return foldTraceRecords(records, { skipped });
}
