import semver from "semver";

/**
 * The freshness report: how far behind each direct dependency is, a project score, and the climb
 * for each one past the policy. Read-only: it queries the package manager and the registry and
 * changes nothing.
 */
import type {
  NpmRegistryPackageInfo,
  PackageTimeline,
} from "../../intelligence/sources/registry.js";
import { isIgnoredPackage, type FreshnessPolicy } from "../../platform/freshness-policy.js";
import {
  loadMemoryConstraints,
  pinnedMessage,
  rejectedMessage,
  type MemoryConstraints,
} from "../../platform/memory/consume.js";
import { detectPackageManager } from "../../platform/package-manager/index.js";
import { isPackageAllowed, loadPolicy, type AutoremediatorPolicy } from "../../platform/policy.js";
import {
  defaultFreshnessDeps,
  mapLimit,
  type DirectDependency,
  type FreshnessDeps,
} from "./deps.js";
import { distanceBetween, exceedsPolicy, isBehind, penaltyOf, projectScore } from "./distance.js";
import { climbSteps } from "./path.js";
import type {
  FreshnessClimb,
  FreshnessCounts,
  FreshnessDistance,
  FreshnessOptions,
  FreshnessPackage,
  FreshnessReport,
  StepAssessment,
} from "./types.js";

const BREAKABILITY_RANK = { Low: 0, Medium: 1, Unknown: 2, High: 3 } as const;
const LEVEL_RANK = { patch: 0, minor: 1, major: 2 } as const;

const rankOf = (climb: FreshnessClimb): number[] => {
  const first = climb.steps[0];
  return [
    climb.held ? 1 : 0,
    climb.assessment ? BREAKABILITY_RANK[climb.assessment.breakability] : 0,
    // A step across a breaking boundary (a major, or a 0.x minor) ranks as a major.
    first ? (first.kind === "major" ? LEVEL_RANK.major : LEVEL_RANK[first.level]) : 0,
    climb.steps.length,
  ];
};

/**
 * Order climbs by how likely their first step is to break the project, lowest first, so a scheduled
 * run takes the safest step first. Held climbs go last. Without an assessment the step's level
 * (patch, minor, major) stands in; ties go to the climb that is nearer done, then to the name.
 */
export function orderClimbs(climbs: readonly FreshnessClimb[]): FreshnessClimb[] {
  return climbs.toSorted((a, b) => {
    const left = rankOf(a);
    const right = rankOf(b);
    for (const [index, value] of left.entries()) {
      const difference = value - right[index]!;
      if (difference !== 0) return difference;
    }
    return a.packageName.localeCompare(b.packageName);
  });
}

/** Why the first step of a climb cannot be taken as things stand, if it cannot. */
export function holdFor(
  climb: FreshnessClimb,
  policy: AutoremediatorPolicy,
  allowHigh: boolean,
): FreshnessClimb["held"] {
  const first = climb.steps[0];
  if (!first) return undefined;
  if (!isPackageAllowed(policy, climb.packageName)) {
    return {
      reason: "package-not-allowed",
      message: `${climb.packageName} is excluded by allowPackages/denyPackages in the policy.`,
    };
  }
  if (first.deprecated) {
    return {
      reason: "only-newer-release-deprecated",
      message: `The only newer release is deprecated (${first.toVersion}), so ${climb.packageName} is left where it is.`,
    };
  }
  if ((first.kind === "major" || first.level === "major") && !policy.allowMajorBumps) {
    const zeroX = first.level !== "major";
    return {
      reason: "major-bump-not-allowed",
      message: `${first.fromVersion} -> ${first.toVersion} crosses ${zeroX ? "a 0.x minor, which counts as a major," : "a major,"} and allowMajorBumps is off in the policy.`,
    };
  }
  if (climb.assessment?.breakability === "High" && !allowHigh) {
    return {
      reason: "high-breakability",
      message: `${climb.assessment.summary} Held: pass allowHigh (--allow-high) to take it.`,
    };
  }
  return undefined;
}

