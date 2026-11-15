/**
 * The climb from an installed version towards the latest, in small steps. Pure.
 *
 * A step is one jump: the first catches up to the newest release on the installed major (the
 * migration path upgrade guides recommend, and the lowest-risk move there is), and each later one
 * goes to the newest release of the next major that has any. Below 1.0.0 every `0.minor` counts as
 * a major, since a 0.x minor may break. A deprecated release is never landed on while another
 * candidate exists. The climb stops at the first step that leaves the package inside the policy, so
 * a package allowed to trail by one major is not dragged onto the newest one. Without a policy the
 * climb runs all the way to the latest release.
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
  /** Versions never to land on (remediation memory: tried earlier and rejected). */
  rejected?: ReadonlySet<string>;
  now: number;
}

/**
 * The breaking boundary a version sits in: its major, or, below 1.0.0, its `0.minor`, because a 0.x
 * minor may break (the assumption semver's caret ranges make too). A climb moves one boundary at a
 * time, and crossing one counts as a major bump for the policy.
 */
export function boundaryOf(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed) return version;
  return parsed.major === 0 ? `0.${parsed.minor}` : String(parsed.major);
}

interface Candidate {
  version: string;
  /** Every newer release in this boundary is deprecated, so this is the newest of those. */
  deprecated: boolean;
}

/**
 * The versions a step may land on, one per boundary: stable, newer than `installed`, no newer than
 * `latest`. A deprecated release is never chosen while another candidate exists: within a boundary
 * it gives way to a release that is not deprecated, and a boundary whose newer releases are all
 * deprecated is skipped when any other boundary has a candidate. Only when every candidate is
 * deprecated are they returned, flagged, for the step to be held.
 */
function candidates(
  input: ClimbInput,
  installed: semver.SemVer,
  latest: semver.SemVer,
): Candidate[] {
  const stable = input.versions.filter(
    (version) =>
      semver.valid(version) !== null &&
      semver.prerelease(version) === null &&
      semver.gt(version, installed) &&
      semver.lte(version, latest) &&
      !input.rejected?.has(version),
  );
  const deprecated = input.deprecated ?? new Set<string>();
  const byBoundary = new Map<string, string[]>();
  for (const version of stable) {
    const key = boundaryOf(version);
    const group = byBoundary.get(key) ?? [];
    group.push(version);
    byBoundary.set(key, group);
  }
  const best: Candidate[] = [];
  for (const group of byBoundary.values()) {
    const preferred = group.filter((version) => !deprecated.has(version));
    const pool = preferred.length > 0 ? preferred : group;
    best.push({ version: pool.toSorted(semver.rcompare)[0]!, deprecated: preferred.length === 0 });
  }
  const ordered = best.toSorted((a, b) => semver.compare(a.version, b.version));
  const usable = ordered.filter((candidate) => !candidate.deprecated);
  return usable.length > 0 ? usable : ordered;
}

/**
 * The steps from `installed` towards `latest`, or none when it is not behind, or when no published
 * version lies in between (the registry says latest is newer, but offers nothing to land on).
 */
export function climbSteps(input: ClimbInput): FreshnessStep[] {
  const installed = parseVersion(input.installed);
  const latest = parseVersion(input.latest);
  if (!installed || !latest || !isBehind(input.installed, input.latest)) return [];

  const chosen: Candidate[] = [];
  for (const target of candidates(input, installed, latest)) {
    chosen.push(target);
    const distance = distanceBetween({
      installed: target.version,
      latest: input.latest,
      installedPublishedAt: input.published?.get(target.version),
      now: input.now,
    });
    const behind = isBehind(target.version, input.latest);
    // A landing whose publish time is unknown cannot be shown to meet `maxAgeDays`, so the climb goes on.
    const ageUnknown =
      input.policy?.maxAgeDays !== undefined && distance?.ageDays === undefined && behind;
    if (
      input.policy &&
      distance &&
      !ageUnknown &&
      exceedsPolicy(distance, behind, input.policy).length === 0
    ) {
      break;
    }
  }

  return chosen.map((target, position) => {
    const fromVersion = position === 0 ? installed.version : chosen[position - 1]!.version;
    const toVersion = target.version;
    const step: FreshnessStep = {
      packageName: input.packageName,
      field: input.field,
      fromVersion,
      toVersion,
      level: classifyUpgradeLevel(fromVersion, toVersion) ?? "major",
      kind: boundaryOf(fromVersion) === boundaryOf(toVersion) ? "catch-up" : "major",
      index: position + 1,
      of: chosen.length,
    };
    if (target.deprecated) step.deprecated = true;
    return step;
  });
}
