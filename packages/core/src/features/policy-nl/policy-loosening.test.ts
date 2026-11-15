import { describe, expect, it } from "vitest";

import { loadPolicy, policyFileSchema } from "../../infra/policy/policy.js";
import { UNRESOLVED_REASON_VALUES } from "../../infra/policy/schemas.js";
import { AUTONOMY_DEFAULTS } from "../autonomy/types.js";
import { DEFAULT_CONFIDENCE_THRESHOLDS } from "../patch/generate.js";
import { computeDisposition } from "../remediate/local/disposition.js";
import { findLoosenings, isLoosening, POLICY_KEY_COVERAGE } from "./policy-loosening.js";

const policy = (yaml: string) => loadPolicy(process.cwd(), `---\n${yaml}`);
const keys = (before: string, after: string) =>
  findLoosenings(policy(before), policy(after)).map((entry) => entry.key);

describe("findLoosenings / isLoosening", () => {
  it("reports nothing when the policy is unchanged or only tightened", () => {
    expect(isLoosening(policy("{}"), policy("{}"))).toBe(false);
    expect(keys("allowMajorBumps: true", "allowMajorBumps: false")).toEqual([]);
    expect(keys("denyPackages: [a]", "denyPackages: [a, b]")).toEqual([]);
    expect(keys("{}", "allowPackages: [a]")).toEqual([]);
    expect(
      keys(
        "{}",
        "constraints: { supplyChainPolicy: { blockInstallScripts: true, requireProvenance: true } }",
      ),
    ).toEqual([]);
    expect(keys("sla: { high: 72 }", "sla: { high: 24, critical: 24 }")).toEqual([]);
    expect(keys("autonomy: { ceiling: L3 }", "autonomy: { ceiling: L1 }")).toEqual([]);
    expect(keys("{}", "containmentMode: true")).toEqual([]);
  });

  it("flags major bumps, removed denies and a widened or emptied allowlist", () => {
    expect(keys("{}", "allowMajorBumps: true")).toEqual(["allowMajorBumps"]);
    expect(keys("denyPackages: [a, b]", "denyPackages: [b]")).toEqual(["denyPackages"]);
    expect(keys("denyPackages: ['@x/*']", "denyPackages: ['@x/y']")).toEqual(["denyPackages"]);
    expect(keys("allowPackages: [a]", "allowPackages: []")).toEqual(["allowPackages"]);
    expect(keys("allowPackages: [a]", "allowPackages: [a, b]")).toEqual(["allowPackages"]);
    expect(keys("allowPackages: []", "allowPackages: [a]")).toEqual([]);
  });

  it("flags constraint and supply-chain protections that are switched off or weakened", () => {
    const strict = `constraints:
  directDependenciesOnly: true
  preferVersionBump: true
  typecheck: true
  requireProofOfFix: true
  enforceFrozenLockfile: true
  supplyChainPolicy: { minPublishAgeHours: 72, blockInstallScripts: true, requireProvenance: true }`;
    expect(keys(strict, "{}").toSorted()).toEqual(
      [
        "constraints.directDependenciesOnly",
        "constraints.enforceFrozenLockfile",
        "constraints.preferVersionBump",
        "constraints.requireProofOfFix",
        "constraints.supplyChainPolicy.blockInstallScripts",
        "constraints.supplyChainPolicy.minPublishAgeHours",
        "constraints.supplyChainPolicy.requireProvenance",
        "constraints.typecheck",
      ].toSorted(),
    );
    expect(keys("{}", "constraints: { enableBreakingChangeRefactor: true }")).toEqual([
      "constraints.enableBreakingChangeRefactor",
    ]);
    expect(
      keys(
        "constraints: { supplyChainPolicy: { minPublishAgeHours: 72 } }",
        "constraints: { supplyChainPolicy: { minPublishAgeHours: 168 } }",
      ),
    ).toEqual([]);
    expect(
      keys(
        "constraints: { supplyChainPolicy: { minPublishAgeHours: 72 } }",
        "constraints: { supplyChainPolicy: { minPublishAgeHours: 24 } }",
      ),
    ).toEqual(["constraints.supplyChainPolicy.minPublishAgeHours"]);
  });

  it("flags weaker exploit signals, longer or removed deadlines and new or longer suppressions", () => {
    expect(
      keys(
        "exploitSignalOverride: { kev: { mandatory: true } }",
        "exploitSignalOverride: { kev: { mandatory: false } }",
      ),
    ).toEqual(["exploitSignalOverride.kev"]);
    expect(
      keys(
        "exploitSignalOverride: { epss: { mandatory: true, threshold: 0.3 } }",
        "exploitSignalOverride: { epss: { mandatory: true, threshold: 0.8 } }",
      ),
    ).toEqual(["exploitSignalOverride.epss.threshold"]);
    expect(keys("sla: { critical: 24 }", "sla: { critical: 48 }")).toEqual(["sla.critical"]);
    expect(keys("sla: { critical: 24 }", "{}")).toEqual(["sla.critical"]);
    expect(keys("{}", "skipUnreachable: true")).toEqual(["skipUnreachable"]);

    const suppression = (expiresAt: string, justification = "mitigated") =>
      `suppressions:\n  - { cveId: CVE-2024-1, justification: ${justification}, expiresAt: '${expiresAt}' }`;
    expect(keys("{}", suppression("2027-01-01"))).toEqual(["suppressions"]);
    expect(keys(suppression("2027-01-01"), suppression("2027-06-01"))).toEqual(["suppressions"]);
    expect(keys(suppression("2027-06-01"), suppression("2027-01-01"))).toEqual([]);
    expect(keys(suppression("2027-01-01"), "{}")).toEqual([]);
    expect(
      keys(suppression("2027-01-01", "mitigated"), suppression("2027-01-01", "not_affected")),
    ).toEqual(["suppressions"]);
  });

  it("flags weaker disposition, containment and escalation, using the pipeline's defaults", () => {
    expect(keys("{}", "dispositionPolicy: { minConfidenceForAutoApply: 0.3 }")).toEqual([
      "dispositionPolicy.minConfidenceForAutoApply",
    ]);
    expect(keys("{}", "dispositionPolicy: { minConfidenceForAutoApply: 0.9 }")).toEqual([]);
    expect(keys("{}", "dispositionPolicy: { escalateOnKev: false }")).toEqual([
      "dispositionPolicy.escalateOnKev",
    ]);
    expect(keys("{}", "dispositionPolicy: { escalateOnSlaBreachSeverities: [CRITICAL] }")).toEqual([
      "dispositionPolicy.escalateOnSlaBreachSeverities",
    ]);
    expect(keys("dispositionPolicy: { holdForTransitive: true }", "{}")).toEqual([
      "dispositionPolicy.holdForTransitive",
    ]);
    expect(keys("containmentMode: true", "containmentMode: false")).toEqual(["containmentMode"]);
    // A default action silenced is a loosening; an unset reason that never escalated is not.
    expect(keys("{}", "escalationGraph: { no-safe-version: none }")).toEqual([
      "escalationGraph.no-safe-version",
    ]);
    expect(keys("{}", "escalationGraph: { install-failed: none }")).toEqual([]);
    expect(
      keys(
        "escalationGraph: { install-failed: open-issue }",
        "escalationGraph: { install-failed: none }",
      ),
    ).toEqual(["escalationGraph.install-failed"]);
  });

  it("treats an absent autonomy key as an implicit L2 ceiling", () => {
    expect(keys("{}", "autonomy: { ceiling: L2 }")).toEqual([]);
    expect(keys("{}", "autonomy: { ceiling: L1 }")).toEqual([]);
    expect(keys("{}", "autonomy: { ceiling: L3 }")).toEqual(["autonomy.ceiling"]);
    expect(keys("autonomy: { ceiling: L1 }", "autonomy: { ceiling: L4 }")).toEqual([
      "autonomy.ceiling",
    ]);
    expect(keys("autonomy: { ceiling: L2 }", "{}")).toEqual(["autonomy"]);
    expect(
      keys(
        "autonomy: { ceiling: L3, minVerifiedRuns: 10, requireTestCoverage: true }",
        "autonomy: { ceiling: L3, minVerifiedRuns: 5, requireTestCoverage: false }",
      ).toSorted(),
    ).toEqual(["autonomy.minVerifiedRuns", "autonomy.requireTestCoverage"]);
  });

  it("flags a newly trusted recipe source", () => {
    expect(keys("{}", "recipes: { packages: [some-recipes] }")).toEqual(["recipes.packages"]);
    expect(keys("recipes: { packages: [a] }", "recipes: { packages: [a] }")).toEqual([]);
  });

  it("uses the same defaults as the code it describes", () => {
    expect(AUTONOMY_DEFAULTS).toMatchObject({
      minVerifiedRuns: 5,
      minSuccessRate: 0.9,
      cooldownDays: 7,
      requireTestCoverage: true,
    });
    // KEV escalates by default, a confidence of 0.7 is where auto-apply starts.
    expect(
      computeDisposition({ applied: true, confidence: 0.69, exploitSignalTriggered: true })
        .disposition,
    ).toBe("escalate");
    expect(computeDisposition({ applied: true, confidence: 0.69 }).disposition).toBe(
      "hold-for-approval",
    );
    expect(computeDisposition({ applied: true, confidence: 0.7 }).disposition).toBe("auto-apply");
  });
});