export interface Gathered {
  cwd: string;
  packageManager: ReturnType<typeof detectPackageManager>;
  policy: AutoremediatorPolicy;
  packages: FreshnessPackage[];
  timelines: Map<string, PackageTimeline | undefined>;
  failures: Map<string, string>;
  notes: string[];
  /** What remediation memory says: pinned packages and rejected upgrades. Absent with `ignoreMemory`. */
  memory?: MemoryConstraints;
  now: number;
}

interface DescribeContext {
  cwd: string;
  deps: FreshnessDeps;
  outdated: Map<string, NpmRegistryPackageInfo>;
  timelines: Map<string, PackageTimeline | undefined>;
  failures: Map<string, string>;
  policy: FreshnessPolicy | undefined;
  now: number;
}

/** Why the installed version's age is not known, when it is not and `maxAgeDays` needs it. */
function unknownAgeReason(
  name: string,
  version: string,
  distance: FreshnessDistance,
  context: DescribeContext,
): string | undefined {
  if (context.policy?.maxAgeDays === undefined || distance.ageDays !== undefined) return undefined;
  const failure = context.failures.get(name);
  if (failure) {
    return `the registry could not be read for ${name} (${failure.split("\n")[0]}), so the publish time of ${name} ${version} is unknown`;
  }
  return context.timelines.get(name)
    ? `the registry lists no publish time for ${name} ${version}`
    : `${name} is not on the registry, so the publish time of ${name} ${version} is unknown`;
}

function describePackage(dependency: DirectDependency, context: DescribeContext): FreshnessPackage {
  const base = { name: dependency.name, field: dependency.field, range: dependency.range };
  const { policy } = context;
  if (policy && isIgnoredPackage(policy.ignore, dependency.name)) {
    return { ...base, status: "ignored", exceeds: [] };
  }
  const info = context.outdated.get(dependency.name);
  if (!info) {
    if (!context.deps.isInstalled(context.cwd, dependency.name)) {
      return { ...base, status: "not-installed", exceeds: [] };
    }
    return { ...base, status: "current", penalty: 0, exceeds: [] };
  }

  const timeline = context.timelines.get(dependency.name);
  const distance = distanceBetween({
    installed: info.currentVersion,
    latest: info.latestVersion,
    published: timeline?.versions,
    installedPublishedAt: timeline?.published.get(info.currentVersion),
    now: context.now,
  });
  const where = { installed: info.currentVersion, latest: info.latestVersion };
  if (!distance) return { ...base, ...where, status: "unreadable", exceeds: [] };
  const behind = isBehind(info.currentVersion, info.latestVersion);
  const unknownAge = behind
    ? unknownAgeReason(dependency.name, info.currentVersion, distance, context)
    : undefined;
  return {
    ...base,
    ...where,
    status: behind ? "behind" : "current",
    ...distance,
    penalty: penaltyOf(distance),
    exceeds: exceedsPolicy(distance, behind, policy),
    ...(unknownAge ? { unknownAge } : {}),
  };
}

/** Read the project's direct dependencies and, for the ones that are behind, the registry's timeline. */
export async function gatherFreshness(
  options: FreshnessOptions,
  deps: FreshnessDeps,
): Promise<Gathered> {
  const cwd = options.cwd ?? process.cwd();
  const policy = loadPolicy(cwd, options.policy);
  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const now = deps.now();
  const notes: string[] = [];

  const only = options.packages?.length ? new Set(options.packages) : undefined;
  const direct = deps.readDirect(cwd).filter((dependency) => !only || only.has(dependency.name));
  if (only) {
    for (const name of only) {
      if (!direct.some((dependency) => dependency.name === name)) {
        notes.push(`${name} is not a registry dependency in package.json, so it is not covered.`);
      }
    }
  }

  // Pins and rejected upgrades a person or an earlier run recorded; a file that cannot be read safely stops the run.
  const memory = options.ignoreMemory ? undefined : loadMemoryConstraints(cwd, new Date(now));

  const outdated = await deps.queryOutdated(cwd, { packageManager });

  const behindNames = direct
    .filter((dependency) => {
      const info = outdated.get(dependency.name);
      return info !== undefined && isBehind(info.currentVersion, info.latestVersion);
    })
    .map((dependency) => dependency.name);

  const timelines = new Map<string, PackageTimeline | undefined>();
  const failures = new Map<string, string>();
  await mapLimit(behindNames, deps.concurrency, async (name) => {
    try {
      timelines.set(name, await deps.fetchTimeline(name, cwd));
    } catch (error) {
      failures.set(name, error instanceof Error ? error.message : String(error));
    }
  });

  const packages = direct.map((dependency) =>
    describePackage(dependency, {
      cwd,
      deps,
      outdated,
      timelines,
      failures,
      policy: policy.freshness,
      now,
    }),
  );

  return {
    cwd,
    packageManager,
    policy,
    packages,
    timelines,
    failures,
    notes,
    ...(memory ? { memory } : {}),
    now,
  };
}

