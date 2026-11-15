import { describe, expect, it } from "vitest";

import { AUTONOMY_DEFAULTS } from "../autonomy/types.js";
import { computeDisposition } from "../remediation/local/disposition.js";
import { findLoosenings, isLoosening } from "./policy-loosening.js";
import { loadPolicy } from "./policy.js";

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