describe("findLoosenings: keys that used to be missed", () => {
  const cases: { name: string; before: string; after: string; keys: string[] }[] = [
    {
      name: "trusting maintainer VEX",
      before: "{}",
      after: "trustMaintainerVex: true",
      keys: ["trustMaintainerVex"],
    },
    {
      name: "running dependency install scripts again",
      before: "{}",
      after: "installScripts: all",
      keys: ["installScripts"],
    },
    {
      name: "turning install scripts off again is tighter",
      before: "installScripts: all",
      after: "{}",
      keys: [],
    },
    {
      name: "no longer trusting maintainer VEX is tighter",
      before: "trustMaintainerVex: true",
      after: "{}",
      keys: [],
    },
    {
      name: "a lower high-risk confidence threshold",
      before: "patchConfidenceThresholds: { high: 0.9 }",
      after: "patchConfidenceThresholds: { high: 0.5 }",
      keys: ["patchConfidenceThresholds.high"],
    },
    {
      name: "a threshold below the built-in default",
      before: "{}",
      after: "patchConfidenceThresholds: { low: 0.1 }",
      keys: ["patchConfidenceThresholds.low"],
    },
    {
      name: "a removed threshold that was above the default",
      before: "patchConfidenceThresholds: { medium: 0.95 }",
      after: "{}",
      keys: ["patchConfidenceThresholds.medium"],
    },
    {
      name: "a threshold raised above the default is tighter",
      before: "{}",
      after: "patchConfidenceThresholds: { high: 0.95 }",
      keys: [],
    },
    {
      name: "a threshold set to the default changes nothing",
      before: "{}",
      after: `patchConfidenceThresholds: { low: ${DEFAULT_CONFIDENCE_THRESHOLDS.low} }`,
      keys: [],
    },
    {
      name: "a smaller autonomy window",
      before: "autonomy: { ceiling: L3, window: 40 }",
      after: "autonomy: { ceiling: L3, window: 20 }",
      keys: ["autonomy.window"],
    },
    {
      name: "a window below the default",
      before: "autonomy: { ceiling: L3 }",
      after: "autonomy: { ceiling: L3, window: 12 }",
      keys: ["autonomy.window"],
    },
    {
      name: "a larger autonomy window is tighter",
      before: "autonomy: { ceiling: L3 }",
      after: "autonomy: { ceiling: L3, window: 60 }",
      keys: [],
    },
    {
      name: "more majors behind allowed",
      before: "freshness: { maxMajorsBehind: 1 }",
      after: "freshness: { maxMajorsBehind: 3 }",
      keys: ["freshness.maxMajorsBehind"],
    },
    {
      name: "more minors behind allowed",
      before: "freshness: { maxMinorsBehind: 2 }",
      after: "freshness: { maxMinorsBehind: 9 }",
      keys: ["freshness.maxMinorsBehind"],
    },
    {
      name: "older versions allowed",
      before: "freshness: { maxAgeDays: 90 }",
      after: "freshness: { maxAgeDays: 400 }",
      keys: ["freshness.maxAgeDays"],
    },
    {
      name: "a removed freshness limit",
      before: "freshness: { maxMajorsBehind: 1, maxAgeDays: 90 }",
      after: "freshness: { maxMajorsBehind: 1 }",
      keys: ["freshness.maxAgeDays"],
    },
    {
      name: "freshness removed altogether",
      before: "freshness: { maxMinorsBehind: 4 }",
      after: "{}",
      keys: ["freshness.maxMinorsBehind"],
    },
    {
      name: "a larger freshness ignore list",
      before: "freshness: { maxAgeDays: 90, ignore: [a] }",
      after: "freshness: { maxAgeDays: 90, ignore: [a, b] }",
      keys: ["freshness.ignore"],
    },
    {
      name: "an ignore list started",
      before: "freshness: { maxAgeDays: 90 }",
      after: "freshness: { maxAgeDays: 90, ignore: ['@x/*'] }",
      keys: ["freshness.ignore"],
    },
    {
      name: "tighter freshness limits",
      before: "freshness: { maxMajorsBehind: 3, maxAgeDays: 400, ignore: [a, b] }",
      after: "freshness: { maxMajorsBehind: 1, maxAgeDays: 90, ignore: [a] }",
      keys: [],
    },
    {
      name: "freshness added where there was none",
      before: "{}",
      after: "freshness: { maxMajorsBehind: 1 }",
      keys: [],
    },
    {
      name: "a new limit next to an old one",
      before: "freshness: { maxMajorsBehind: 1 }",
      after: "freshness: { maxMajorsBehind: 1, maxAgeDays: 30 }",
      keys: [],
    },
  ];
  it.each(cases)("$name", ({ before, after, keys: expected }) => {
    expect(keys(before, after)).toEqual(expected);
    expect(isLoosening(policy(before), policy(after))).toBe(expected.length > 0);
  });

  it("pins the confidence defaults it mirrors to their source", () => {
    expect(DEFAULT_CONFIDENCE_THRESHOLDS).toEqual({ low: 0.65, medium: 0.7, high: 0.8 });
  });
});