/** One climb per package past the policy, plus the ones for which none could be made. */
export function buildClimbs(gathered: Gathered): {
  climbs: FreshnessClimb[];
  unplanned: FreshnessReport["unplanned"];
} {
  const climbs: FreshnessClimb[] = [];
  const unplanned: FreshnessReport["unplanned"] = [];
  const policy = gathered.policy.freshness;
  for (const entry of gathered.packages) {
    // An age limit that cannot be checked is not "within policy": list it, with why, and climb nothing.
    if (entry.unknownAge && entry.exceeds.length === 0) {
      unplanned.push({
        packageName: entry.name,
        reason: `the age of ${entry.name} ${entry.installed} is unknown, so maxAgeDays cannot be checked: ${entry.unknownAge}`,
      });
      continue;
    }
    if (
      entry.status !== "behind" ||
      entry.exceeds.length === 0 ||
      !entry.installed ||
      !entry.latest
    ) {
      continue;
    }
    // A person's pin comes first: the package is left alone, whatever else says.
    const pinned = gathered.memory?.pinned.get(entry.name);
    if (pinned) {
      unplanned.push({ packageName: entry.name, reason: pinnedMessage(pinned) });
      continue;
    }
    const failure = gathered.failures.get(entry.name);
    const timeline = gathered.timelines.get(entry.name);
    if (failure || !timeline) {
      unplanned.push({
        packageName: entry.name,
        reason: failure
          ? `the registry could not be read for ${entry.name}: ${failure.split("\n")[0]}`
          : `${entry.name} is not on the registry`,
      });
      continue;
    }
    const rejected = gathered.memory?.rejected.get(entry.name) ?? new Map();
    const steps = climbSteps({
      packageName: entry.name,
      field: entry.field,
      installed: entry.installed,
      latest: entry.latest,
      versions: timeline.versions,
      deprecated: timeline.deprecated,
      published: timeline.published,
      policy,
      rejected: new Set(rejected.keys()),
      now: gathered.now,
    });
    if (steps.length === 0) {
      // Every release in between was rejected earlier: say so, with the entries, rather than "none exists".
      const inRange = [...rejected].filter(
        ([version]) =>
          semver.valid(version) !== null &&
          semver.gt(version, entry.installed!) &&
          semver.lte(version, entry.latest!),
      );
      unplanned.push({
        packageName: entry.name,
        reason:
          inRange.length > 0
            ? `every newer release of ${entry.name} was rejected earlier: ${inRange.map(([, rejection]) => rejectedMessage(rejection)).join("; ")}`
            : `no published version lies between ${entry.installed} and ${entry.latest}`,
      });
      continue;
    }
    climbs.push({
      packageName: entry.name,
      installed: entry.installed,
      latest: entry.latest,
      steps,
    });
  }
  return { climbs, unplanned };
}

function withHold(
  climb: FreshnessClimb,
  policy: AutoremediatorPolicy,
  allowHigh: boolean,
): FreshnessClimb {
  const reason = holdFor(climb, policy, allowHigh);
  return reason ? { ...climb, held: reason } : climb;
}

