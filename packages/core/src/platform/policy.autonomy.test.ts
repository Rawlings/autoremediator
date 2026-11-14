import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPolicy } from "./policy.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "policy-autonomy-"));
  mkdirSync(join(dir, ".github"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const policy = (yaml: string) => {
  writeFileSync(join(dir, ".github/autoremediator.yml"), yaml);
  return () => loadPolicy(dir);
};

describe("the autonomy key of the policy file", () => {
  it("is absent by default, so the feature is off", () => {
    expect(loadPolicy(dir).autonomy).toBeUndefined();
    expect(policy("allowMajorBumps: true\n")().autonomy).toBeUndefined();
  });

  it("accepts a ceiling alone", () => {
    expect(policy("autonomy:\n  ceiling: L2\n")().autonomy).toEqual({ ceiling: "L2" });
  });

  it("accepts every setting", () => {
    const yaml = [
      "autonomy:",
      "  ceiling: L4",
      "  minVerifiedRuns: 3",
      "  window: 10",
      "  minSuccessRate: 0.8",
      "  cooldownDays: 0",
      "  requireTestCoverage: false",
    ].join("\n");
    expect(policy(`${yaml}\n`)().autonomy).toEqual({
      ceiling: "L4",
      minVerifiedRuns: 3,
      window: 10,
      minSuccessRate: 0.8,
      cooldownDays: 0,
      requireTestCoverage: false,
    });
  });

  const invalid: Array<[string, string, RegExp]> = [
    ["a missing ceiling", "autonomy:\n  window: 20\n", /autonomy\.ceiling/],
    ["an unknown level", "autonomy:\n  ceiling: L5\n", /autonomy\.ceiling/],
    ["a lower-case level", "autonomy:\n  ceiling: l2\n", /autonomy\.ceiling/],
    ["an unknown key", "autonomy:\n  ceiling: L2\n  level: L3\n", /unknown field\(s\) "level"/],
    [
      "a success rate above 1",
      "autonomy:\n  ceiling: L2\n  minSuccessRate: 1.5\n",
      /autonomy\.minSuccessRate/,
    ],
    [
      "a window too small for L4",
      "autonomy:\n  ceiling: L4\n  minVerifiedRuns: 5\n  window: 9\n",
      /window must be at least twice minVerifiedRuns/,
    ],
    [
      "zero verified runs",
      "autonomy:\n  ceiling: L2\n  minVerifiedRuns: 0\n",
      /autonomy\.minVerifiedRuns/,
    ],
    [
      "a negative cooldown",
      "autonomy:\n  ceiling: L2\n  cooldownDays: -1\n",
      /autonomy\.cooldownDays/,
    ],
    ["a non-object", "autonomy: L2\n", /autonomy/],
  ];
  for (const [name, yaml, message] of invalid) {
    it(`rejects ${name}`, () => {
      expect(policy(yaml)).toThrow(message);
    });
  }
});
