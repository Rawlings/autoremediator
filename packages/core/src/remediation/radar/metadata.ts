/**
 * Registry metadata signals: a release whose predecessor was deprecated with a security message,
 * and release timing (a burst of releases, or a quick follow-up to the previous release). Timing
 * proves nothing alone; it can only ever add a few points.
 */
import semver from "semver";

import { mentionsSecurity } from "./changelog.js";
import { evidenceLine, sanitizeEvidence } from "./sanitize.js";
import { RADAR_POINTS, type RadarFlag } from "./types.js";

export interface PackumentVersion {
  version: string;
  /** Deprecation message from the registry; untrusted text. */
  deprecated?: string;
  /** Publish time, ISO 8601. */
  publishedAt?: string;
}

const HOUR = 3_600_000;
const BURST_WINDOW = 48 * HOUR;
const BURST_SIZE = 3;
const FOLLOW_UP_WINDOW = 24 * HOUR;

function time(version: PackumentVersion | undefined): number | undefined {
  if (!version?.publishedAt) return undefined;
  const value = Date.parse(version.publishedAt);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Flags for the releases in `(from, to]`. `all` is every stable version of the package (the
 * predecessor of the first release in range is `from` itself).
 */
export function metadataFlags(
  all: readonly PackumentVersion[],
  from: string,
  to: string,
): RadarFlag[] {
  const ordered = all
    .filter((entry) => semver.valid(entry.version) && !semver.prerelease(entry.version))
    .toSorted((a, b) => semver.compare(a.version, b.version));
  const flags: RadarFlag[] = [];

  // A release after a version the maintainers deprecated for security reasons. One notice repeated
  // on many versions is a single signal: it is reported once, at the first release it leads to.
  const noticed = new Map<string, { flag: RadarFlag; count: number }>();
  for (const [index, entry] of ordered.entries()) {
    if (!entry.deprecated || semver.lt(entry.version, from) || semver.gte(entry.version, to))
      continue;
    if (!mentionsSecurity(entry.deprecated)) continue;
    const successor = ordered[index + 1];
    if (!successor || semver.gt(successor.version, to)) continue;
    const seen = noticed.get(entry.deprecated);
    if (seen) {
      seen.count++;
      continue;
    }
    noticed.set(entry.deprecated, {
      count: 1,
      flag: {
        category: "metadata",
        signal: "deprecated-for-security",
        release: successor.version,
        points: RADAR_POINTS.metadata["deprecated-for-security"],
        location: sanitizeEvidence(`registry:versions.${entry.version}.deprecated`, 120),
        evidence: evidenceLine(`${entry.version} deprecated`, `"${entry.deprecated}"`),
        occurrences: 1,
      },
    });
  }
  for (const { flag, count } of noticed.values()) flags.push({ ...flag, occurrences: count });

  const inRange = ordered.filter(
    (entry) => semver.gt(entry.version, from) && semver.lte(entry.version, to),
  );
  const times = inRange
    .map((entry) => ({ entry, at: time(entry) }))
    .filter((item): item is { entry: PackumentVersion; at: number } => item.at !== undefined);

  // Several releases within two days.
  for (let start = 0; start + BURST_SIZE <= times.length; start++) {
    const first = times[start];
    const last = times[start + BURST_SIZE - 1];
    if (first && last && last.at - first.at <= BURST_WINDOW) {
      flags.push({
        category: "metadata",
        signal: "release-burst",
        release: last.entry.version,
        points: RADAR_POINTS.metadata["release-burst"],
        location: "registry:time",
        evidence: evidenceLine(
          `${first.entry.version}..${last.entry.version}`,
          `${BURST_SIZE} releases within ${Math.max(1, Math.round((last.at - first.at) / HOUR))} hours`,
        ),
        occurrences: 1,
      });
      break;
    }
  }

  // A patch release published within a day of the release before it.
  for (const [index, item] of times.entries()) {
    const previous =
      index === 0 ? ordered.find((entry) => entry.version === from) : times[index - 1]?.entry;
    const previousAt = index === 0 ? time(previous) : times[index - 1]?.at;
    if (!previous || previousAt === undefined) continue;
    const difference = semver.diff(previous.version, item.entry.version);
    if (
      difference === "patch" &&
      item.at - previousAt <= FOLLOW_UP_WINDOW &&
      item.at >= previousAt
    ) {
      flags.push({
        category: "metadata",
        signal: "quick-follow-up",
        release: item.entry.version,
        points: RADAR_POINTS.metadata["quick-follow-up"],
        location: "registry:time",
        evidence: evidenceLine(
          item.entry.version,
          `patch release ${Math.max(1, Math.round((item.at - previousAt) / HOUR))} hours after ${previous.version}`,
        ),
        occurrences: 1,
      });
      break;
    }
  }
  return flags;
}
