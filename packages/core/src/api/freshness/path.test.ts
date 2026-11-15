import { describe, expect, it } from "vitest";

import { climbSteps, type ClimbInput } from "./path.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const base = (over: Partial<ClimbInput>): ClimbInput => ({
  packageName: "lib",
  field: "dependencies",
  installed: "1.0.0",
  latest: "4.2.0",
  versions: ["1.0.0", "1.4.0", "2.0.0", "2.3.1", "3.0.0", "3.1.0", "4.0.0", "4.2.0"],
  now: NOW,
  ...over,
});
const targets = (input: ClimbInput): string[] => climbSteps(input).map((step) => step.toVersion);

describe("climbSteps", () => {
  it("catches up on the installed major first, then takes one major per step", () => {
    expect(targets(base({}))).toEqual(["1.4.0", "2.3.1", "3.1.0", "4.2.0"]);
    const steps = climbSteps(base({}));
    expect(steps.map((step) => step.level)).toEqual(["minor", "major", "major", "major"]);
    expect(steps.map((step) => step.kind)).toEqual(["catch-up", "major", "major", "major"]);
    expect(steps.map((step) => `${step.index}/${step.of}`)).toEqual(["1/4", "2/4", "3/4", "4/4"]);
    expect(steps.map((step) => step.fromVersion)).toEqual(["1.0.0", "1.4.0", "2.3.1", "3.1.0"]);
  });

  it("stops at the first step that leaves the package inside the policy", () => {
    const policy = { maxMajorsBehind: 1, ignore: [] };
    // 1.0.0 -> 1.4.0 (still 3 behind) -> 2.3.1 (2 behind) -> 3.1.0 (1 behind: allowed).
    expect(targets(base({ policy }))).toEqual(["1.4.0", "2.3.1", "3.1.0"]);
  });

  it("is one catch-up step when only minors are the problem", () => {
    expect(
      targets(
        base({
          installed: "4.0.0",
          versions: ["4.0.0", "4.1.0", "4.2.0"],
          policy: { maxMinorsBehind: 1, ignore: [] },
        }),
      ),
    ).toEqual(["4.2.0"]);
  });

  it("skips a major that has no published release", () => {
    expect(
      targets(base({ installed: "1.4.0", versions: ["1.4.0", "3.0.0", "4.0.0"], latest: "4.0.0" })),
    ).toEqual(["3.0.0", "4.0.0"]);
  });

  it("never lands on a prerelease or past the latest", () => {
    expect(
      targets(
        base({
          installed: "1.0.0",
          latest: "2.0.0",
          versions: ["1.0.0", "1.1.0-beta.1", "2.0.0", "2.1.0", "3.0.0-rc.1"],
        }),
      ),
    ).toEqual(["2.0.0"]);
  });

  it("prefers a release that is not deprecated, but uses a deprecated one when it is all there is", () => {
    expect(
      targets(
        base({
          installed: "1.0.0",
          latest: "2.0.0",
          versions: ["1.0.0", "1.1.0", "1.2.0", "2.0.0"],
          deprecated: new Set(["1.2.0"]),
        }),
      ),
    ).toEqual(["1.1.0", "2.0.0"]);
    expect(
      targets(
        base({
          installed: "1.0.0",
          latest: "1.2.0",
          versions: ["1.0.0", "1.2.0"],
          deprecated: new Set(["1.2.0"]),
        }),
      ),
    ).toEqual(["1.2.0"]);
  });

  it("applies maxAgeDays to the version a step lands on", () => {
    const published = new Map([
      ["1.0.0", "2020-01-01T00:00:00Z"],
      ["1.4.0", "2021-01-01T00:00:00Z"],
      ["2.0.0", "2026-05-01T00:00:00Z"],
    ]);
    expect(
      targets(
        base({
          installed: "1.0.0",
          latest: "2.0.0",
          versions: ["1.0.0", "1.4.0", "2.0.0"],
          published,
          policy: { maxAgeDays: 365, ignore: [] },
        }),
      ),
    ).toEqual(["1.4.0", "2.0.0"]);
  });

  it("returns no steps for a package that is current, ahead, or has nothing to land on", () => {
    expect(targets(base({ installed: "4.2.0" }))).toEqual([]);
    expect(targets(base({ installed: "5.0.0" }))).toEqual([]);
    expect(targets(base({ versions: ["1.0.0"] }))).toEqual([]);
    expect(targets(base({ installed: "not-a-version" }))).toEqual([]);
  });
});
