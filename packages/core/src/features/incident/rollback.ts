import semver from "semver";

import type { PatchResult, RemediationReport } from "../remediate/types.js";
import type { PackageHistory } from "./history.js";
import type { PackageExposure, RollbackProposal } from "./types.js";

export interface RollbackChoice {
  toVersion?: string;
  basis?: RollbackProposal["basis"];
  lastUsedBefore?: string;
  newerUnaffected?: string;
}

const inAffected = (version: string, range: string): boolean =>
  semver.satisfies(version, range, { includePrerelease: true });

/**
 * The version to go back to for one installed copy.
 *
 * Candidates are versions outside the affected range and older than the installed copy; a
 * prerelease is only considered when the installed copy is one. With the registry consulted, the
 * newest candidate published (or seen in the project's lockfile history) wins ("newest-unaffected").
 * Without it, the newest candidate the project's own lockfile history shows it has run wins
 * ("last-used-before"): the version the project is known to have worked with.
 */
export function chooseRollbackTarget(input: {
  range: string;
  installed: string;
  /** Versions the registry lists, if it was consulted. */
  published?: string[];
  /** Versions the lockfile had just before the affected one first arrived. */
  previousVersions: string[];
  /** Every version of the package seen in the lockfile history. */
  seenVersions: string[];
}): RollbackChoice {
  const allowPrerelease = semver.prerelease(input.installed) !== null;
  const usable = (version: string): boolean =>
    semver.valid(version) !== null &&
    !inAffected(version, input.range) &&
    (allowPrerelease || semver.prerelease(version) === null);
  const olderOf = (versions: string[]): string[] =>
    [...new Set(versions)]
      .filter((version) => usable(version) && semver.lt(version, input.installed))
      .toSorted(semver.rcompare);

  const usedBefore = olderOf([...input.seenVersions, ...input.previousVersions])[0];
  const newerUnaffected = [...new Set([...(input.published ?? []), ...input.seenVersions])]
    .filter((version) => usable(version) && semver.gt(version, input.installed))
    .toSorted(semver.rcompare)[0];
  const common = {
    ...(usedBefore ? { lastUsedBefore: usedBefore } : {}),
    ...(newerUnaffected ? { newerUnaffected } : {}),
  };

  if (input.published) {
    const newest = olderOf([...input.published, ...input.seenVersions])[0];
    if (newest) return { toVersion: newest, basis: "newest-unaffected", ...common };
  }
  if (usedBefore) return { toVersion: usedBefore, basis: "last-used-before", ...common };
  return common;
}

/** One proposal per installed affected copy. */
export function proposeRollbacks(input: {
  exposures: PackageExposure[];
  histories: PackageHistory[];
  published: Map<string, string[] | undefined>;
}): RollbackProposal[] {
  const proposals: RollbackProposal[] = [];
  const done = new Set<string>();
  for (const exposure of input.exposures) {
    const history = input.histories.find(
      (candidate) => candidate.packageName === exposure.packageName,
    );
    const seen = history?.versionsSeen.map((entry) => entry.version) ?? [];
    for (const occurrence of exposure.occurrences) {
      const key = `${exposure.packageName}@${occurrence.version}`;
      if (done.has(key)) continue;
      done.add(key);

      const previous = history?.windows
        .filter((window) => window.version === occurrence.version)
        .flatMap((window) => window.previousVersions)
        .toSorted((a, b) => (semver.valid(a) && semver.valid(b) ? semver.rcompare(a, b) : 0));
      const published = input.published.get(exposure.packageName);
      const choice = chooseRollbackTarget({
        range: exposure.range,
        installed: occurrence.version,
        ...(published ? { published } : {}),
        previousVersions: previous ?? [],
        seenVersions: seen,
      });
      const direct = occurrence.direct;
      proposals.push({
        packageName: exposure.packageName,
        fromVersion: occurrence.version,
        ...(choice.toVersion ? { toVersion: choice.toVersion } : {}),
        strategy: direct ? "version-bump" : "override",
        dependencyScope: direct ? "direct" : "transitive",
        ...(choice.basis ? { basis: choice.basis } : {}),
        ...(choice.lastUsedBefore ? { lastUsedBefore: choice.lastUsedBefore } : {}),
        ...(choice.newerUnaffected ? { newerUnaffected: choice.newerUnaffected } : {}),
        ...(choice.toVersion
          ? {}
          : {
              reason: `No known version of ${exposure.packageName} older than ${occurrence.version} is outside the affected range ${exposure.range}${
                published ? "" : " (the registry was not consulted)"
              }. If every version is affected, remove or replace the dependency.`,
            }),
      });
    }
  }
  return proposals;
}

/**
 * The preview report `persistPlan` turns into a plan. Every item is held for approval: an
 * incident rollback is never applied by itself.
 */
export function rollbackReport(input: {
  id: string;
  summary: string;
  advisorySummary: string;
  affected: Array<{
    name: string;
    range: string;
    source: "osv" | "github-advisory" | "offline-snapshot" | "user-supplied";
  }>;
  proposals: RollbackProposal[];
}): RemediationReport {
  const results: PatchResult[] = input.proposals.map((proposal) => {
    const base = {
      packageName: proposal.packageName,
      fromVersion: proposal.fromVersion,
      applied: false,
      dryRun: true,
      dependencyScope: proposal.dependencyScope,
    };
    if (!proposal.toVersion) {
      return {
        ...base,
        strategy: "none" as const,
        unresolvedReason: "no-safe-version" as const,
        message: proposal.reason ?? "No version to roll back to is known.",
      };
    }
    return {
      ...base,
      strategy: proposal.strategy,
      toVersion: proposal.toVersion,
      disposition: "hold-for-approval" as const,
      dispositionReason:
        "Incident rollback: review before applying; it is never applied automatically.",
      message: `Roll ${proposal.packageName} back from ${proposal.fromVersion} to ${proposal.toVersion} (${
        proposal.strategy === "version-bump"
          ? "exact pin in package.json"
          : "package-manager override"
      }).`,
    };
  });
  return {
    cveId: input.id,
    cveDetails: {
      id: input.id,
      summary: input.advisorySummary,
      severity: "UNKNOWN",
      references: [],
      affectedPackages: input.affected.map((entry) => ({
        name: entry.name,
        ecosystem: "npm" as const,
        vulnerableRange: entry.range,
        source: entry.source,
      })),
    },
    vulnerablePackages: [],
    results,
    summary: input.summary,
  };
}
