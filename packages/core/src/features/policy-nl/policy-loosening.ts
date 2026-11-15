import type { AutoremediatorPolicy } from "../../infra/policy/policy.js";
import { AUTONOMY_LEVEL_VALUES, UNRESOLVED_REASON_VALUES } from "../../infra/policy/schemas.js";
import type { AutonomyLevel } from "../../infra/policy/schemas.js";
import type { CveSeverity } from "../../shared/types.js";
import { computeEscalationAction } from "../remediate/escalation.js";

/** One way a new policy is less safe than the one it replaces. */
export interface Loosening {
  /** Dotted path of the policy key, e.g. `constraints.supplyChainPolicy.blockInstallScripts`. */
  key: string;
  /** One sentence a person can read in a review. */
  description: string;
}

/**
 * What the pipeline assumes when the policy is silent. They mirror the defaults in
 * `remediation/local/disposition.ts` and `autonomy/types.ts`, which a platform module cannot import;
 * `policy-loosening.test.ts` pins the autonomy ones to their source.
 */
const DISPOSITION_DEFAULTS = {
  minConfidenceForAutoApply: 0.7,
  holdForTransitive: false,
  escalateOnKev: true,
  escalateOnSlaBreachSeverities: ["CRITICAL", "HIGH"] as readonly CveSeverity[],
};
const AUTONOMY_DEFAULTS = {
  minVerifiedRuns: 5,
  window: 20,
  minSuccessRate: 0.9,
  cooldownDays: 7,
  requireTestCoverage: true,
};
/** The patch confidence a generated patch needs by risk level when the policy sets none (see `DEFAULT_CONFIDENCE_THRESHOLDS`). */
const CONFIDENCE_DEFAULTS = { low: 0.65, medium: 0.7, high: 0.8 } as const;
/** With no `autonomy` key the feature is off; a repository then acts like one capped at L2 (pull requests, no auto-merge signal). */
const IMPLICIT_CEILING: AutonomyLevel = "L2";

type BooleanConstraint =
  | "directDependenciesOnly"
  | "preferVersionBump"
  | "enforceFrozenLockfile"
  | "typecheck"
  | "requireProofOfFix";

/**
 * Every key of the policy file, and whether `findLoosenings` looks at it. A key ending in `.*` stands
 * for everything under it. `policy-loosening.test.ts` walks `policyFileSchema` and fails when a key
 * is missing here (or listed here but gone from the schema), so a new policy key has to be
 * classified, and a "loosening" one given a check, before it can ship.
 */
export const POLICY_KEY_COVERAGE: Readonly<
  Record<string, { kind: "loosening" } | { kind: "not-a-loosening"; reason: string }>
> = {
  allowMajorBumps: { kind: "loosening" },
  denyPackages: { kind: "loosening" },
  allowPackages: { kind: "loosening" },
  "constraints.directDependenciesOnly": { kind: "loosening" },
  "constraints.preferVersionBump": { kind: "loosening" },
  "constraints.installMode": {
    kind: "not-a-loosening",
    reason: "How dependencies are installed (offline or fresh); every mode verifies the same way.",
  },
  "constraints.installPreferOffline": {
    kind: "not-a-loosening",
    reason: "A cache preference for installs; it does not change what may be changed.",
  },
  "constraints.enforceFrozenLockfile": { kind: "loosening" },
  "constraints.workspace": {
    kind: "not-a-loosening",
    reason: "Scopes a run to one workspace package; it picks a target, not a safety rule.",
  },
  "constraints.typecheck": { kind: "loosening" },
  "constraints.requireProofOfFix": { kind: "loosening" },
  "constraints.enableBreakingChangeRefactor": { kind: "loosening" },
  "constraints.supplyChainPolicy.minPublishAgeHours": { kind: "loosening" },
  "constraints.supplyChainPolicy.blockInstallScripts": { kind: "loosening" },
  "constraints.supplyChainPolicy.requireProvenance": { kind: "loosening" },
  "patchConfidenceThresholds.low": { kind: "loosening" },
  "patchConfidenceThresholds.medium": { kind: "loosening" },
  "patchConfidenceThresholds.high": { kind: "loosening" },
  "exploitSignalOverride.kev.mandatory": { kind: "loosening" },
  "exploitSignalOverride.epss.mandatory": { kind: "loosening" },
  "exploitSignalOverride.epss.threshold": { kind: "loosening" },
  suppressions: { kind: "loosening" },
  "sla.critical": { kind: "loosening" },
  "sla.high": { kind: "loosening" },
  "sla.medium": { kind: "loosening" },
  "sla.low": { kind: "loosening" },
  skipUnreachable: { kind: "loosening" },
  trustMaintainerVex: { kind: "loosening" },
  installScripts: { kind: "loosening" },
  "dispositionPolicy.minConfidenceForAutoApply": { kind: "loosening" },
  "dispositionPolicy.holdForTransitive": { kind: "loosening" },
  "dispositionPolicy.escalateOnKev": { kind: "loosening" },
  "dispositionPolicy.escalateOnSlaBreachSeverities": { kind: "loosening" },
  containmentMode: { kind: "loosening" },
  "escalationGraph.*": { kind: "loosening" },
  "recipes.packages": { kind: "loosening" },
  "autonomy.ceiling": { kind: "loosening" },
  "autonomy.minVerifiedRuns": { kind: "loosening" },
  "autonomy.window": { kind: "loosening" },
  "autonomy.minSuccessRate": { kind: "loosening" },
  "autonomy.cooldownDays": { kind: "loosening" },
  "autonomy.requireTestCoverage": { kind: "loosening" },
  "freshness.maxMajorsBehind": { kind: "loosening" },
  "freshness.maxMinorsBehind": { kind: "loosening" },
  "freshness.maxAgeDays": { kind: "loosening" },
  "freshness.ignore": { kind: "loosening" },
};