/** Every leaf path of a zod object schema, looking through optional and default wrappers (arrays are leaves). */
function leafPaths(schema: unknown, prefix = ""): string[] {
  let current = schema as {
    shape?: Record<string, unknown>;
    unwrap?: () => unknown;
    def?: { type?: string };
  };
  while (
    current.shape === undefined &&
    (current.def?.type === "optional" || current.def?.type === "default") &&
    typeof current.unwrap === "function"
  ) {
    current = current.unwrap() as typeof current;
  }
  if (current.shape === undefined) return [prefix];
  return Object.entries(current.shape).flatMap(([name, child]) =>
    leafPaths(child, prefix === "" ? name : `${prefix}.${name}`),
  );
}

describe("POLICY_KEY_COVERAGE", () => {
  const leaves = leafPaths(policyFileSchema);
  const entryFor = (path: string) =>
    Object.keys(POLICY_KEY_COVERAGE).find((key) =>
      key.endsWith(".*") ? path.startsWith(key.slice(0, -1)) : key === path,
    );

  it("classifies every key of the policy file schema, so a new key cannot skip the check", () => {
    expect(leaves.length).toBeGreaterThan(40);
    expect(leaves.filter((path) => entryFor(path) === undefined)).toEqual([]);
  });

  it("has no entry for a key the schema no longer has", () => {
    const stale = Object.keys(POLICY_KEY_COVERAGE).filter(
      (key) => !leaves.some((path) => entryFor(path) === key),
    );
    expect(stale).toEqual([]);
  });

  it("covers every escalation reason", () => {
    for (const reason of UNRESOLVED_REASON_VALUES) {
      expect(leaves).toContain(`escalationGraph.${reason}`);
    }
  });

  // One loosening per key classified as one: the classification cannot claim a check that does not exist.
  const EXAMPLES: Record<string, [before: string, after: string]> = {
    allowMajorBumps: ["{}", "allowMajorBumps: true"],
    denyPackages: ["denyPackages: [a]", "{}"],
    allowPackages: ["allowPackages: [a]", "{}"],
    "constraints.directDependenciesOnly": ["constraints: { directDependenciesOnly: true }", "{}"],
    "constraints.preferVersionBump": ["constraints: { preferVersionBump: true }", "{}"],
    "constraints.enforceFrozenLockfile": ["constraints: { enforceFrozenLockfile: true }", "{}"],
    "constraints.typecheck": ["constraints: { typecheck: true }", "{}"],
    "constraints.requireProofOfFix": ["constraints: { requireProofOfFix: true }", "{}"],
    "constraints.enableBreakingChangeRefactor": [
      "{}",
      "constraints: { enableBreakingChangeRefactor: true }",
    ],
    "constraints.supplyChainPolicy.minPublishAgeHours": [
      "constraints: { supplyChainPolicy: { minPublishAgeHours: 72 } }",
      "{}",
    ],
    "constraints.supplyChainPolicy.blockInstallScripts": [
      "constraints: { supplyChainPolicy: { blockInstallScripts: true } }",
      "{}",
    ],
    "constraints.supplyChainPolicy.requireProvenance": [
      "constraints: { supplyChainPolicy: { requireProvenance: true } }",
      "{}",
    ],
    "patchConfidenceThresholds.low": ["{}", "patchConfidenceThresholds: { low: 0.1 }"],
    "patchConfidenceThresholds.medium": ["{}", "patchConfidenceThresholds: { medium: 0.1 }"],
    "patchConfidenceThresholds.high": ["{}", "patchConfidenceThresholds: { high: 0.1 }"],
    "exploitSignalOverride.kev.mandatory": [
      "exploitSignalOverride: { kev: { mandatory: true } }",
      "{}",
    ],
    "exploitSignalOverride.epss.mandatory": [
      "exploitSignalOverride: { epss: { mandatory: true, threshold: 0.3 } }",
      "{}",
    ],
    "exploitSignalOverride.epss.threshold": [
      "exploitSignalOverride: { epss: { mandatory: false, threshold: 0.2 } }",
      "exploitSignalOverride: { epss: { mandatory: false, threshold: 0.9 } }",
    ],
    suppressions: [
      "{}",
      "suppressions: [{ cveId: CVE-2024-1, justification: fixed, expiresAt: '2027-01-01' }]",
    ],
    "sla.critical": ["sla: { critical: 24 }", "{}"],
    "sla.high": ["sla: { high: 24 }", "{}"],
    "sla.medium": ["sla: { medium: 24 }", "{}"],
    "sla.low": ["sla: { low: 24 }", "{}"],
    skipUnreachable: ["{}", "skipUnreachable: true"],
    trustMaintainerVex: ["{}", "trustMaintainerVex: true"],
    installScripts: ["{}", "installScripts: all"],
    "dispositionPolicy.minConfidenceForAutoApply": [
      "{}",
      "dispositionPolicy: { minConfidenceForAutoApply: 0.1 }",
    ],
    "dispositionPolicy.holdForTransitive": ["dispositionPolicy: { holdForTransitive: true }", "{}"],
    "dispositionPolicy.escalateOnKev": ["{}", "dispositionPolicy: { escalateOnKev: false }"],
    "dispositionPolicy.escalateOnSlaBreachSeverities": [
      "{}",
      "dispositionPolicy: { escalateOnSlaBreachSeverities: [] }",
    ],
    containmentMode: ["containmentMode: true", "{}"],
    "escalationGraph.*": ["{}", "escalationGraph: { no-safe-version: none }"],
    "recipes.packages": ["{}", "recipes: { packages: [x] }"],
    "autonomy.ceiling": ["autonomy: { ceiling: L1 }", "autonomy: { ceiling: L4 }"],
    "autonomy.minVerifiedRuns": [
      "autonomy: { ceiling: L3, minVerifiedRuns: 9 }",
      "autonomy: { ceiling: L3, minVerifiedRuns: 3 }",
    ],
    "autonomy.window": [
      "autonomy: { ceiling: L3, window: 40 }",
      "autonomy: { ceiling: L3, window: 12 }",
    ],
    "autonomy.minSuccessRate": [
      "autonomy: { ceiling: L3, minSuccessRate: 0.95 }",
      "autonomy: { ceiling: L3, minSuccessRate: 0.5 }",
    ],
    "autonomy.cooldownDays": [
      "autonomy: { ceiling: L3, cooldownDays: 14 }",
      "autonomy: { ceiling: L3, cooldownDays: 1 }",
    ],
    "autonomy.requireTestCoverage": [
      "autonomy: { ceiling: L3, requireTestCoverage: true }",
      "autonomy: { ceiling: L3, requireTestCoverage: false }",
    ],
    "freshness.maxMajorsBehind": [
      "freshness: { maxMajorsBehind: 1 }",
      "freshness: { maxMajorsBehind: 5 }",
    ],
    "freshness.maxMinorsBehind": [
      "freshness: { maxMinorsBehind: 1 }",
      "freshness: { maxMinorsBehind: 5 }",
    ],
    "freshness.maxAgeDays": ["freshness: { maxAgeDays: 30 }", "freshness: { maxAgeDays: 300 }"],
    "freshness.ignore": [
      "freshness: { maxAgeDays: 30 }",
      "freshness: { maxAgeDays: 30, ignore: [a] }",
    ],
  };

  it("has a loosening example for every key classified as one, and that example is reported", () => {
    const classified = Object.entries(POLICY_KEY_COVERAGE).filter(
      ([, entry]) => entry.kind === "loosening",
    );
    expect(Object.keys(EXAMPLES).toSorted()).toEqual(classified.map(([key]) => key).toSorted());
    const missed = Object.entries(EXAMPLES)
      .filter(([key, [before, after]]) => {
        const prefix = key.endsWith(".*") ? key.slice(0, -2) : key;
        return !keys(before, after).some(
          (entry) => `${entry}.`.startsWith(`${prefix}.`) || `${prefix}.`.startsWith(`${entry}.`),
        );
      })
      .map(([key]) => key);
    expect(missed).toEqual([]);
  });

  it("explains why a key that is not a loosening is not one", () => {
    const reasons = Object.values(POLICY_KEY_COVERAGE).flatMap((entry) =>
      entry.kind === "not-a-loosening" ? [entry.reason] : [],
    );
    expect(reasons).toHaveLength(3);
    expect(reasons.every((reason) => reason.length > 10)).toBe(true);
  });

  it("does not report a change to a key classified as not a loosening", () => {
    expect(keys("{}", "constraints: { installMode: standard }")).toEqual([]);
    expect(keys("{}", "constraints: { installPreferOffline: true, workspace: web }")).toEqual([]);
  });
});
