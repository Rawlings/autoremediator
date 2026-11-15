/**
 * How far behind the latest release a version is, and what that is worth. Pure: no registry, no
 * clock (the caller passes `now`), so the same inputs always give the same numbers.
 */
import semver from "semver";

import type { FreshnessPolicy } from "../../infra/policy/freshness-policy.js";
import type { FreshnessDistance } from "./types.js";

const DAY_MS = 86_400_000;

/** An exact version, or the nearest one a range-like string names; undefined when it names none. */
export function parseVersion(version: string): semver.SemVer | undefined {
  return semver.parse(version) ?? semver.coerce(version) ?? undefined;
}

export interface DistanceInput {
  installed: string;
  latest: string;
  /** Every published version, to count releases in between. */
  published?: readonly string[];
  /** When the installed version was published. */
  installedPublishedAt?: string;
  /** Epoch milliseconds. */
  now: number;
}

/** True when `latest` is a newer release than `installed`. */
export function isBehind(installed: string, latest: string): boolean {
  const from = parseVersion(installed);
  const to = parseVersion(latest);
  return from !== undefined && to !== undefined && semver.gt(to, from);
}

/**
 * The distance from `installed` to `latest`. Majors are the plain difference; minors count only on
 * the latest major and patches only on the latest minor, because "three minors behind" means little
 * across a major boundary. A version that is not older than the latest is 0 behind. Undefined when
 * either version cannot be read.
 */
export function distanceBetween(input: DistanceInput): FreshnessDistance | undefined {
  const from = parseVersion(input.installed);
  const to = parseVersion(input.latest);
  if (!from || !to) return undefined;

  const behind = semver.gt(to, from);
  const majorsBehind = behind ? Math.max(0, to.major - from.major) : 0;
  const minorsBehind = behind && majorsBehind === 0 ? Math.max(0, to.minor - from.minor) : 0;
  const patchesBehind =
    behind && majorsBehind === 0 && minorsBehind === 0 ? Math.max(0, to.patch - from.patch) : 0;

  const result: FreshnessDistance = { majorsBehind, minorsBehind, patchesBehind };

  if (input.published) {
    result.releasesBehind = behind
      ? input.published.filter(
          (version) =>
            semver.valid(version) !== null &&
            semver.prerelease(version) === null &&
            semver.gt(version, from) &&
            semver.lte(version, to),
        ).length
      : 0;
  }

  if (input.installedPublishedAt) {
    const at = Date.parse(input.installedPublishedAt);
    if (!Number.isNaN(at)) result.ageDays = Math.max(0, Math.floor((input.now - at) / DAY_MS));
  }
  return result;
}

/**
 * The policy limits a distance is past, in words. A package that is not behind is never past a
 * limit, however old its version: nothing newer exists to move to.
 */
export function exceedsPolicy(
  distance: FreshnessDistance,
  behind: boolean,
  policy: FreshnessPolicy | undefined,
): string[] {
  if (!policy || !behind) return [];
  const reasons: string[] = [];
  if (policy.maxMajorsBehind !== undefined && distance.majorsBehind > policy.maxMajorsBehind) {
    reasons.push(
      `${distance.majorsBehind} major${distance.majorsBehind === 1 ? "" : "s"} behind (limit ${policy.maxMajorsBehind})`,
    );
  }
  if (policy.maxMinorsBehind !== undefined && distance.minorsBehind > policy.maxMinorsBehind) {
    reasons.push(
      `${distance.minorsBehind} minor${distance.minorsBehind === 1 ? "" : "s"} behind (limit ${policy.maxMinorsBehind})`,
    );
  }
  if (
    policy.maxAgeDays !== undefined &&
    distance.ageDays !== undefined &&
    distance.ageDays > policy.maxAgeDays
  ) {
    reasons.push(`installed version is ${distance.ageDays} days old (limit ${policy.maxAgeDays})`);
  }
  return reasons;
}

/**
 * How stale one dependency is, 0 to 100: 40 per major behind, 5 per minor behind (at most 30), 1 per
 * patch behind (at most 10), capped at 100. A transparent weighting, not a measurement: it exists to
 * rank packages and to give the project one number to watch.
 */
export function penaltyOf(distance: FreshnessDistance): number {
  return Math.min(
    100,
    40 * distance.majorsBehind +
      Math.min(30, 5 * distance.minorsBehind) +
      Math.min(10, distance.patchesBehind),
  );
}

/** 100 minus the mean penalty of the packages that count, rounded; 100 when none count. */
export function projectScore(penalties: readonly number[]): number {
  if (penalties.length === 0) return 100;
  const mean = penalties.reduce((total, penalty) => total + penalty, 0) / penalties.length;
  return Math.round(100 - mean);
}
