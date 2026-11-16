/**
 * Published advisories, as OSV publishes them, and what the benchmark takes from them.
 *
 * The record is stored exactly as fetched. The vulnerable range and the first patched version are
 * derived here from its `affected[].ranges[].events`, independently of the code under test, and the
 * result is written into a task's offline intelligence snapshot by `bench:corpus freeze`.
 */
import { z } from "zod";

const eventSchema = z
  .object({
    introduced: z.string().optional(),
    fixed: z.string().optional(),
    last_affected: z.string().optional(),
    limit: z.string().optional(),
  })
  .passthrough();

const affectedSchema = z
  .object({
    package: z.object({ ecosystem: z.string(), name: z.string() }).passthrough(),
    ranges: z
      .array(z.object({ type: z.string(), events: z.array(eventSchema) }).passthrough())
      .default([]),
  })
  .passthrough();

export const osvSchema = z
  .object({
    id: z.string().min(1),
    aliases: z.array(z.string()).default([]),
    summary: z.string().optional(),
    details: z.string().optional(),
    modified: z.string(),
    published: z.string().optional(),
    withdrawn: z.string().optional(),
    database_specific: z.record(z.string(), z.unknown()).optional(),
    affected: z.array(affectedSchema).default([]),
    references: z.array(z.object({ url: z.string() }).passthrough()).default([]),
  })
  .passthrough();
export type OsvRecord = z.infer<typeof osvSchema>;

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

/** Throw if the advisory may not enter the corpus: malware, withdrawn, or not an npm advisory. */
export function assertAdmissible(record: OsvRecord, packageName: string): void {
  if (/^MAL-/i.test(record.id) || record.aliases.some((alias) => /^MAL-/i.test(alias))) {
    throw new Error(`${record.id} is a malware advisory; malware is never part of the benchmark`);
  }
  if (record.withdrawn !== undefined) {
    throw new Error(`${record.id} was withdrawn on ${record.withdrawn}`);
  }
  const affects = record.affected.some(
    (entry) => entry.package.ecosystem === "npm" && entry.package.name === packageName,
  );
  if (!affects) throw new Error(`${record.id} does not affect the npm package ${packageName}`);
}

interface Interval {
  from: string;
  to?: { version: string; inclusive: boolean };
}

function intervalsOf(record: OsvRecord, packageName: string): Interval[] {
  const intervals: Interval[] = [];
  for (const entry of record.affected) {
    if (entry.package.ecosystem !== "npm" || entry.package.name !== packageName) continue;
    for (const range of entry.ranges) {
      if (range.type !== "SEMVER" && range.type !== "ECOSYSTEM") continue;
      let open: Interval | undefined;
      for (const event of range.events) {
        if (event.introduced !== undefined) {
          if (open) intervals.push(open);
          open = { from: event.introduced === "0" ? "0.0.0" : event.introduced };
        } else if (open && event.fixed !== undefined) {
          intervals.push({ ...open, to: { version: event.fixed, inclusive: false } });
          open = undefined;
        } else if (open && event.last_affected !== undefined) {
          intervals.push({ ...open, to: { version: event.last_affected, inclusive: true } });
          open = undefined;
        }
      }
      if (open) intervals.push(open);
    }
  }
  return intervals;
}

/** A semver range such as `>=0.0.0 <4.17.21 || >=5.0.0 <5.0.1`. */
export function vulnerableRangeOf(record: OsvRecord, packageName: string): string {
  const intervals = intervalsOf(record, packageName);
  if (intervals.length === 0) {
    throw new Error(
      `${record.id} has no SEMVER range for ${packageName}; versions-only records are not supported`,
    );
  }
  return intervals
    .map((interval) =>
      interval.to
        ? `>=${interval.from} <${interval.to.inclusive ? "=" : ""}${interval.to.version}`
        : `>=${interval.from}`,
    )
    .join(" || ");
}

/** Every version an advisory names as fixed, as written. */
export function fixedVersionsOf(record: OsvRecord, packageName: string): string[] {
  return intervalsOf(record, packageName).flatMap((interval) =>
    interval.to && !interval.to.inclusive ? [interval.to.version] : [],
  );
}

export function severityOf(record: OsvRecord): Severity {
  const value = record.database_specific?.["severity"];
  const text = typeof value === "string" ? value.toUpperCase() : "";
  if (text === "MODERATE") return "MEDIUM";
  return text === "LOW" || text === "MEDIUM" || text === "HIGH" || text === "CRITICAL"
    ? text
    : "UNKNOWN";
}