/** Rate the first step of each climb (at most `deps.concurrency` at a time), then hold and order them. */
export async function assessClimbs(
  climbs: readonly FreshnessClimb[],
  context: { cwd: string; policy: AutoremediatorPolicy; allowHigh: boolean; assess: boolean },
  deps: FreshnessDeps,
  cache: Map<string, Promise<StepAssessment>> = new Map(),
): Promise<FreshnessClimb[]> {
  const rated = context.assess
    ? await mapLimit(climbs, deps.concurrency, async (climb): Promise<FreshnessClimb> => {
        const first = climb.steps[0]!;
        const key = `${first.packageName}@${first.fromVersion}->${first.toVersion}`;
        let pending = cache.get(key);
        if (!pending) {
          pending = deps.assess(first.packageName, first.fromVersion, first.toVersion, context.cwd);
          cache.set(key, pending);
        }
        return { ...climb, assessment: await pending };
      })
    : [...climbs];
  const held = rated.map((climb) => withHold(climb, context.policy, context.allowHigh));
  return orderClimbs(held);
}

function countsOf(packages: readonly FreshnessPackage[]): FreshnessCounts {
  const count = (status: FreshnessPackage["status"]): number =>
    packages.filter((entry) => entry.status === status).length;
  return {
    direct: packages.length,
    current: count("current"),
    behind: count("behind"),
    ignored: count("ignored"),
    notInstalled: count("not-installed"),
    unreadable: count("unreadable"),
    exceeding: packages.filter((entry) => entry.exceeds.length > 0).length,
    unknownAge: packages.filter((entry) => entry.unknownAge !== undefined).length,
  };
}

const groupOf = (entry: FreshnessPackage): number => {
  if (entry.status === "behind") return 0;
  return entry.status === "current" ? 1 : 2;
};

export function sortPackages(packages: readonly FreshnessPackage[]): FreshnessPackage[] {
  return packages.toSorted(
    (a, b) =>
      groupOf(a) - groupOf(b) ||
      (b.penalty ?? 0) - (a.penalty ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

export function reportFrom(
  gathered: Gathered,
  climbs: FreshnessClimb[],
  unplanned: FreshnessReport["unplanned"],
): FreshnessReport {
  const policy = gathered.policy.freshness ?? null;
  const notes = [...gathered.notes];
  if (!policy) {
    notes.push(
      "The policy has no `freshness` key, so no limit is set and no climb is planned. Add one, for example `freshness: { maxMajorsBehind: 1 }`.",
    );
  }
  const notInstalled = gathered.packages.filter((entry) => entry.status === "not-installed");
  if (notInstalled.length > 0) {
    notes.push(
      `${notInstalled.length} direct dependenc${notInstalled.length === 1 ? "y is" : "ies are"} not installed, so the package manager could not say how far behind ${notInstalled.length === 1 ? "it is" : "they are"}; install first. Not counted in the score.`,
    );
  }
  const counted = gathered.packages.filter((entry) => entry.penalty !== undefined);
  return {
    schemaVersion: "1.0",
    generatedAt: new Date(gathered.now).toISOString(),
    cwd: gathered.cwd,
    packageManager: gathered.packageManager,
    policy,
    score: projectScore(counted.map((entry) => entry.penalty!)),
    counts: countsOf(gathered.packages),
    packages: sortPackages(gathered.packages),
    climbs,
    unplanned,
    notes,
  };
}

/**
 * How fresh the project's direct dependencies are, and, for those past the policy's `freshness`
 * limits, the small steps that would bring them back. With `assess`, the first step of each climb is
 * rated by `assessUpgrade` and the climbs are ordered safest first; without it they are ordered by
 * step size. Changes nothing.
 */
export async function freshnessReport(
  options: FreshnessOptions = {},
  deps: FreshnessDeps = defaultFreshnessDeps,
): Promise<FreshnessReport> {
  const gathered = await gatherFreshness(options, deps);
  const { climbs, unplanned } = buildClimbs(gathered);
  const ordered = await assessClimbs(
    climbs,
    {
      cwd: gathered.cwd,
      policy: gathered.policy,
      allowHigh: options.allowHigh ?? false,
      assess: options.assess ?? false,
    },
    deps,
  );
  return reportFrom(gathered, ordered, unplanned);
}
