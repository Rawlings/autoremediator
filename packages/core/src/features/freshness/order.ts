/**
 * The order climbs are taken in, and why a climb's first step is held back. Both are pure
 * functions of the climbs and the policy.
 */
import { isPackageAllowed } from "../../infra/policy/policy.js";
import type { AutoremediatorPolicy } from "../../infra/policy/policy.js";
import type { FreshnessClimb } from "./types.js";

const BREAKABILITY_RANK = { Low: 0, Medium: 1, Unknown: 2, High: 3 } as const;
const LEVEL_RANK = { patch: 0, minor: 1, major: 2 } as const;

/** How risky a climb's first step is by level alone. A breaking boundary ranks as a major. */
function levelRank(climb: FreshnessClimb): number {
  const first = climb.steps[0];
  if (!first) return 0;
  return first.kind === "major" ? LEVEL_RANK.major : LEVEL_RANK[first.level];
}

function rankOf(climb: FreshnessClimb): number[] {
  return [
    climb.held ? 1 : 0,
    climb.assessment ? BREAKABILITY_RANK[climb.assessment.breakability] : 0,
    levelRank(climb),
    climb.steps.length,
  ];
}

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