const levelIndex = (level: AutonomyLevel): number => AUTONOMY_LEVEL_VALUES.indexOf(level);

/** Whether the old policy's `true` protection is gone in the new one (only an explicit `true` counts as on). */
const protectionDropped = (before: boolean | undefined, after: boolean | undefined): boolean =>
  before === true && after !== true;

function listLoosenings(
  key: "denyPackages" | "allowPackages",
  before: readonly string[],
  after: readonly string[],
  out: Loosening[],
): void {
  if (key === "denyPackages") {
    for (const entry of before) {
      if (!after.includes(entry)) {
        out.push({ key, description: `"${entry}" is no longer denied, so it can be changed.` });
      }
    }
    return;
  }
  // allowPackages: an active allowlist restricts; widening or removing it permits more.
  if (before.length > 0 && after.length === 0) {
    out.push({ key, description: "The allowlist is emptied, so any package can be changed." });
    return;
  }
  if (before.length > 0) {
    for (const entry of after) {
      if (!before.includes(entry)) {
        out.push({
          key,
          description: `"${entry}" is added to the allowlist, so it can be changed.`,
        });
      }
    }
  }
}

/**
 * Every way `after` is less safe than `before`, found by comparing the two loaded policies. It is
 * deliberately one-sided: tightening is never reported, and a change that is neither (an install
 * mode, a workspace) is not a safety question. An empty result means nothing was loosened.
 *
 * Both arguments come from `loadPolicy`, so defaults are already filled in the same way.
 */
