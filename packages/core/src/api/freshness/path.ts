/**
 * The climb from an installed version towards the latest, in small steps. Pure.
 *
 * A step is one jump: the first catches up to the newest release on the installed major (the
 * migration path upgrade guides recommend, and the lowest-risk move there is), and each later one
 * goes to the newest release of the next major that has any. The climb stops at the first step that
 * leaves the package inside the policy, so a package allowed to trail by one major is not dragged
 * onto the newest one. Without a policy the climb runs all the way to the latest release.
 */
import semver from "semver";

import { classifyUpgradeLevel } from "../../intelligence/sources/registry.js";
import type { FreshnessPolicy } from "../../platform/freshness-policy.js";
import { distanceBetween, exceedsPolicy, isBehind, parseVersion } from "./distance.js";
import type { FreshnessStep } from "./types.js";

export interface ClimbInput {
  packageName: string;
  field: FreshnessStep["field"];
  installed: string;
  latest: string;
  /** Every published version. */
  versions: readonly string[];
  deprecated?: ReadonlySet<string>;
  /** Publish time of each version, to apply `maxAgeDays` to the version a step lands on. */
  published?: ReadonlyMap<string, string>;
  policy?: FreshnessPolicy;
  now: number;
}

/** The versions a step may land on: stable, newer than `installed`, no newer than `latest`. */
function candidates(input: ClimbInput, installed: semver.SemVer, latest: semver.SemVer): string[] {
  const stable = input.versions.filter(
    (version) =>
      semver.valid(version) !== null &&
      semver.prerelease(version) === null &&
      semver.gt(version, installed) &&
      semver.lte(version, latest),
  );
  // A deprecated release is a last resort within its major, as when choosing a security fix.
  const deprecated = input.deprecated ?? new Set<string>();
  const byMajor = new Map<number, string[]>();
  for (const version of stable) {
    const group = byMajor.get(semver.major(version)) ?? [];
    group.push(version);
    byMajor.set(semver.major(version), group);
  }
  const best: string[] = [];
  for (const major of [...byMajor.keys()].toSorted((a, b) => a - b)) {
    const group = byMajor.get(major)!;
    const preferred = group.filter((version) => !deprecated.has(version));
    const pool = preferred.length > 0 ? preferred : group;
    best.push(pool.toSorted(semver.rcompare)[0]!);
  }
  return best;
}

/**
 * The steps from `installed` towards `latest`, or none when it is not behind, or when no published
 * version lies in between (the registry says latest is newer, but offers nothing to land on).
 */
export function climbSteps(input: ClimbInput): FreshnessStep[] {
  const installed = parseVersion(input.installed);
  const latest = parseVersion(input.latest);
  if (!installed || !latest || !isBehind(input.installed, input.latest)) return [];

  const targets = candidates(input, installed, latest);
  const chosen: string[] = [];
  for (const target of targets) {
    chosen.push(target);
    const distance = distanceBetween({
      installed: target,
      latest: input.latest,
      installedPublishedAt: input.published?.get(target),
      now: input.now,
    });
    if (
      input.policy &&
      distance &&
      exceedsPolicy(distance, isBehind(target, input.latest), input.policy).length === 0
    ) {
      break;
    }
  }

  return chosen.map((toVersion, position) => {
    const fromVersion = position === 0 ? installed.version : chosen[position - 1]!;
    const level = classifyUpgradeLevel(fromVersion, toVersion) ?? "major";
    return {
      packageName: input.packageName,
      field: input.field,
      fromVersion,
      toVersion,
      level,
      kind: level === "major" ? ("major" as const) : ("catch-up" as const),
      index: position + 1,
      of: chosen.length,
    };
  });
}
