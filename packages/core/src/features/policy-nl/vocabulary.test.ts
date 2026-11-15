import { describe, expect, it } from "vitest";

import { policySchemas } from "./proposal.js";
import { findPhrase, indexRequest, isNegated } from "./request-match.js";
import { hasVocabulary, mentionsKey } from "./vocabulary.js";

describe("mentionsKey", () => {
  it("has words for every key a model may touch", () => {
    for (const key of policySchemas().keys) expect([key, hasVocabulary(key)]).toEqual([key, true]);
    expect(hasVocabulary("recipes.packages")).toBe(false);
  });

  // Words that contain a keyword without being it, and words that merely sound related.
  it.each([
    ["constraints.supplyChainPolicy.minPublishAgeHours", "the left-pad package"],
    ["constraints.supplyChainPolicy.minPublishAgeHours", "manage the pages"],
    ["constraints.supplyChainPolicy.blockInstallScripts", "describe the scriptures"],
    ["constraints.typecheck", "the typewriter"],
    ["constraints.requireProofOfFix", "that is a reproach"],
    ["constraints.enableBreakingChangeRefactor", "breakfast"],
    ["sla.critical", "allow it"],
    ["sla.low", "follow the flow"],
    ["sla", "the highlighted report"],
    ["allowMajorBumps", "the majority of packages"],
    ["exploitSignalOverride.kev", "monkeys"],
    ["suppressions", "the support team"],
    ["containmentMode", "maintain the pace"],
    ["autonomy.ceiling", "the emergency exit"],
    ["denyPackages", "a dentist"],
  ])("%s is not about %j", (key, text) => {
    expect(mentionsKey(key, "related", text)).toBe(false);
  });

  it.each([
    ["constraints.supplyChainPolicy.minPublishAgeHours", "wait 72 hours after publish"],
    ["constraints.supplyChainPolicy.blockInstallScripts", "skip packages with install scripts"],
    ["constraints.typecheck", "run the type check"],
    ["constraints.requireProofOfFix", "prove every fix"],
    ["constraints.enforceFrozenLockfile", "use a frozen lockfile"],
    ["constraints", "run the type check"],
    ["sla.critical", "fix critical findings within 24 hours"],
    ["sla", "everything within 7 days"],
    ["allowMajorBumps", "allow major upgrades"],
    ["exploitSignalOverride.kev", "KEV fixes"],
    ["suppressions", "suppress CVE-2024-12345"],
    ["containmentMode", "roll back changes held for approval"],
    ["autonomy.ceiling", "never auto-merge"],
    ["denyPackages", "do not touch left-pad"],
    ["denyPackages", "set denyPackages"],
    ["escalationGraph.no-safe-version", "open an issue when there is no safe version"],
  ])("%s is about %j", (key, text) => {
    expect(mentionsKey(key, "related", text)).toBe(true);
  });

  it("asks for different words to remove a deny entry than to add one", () => {
    expect(mentionsKey("denyPackages", "related", "never touch left-pad")).toBe(true);
    expect(mentionsKey("denyPackages", "loosen", "keep left-pad pinned")).toBe(false);
    expect(mentionsKey("denyPackages", "loosen", "unblock left-pad")).toBe(true);
    expect(mentionsKey("allowPackages", "loosen", "only lodash")).toBe(false);
    expect(mentionsKey("allowPackages", "loosen", "also include lodash")).toBe(true);
  });
});

describe("request matching", () => {
  const index = indexRequest(
    "Never allow major bumps; do not touch left-pad. Allow lodash, no longer blocked",
  );

  it("finds a phrase only as consecutive words in order", () => {
    expect(findPhrase(index, "allow major bumps")).toEqual([1]);
    expect(findPhrase(index, "Touch left-pad")).toHaveLength(1);
    expect(findPhrase(index, "major allow")).toEqual([]);
    expect(findPhrase(index, "allow bumps")).toEqual([]);
  });

  it("sees a negation inside or just before a phrase, within the same rule", () => {
    const at = (phrase: string) => {
      const [start] = findPhrase(index, phrase);
      return isNegated(index, start ?? 0, phrase.split(" ").length);
    };
    expect(at("allow major bumps")).toBe(true);
    expect(at("never allow major bumps")).toBe(true);
    // The negation belongs to the previous rule.
    expect(at("allow lodash")).toBe(false);
    // `no longer` is not a negation of what follows.
    expect(at("blocked")).toBe(false);
    expect(at("touch left-pad")).toBe(true);
  });

  it("understands contractions", () => {
    const contracted = indexRequest("We don't allow majors, and can't touch lodash");
    for (const phrase of ["allow majors", "touch lodash"]) {
      const [start] = findPhrase(contracted, phrase);
      expect([phrase, isNegated(contracted, start ?? 0, 2)]).toEqual([phrase, true]);
    }
  });
});