export function findLoosenings(
  before: AutoremediatorPolicy,
  after: AutoremediatorPolicy,
): Loosening[] {
  const out: Loosening[] = [];

  if (!before.allowMajorBumps && after.allowMajorBumps) {
    out.push({ key: "allowMajorBumps", description: "Major version upgrades become allowed." });
  }
  listLoosenings("denyPackages", before.denyPackages, after.denyPackages, out);
  listLoosenings("allowPackages", before.allowPackages, after.allowPackages, out);

  const bc = before.constraints ?? {};
  const ac = after.constraints ?? {};
  const switches: [BooleanConstraint, string][] = [
    ["directDependenciesOnly", "Transitive dependencies may be changed again."],
    ["preferVersionBump", "Overrides and patches are allowed where only version bumps were."],
    ["enforceFrozenLockfile", "The frozen lockfile is no longer enforced."],
    ["typecheck", "The type check after each change is no longer required."],
    ["requireProofOfFix", "Changes no longer need a passing proof of fix."],
  ];
  for (const [name, description] of switches) {
    if (protectionDropped(bc[name], ac[name])) {
      out.push({ key: `constraints.${name}`, description });
    }
  }
  if (bc.enableBreakingChangeRefactor !== true && ac.enableBreakingChangeRefactor === true) {
    out.push({
      key: "constraints.enableBreakingChangeRefactor",
      description: "Experimental codemods may rewrite source code.",
    });
  }
  const bs = bc.supplyChainPolicy ?? {};
  const as = ac.supplyChainPolicy ?? {};
  if (bs.minPublishAgeHours !== undefined && (as.minPublishAgeHours ?? 0) < bs.minPublishAgeHours) {
    out.push({
      key: "constraints.supplyChainPolicy.minPublishAgeHours",
      description: `Newly published versions are accepted sooner (${bs.minPublishAgeHours}h becomes ${as.minPublishAgeHours ?? 0}h).`,
    });
  }
  if (protectionDropped(bs.blockInstallScripts, as.blockInstallScripts)) {
    out.push({
      key: "constraints.supplyChainPolicy.blockInstallScripts",
      description: "Versions with install scripts are no longer skipped.",
    });
  }
  if (protectionDropped(bs.requireProvenance, as.requireProvenance)) {
    out.push({
      key: "constraints.supplyChainPolicy.requireProvenance",
      description: "A provenance attestation is no longer required.",
    });
  }

  const bk = before.exploitSignalOverride;
  const ak = after.exploitSignalOverride;
  if (protectionDropped(bk?.kev?.mandatory, ak?.kev?.mandatory)) {
    out.push({
      key: "exploitSignalOverride.kev",
      description: "Known-exploited (KEV) vulnerabilities are no longer mandatory.",
    });
  }
  if (protectionDropped(bk?.epss?.mandatory, ak?.epss?.mandatory)) {
    out.push({
      key: "exploitSignalOverride.epss",
      description: "High-EPSS vulnerabilities are no longer mandatory.",
    });
  } else if (bk?.epss?.threshold !== undefined && (ak?.epss?.threshold ?? 1) > bk.epss.threshold) {
    out.push({
      key: "exploitSignalOverride.epss.threshold",
      description: `The EPSS threshold rises from ${bk.epss.threshold} to ${ak?.epss?.threshold ?? "unset"}, so fewer vulnerabilities count as exploited.`,
    });
  }

  const beforeSuppressions = before.suppressions ?? [];
  for (const entry of after.suppressions ?? []) {
    const previous = beforeSuppressions.find(
      (candidate) => candidate.cveId.toUpperCase() === entry.cveId.toUpperCase(),
    );
    if (!previous) {
      out.push({
        key: "suppressions",
        description: `${entry.cveId} is suppressed (${entry.justification}${entry.expiresAt ? `, until ${entry.expiresAt}` : ", with no expiry"}).`,
      });
      continue;
    }
    const earlier = previous.expiresAt ? new Date(previous.expiresAt).getTime() : Infinity;
    const later = entry.expiresAt ? new Date(entry.expiresAt).getTime() : Infinity;
    if (later > earlier || (Number.isNaN(later) && !Number.isNaN(earlier))) {
      out.push({
        key: "suppressions",
        description: `The suppression of ${entry.cveId} lasts longer than before.`,
      });
    } else if (previous.justification !== entry.justification) {
      out.push({
        key: "suppressions",
        description: `The suppression of ${entry.cveId} changes from ${previous.justification} to ${entry.justification}.`,
      });
    }
  }

  const bsla = before.sla ?? {};
  const asla = after.sla ?? {};
  for (const severity of ["critical", "high", "medium", "low"] as const) {
    const was = bsla[severity];
    if (was !== undefined && (asla[severity] === undefined || asla[severity] > was)) {
      out.push({
        key: `sla.${severity}`,
        description: `The ${severity} deadline is ${asla[severity] === undefined ? "removed" : `${was}h becoming ${asla[severity]}h`}.`,
      });
    }
  }

  if (before.skipUnreachable !== true && after.skipUnreachable === true) {
    out.push({
      key: "skipUnreachable",
      description: "Vulnerabilities in unreachable code are skipped.",
    });
  }

  if ((before.installScripts ?? "none") !== "all" && after.installScripts === "all") {
    out.push({
      key: "installScripts",
      description: "Dependency install scripts run during installs again.",
    });
  }
  if (before.trustMaintainerVex !== true && after.trustMaintainerVex === true) {
    out.push({
      key: "trustMaintainerVex",
      description:
        "A maintainer's shipped not_affected VEX statement now suppresses a vulnerability.",
    });
  }

  for (const risk of ["low", "medium", "high"] as const) {
    const was = before.patchConfidenceThresholds?.[risk] ?? CONFIDENCE_DEFAULTS[risk];
    const now = after.patchConfidenceThresholds?.[risk] ?? CONFIDENCE_DEFAULTS[risk];
    if (now < was) {
      out.push({
        key: `patchConfidenceThresholds.${risk}`,
        description: `A ${risk}-risk patch is accepted at lower confidence (${was} becomes ${now}).`,
      });
    }
  }

  const bd = { ...DISPOSITION_DEFAULTS, ...before.dispositionPolicy };
  const ad = { ...DISPOSITION_DEFAULTS, ...after.dispositionPolicy };
  if (ad.minConfidenceForAutoApply < bd.minConfidenceForAutoApply) {
    out.push({
      key: "dispositionPolicy.minConfidenceForAutoApply",
      description: `Patches are auto-applied at lower confidence (${bd.minConfidenceForAutoApply} becomes ${ad.minConfidenceForAutoApply}).`,
    });
  }
  if (bd.holdForTransitive && !ad.holdForTransitive) {
    out.push({
      key: "dispositionPolicy.holdForTransitive",
      description: "Transitive changes are no longer held for approval.",
    });
  }
  if (bd.escalateOnKev && !ad.escalateOnKev) {
    out.push({
      key: "dispositionPolicy.escalateOnKev",
      description: "Known-exploited vulnerabilities are no longer escalated.",
    });
  }
  const dropped = bd.escalateOnSlaBreachSeverities.filter(
    (severity) => !ad.escalateOnSlaBreachSeverities.includes(severity),
  );
  if (dropped.length > 0) {
    out.push({
      key: "dispositionPolicy.escalateOnSlaBreachSeverities",
      description: `SLA breaches at ${dropped.join(", ")} are no longer escalated.`,
    });
  }

  if (before.containmentMode && !after.containmentMode) {
    out.push({
      key: "containmentMode",
      description: "Changes held for approval are no longer rolled back.",
    });
  }

  for (const reason of UNRESOLVED_REASON_VALUES) {
    const was = computeEscalationAction(reason, before.escalationGraph);
    const now = computeEscalationAction(reason, after.escalationGraph);
    if (was !== "none" && now === "none") {
      out.push({
        key: `escalationGraph.${reason}`,
        description: `"${reason}" is no longer escalated (it was ${was}).`,
      });
    }
  }

  const ba = before.autonomy;
  const aa = after.autonomy;
  const beforeCeiling = ba?.ceiling ?? IMPLICIT_CEILING;
  if (!aa) {
    if (ba) {
      out.push({
        key: "autonomy",
        description: "The autonomy ceiling is removed, so the repository is no longer capped.",
      });
    }
  } else {
    if (levelIndex(aa.ceiling) > levelIndex(beforeCeiling)) {
      out.push({
        key: "autonomy.ceiling",
        description: `The autonomy ceiling rises from ${ba ? ba.ceiling : `${IMPLICIT_CEILING} (implicit)`} to ${aa.ceiling}.`,
      });
    }
    const was = { ...AUTONOMY_DEFAULTS, ...ba };
    const now = { ...AUTONOMY_DEFAULTS, ...aa };
    if (ba) {
      for (const field of [
        "minVerifiedRuns",
        "window",
        "minSuccessRate",
        "cooldownDays",
      ] as const) {
        if (now[field] < was[field]) {
          out.push({
            key: `autonomy.${field}`,
            description: `Autonomy is earned on less evidence (${field} ${was[field]} becomes ${now[field]}).`,
          });
        }
      }
      if (was.requireTestCoverage && !now.requireTestCoverage) {
        out.push({
          key: "autonomy.requireTestCoverage",
          description: "Autonomy no longer needs runs whose tests passed.",
        });
      }
    }
  }

  const bf = before.freshness;
  const af = after.freshness;
  if (bf) {
    for (const limit of ["maxMajorsBehind", "maxMinorsBehind", "maxAgeDays"] as const) {
      const was = bf[limit];
      const now = af?.[limit];
      if (was !== undefined && (now === undefined || now > was)) {
        out.push({
          key: `freshness.${limit}`,
          description:
            now === undefined
              ? `The ${limit} limit is removed.`
              : `The ${limit} limit rises from ${was} to ${now}.`,
        });
      }
    }
    const ignored = new Set(bf.ignore);
    const added = (af?.ignore ?? []).filter((entry) => !ignored.has(entry));
    if (added.length > 0) {
      out.push({
        key: "freshness.ignore",
        description: `${added.map((entry) => `"${entry}"`).join(", ")} no longer counts towards freshness.`,
      });
    }
  }

  const trusted = new Set(before.recipes?.packages ?? []);
  for (const name of after.recipes?.packages ?? []) {
    if (!trusted.has(name)) {
      out.push({
        key: "recipes.packages",
        description: `"${name}" becomes a trusted recipe source.`,
      });
    }
  }

  return out;
}

/** Whether `after` is less safe than `before` in any way {@link findLoosenings} knows. */
export function isLoosening(before: AutoremediatorPolicy, after: AutoremediatorPolicy): boolean {
  return findLoosenings(before, after).length > 0;
}
