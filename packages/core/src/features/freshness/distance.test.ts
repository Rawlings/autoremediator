import { describe, expect, it } from "vitest";

import { distanceBetween, exceedsPolicy, isBehind, penaltyOf, projectScore } from "./distance.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

describe("distanceBetween", () => {
  it("counts majors, then minors only on the latest major, then patches only on the latest minor", () => {
    expect(distanceBetween({ installed: "2.5.1", latest: "5.3.9", now: NOW })).toEqual({
      majorsBehind: 3,
      minorsBehind: 0,
      patchesBehind: 0,
    });
    expect(distanceBetween({ installed: "5.1.0", latest: "5.4.2", now: NOW })).toEqual({
      majorsBehind: 0,
      minorsBehind: 3,
      patchesBehind: 0,
    });
    expect(distanceBetween({ installed: "5.4.0", latest: "5.4.7", now: NOW })).toEqual({
      majorsBehind: 0,
      minorsBehind: 0,
      patchesBehind: 7,
    });
  });

  it("is zero for a current package, and for one that is ahead of the registry", () => {
    const zero = { majorsBehind: 0, minorsBehind: 0, patchesBehind: 0 };
    expect(distanceBetween({ installed: "1.2.3", latest: "1.2.3", now: NOW })).toMatchObject(zero);
    expect(distanceBetween({ installed: "2.0.0", latest: "1.9.0", now: NOW })).toMatchObject(zero);
  });

  it("counts the stable releases between the installed and the latest version", () => {
    const published = ["1.0.0", "1.1.0", "1.2.0-beta.1", "1.2.0", "2.0.0", "2.0.1", "3.0.0-rc.1"];
    expect(
      distanceBetween({ installed: "1.1.0", latest: "2.0.1", published, now: NOW })?.releasesBehind,
    ).toBe(3);
    expect(
      distanceBetween({ installed: "2.0.1", latest: "2.0.1", published, now: NOW })?.releasesBehind,
    ).toBe(0);
  });

  it("reports the age of the installed version in whole days, and omits it without a date", () => {
    expect(
      distanceBetween({
        installed: "1.0.0",
        latest: "2.0.0",
        installedPublishedAt: daysAgo(400),
        now: NOW,
      })?.ageDays,
    ).toBe(400);
    expect(
      distanceBetween({ installed: "1.0.0", latest: "2.0.0", now: NOW })?.ageDays,
    ).toBeUndefined();
    expect(
      distanceBetween({
        installed: "1.0.0",
        latest: "2.0.0",
        installedPublishedAt: "not a date",
        now: NOW,
      })?.ageDays,
    ).toBeUndefined();
  });

  it("returns undefined for versions it cannot read", () => {
    expect(distanceBetween({ installed: "workspace", latest: "1.0.0", now: NOW })).toBeUndefined();
  });

  it("reads coerced versions such as v1.2", () => {
    expect(isBehind("v1.2", "1.3.0")).toBe(true);
  });
});

describe("exceedsPolicy", () => {
  const distance = { majorsBehind: 2, minorsBehind: 0, patchesBehind: 0, ageDays: 500 };

  it("names each limit that is passed, and none that is not", () => {
    expect(exceedsPolicy(distance, true, { maxMajorsBehind: 1, ignore: [] })).toEqual([
      "2 majors behind (limit 1)",
    ]);
    expect(
      exceedsPolicy(distance, true, { maxMajorsBehind: 2, maxAgeDays: 365, ignore: [] }),
    ).toEqual(["installed version is 500 days old (limit 365)"]);
    expect(
      exceedsPolicy({ ...distance, majorsBehind: 0, minorsBehind: 4 }, true, {
        maxMinorsBehind: 3,
        ignore: [],
      }),
    ).toEqual(["4 minors behind (limit 3)"]);
  });

  it("treats 0 as a real limit", () => {
    expect(
      exceedsPolicy({ ...distance, majorsBehind: 1 }, true, { maxMajorsBehind: 0, ignore: [] }),
    ).toHaveLength(1);
  });

  it("never flags a package that is not behind, however old its version", () => {
    expect(
      exceedsPolicy({ ...distance, majorsBehind: 0 }, false, { maxAgeDays: 1, ignore: [] }),
    ).toEqual([]);
  });

  it("flags nothing without a policy", () => {
    expect(exceedsPolicy(distance, true, undefined)).toEqual([]);
  });
});

describe("scores", () => {
  it("weights majors heavily, caps minors and patches, and never passes 100", () => {
    expect(penaltyOf({ majorsBehind: 0, minorsBehind: 0, patchesBehind: 0 })).toBe(0);
    expect(penaltyOf({ majorsBehind: 1, minorsBehind: 0, patchesBehind: 0 })).toBe(40);
    expect(penaltyOf({ majorsBehind: 0, minorsBehind: 2, patchesBehind: 0 })).toBe(10);
    expect(penaltyOf({ majorsBehind: 0, minorsBehind: 40, patchesBehind: 0 })).toBe(30);
    expect(penaltyOf({ majorsBehind: 0, minorsBehind: 0, patchesBehind: 99 })).toBe(10);
    expect(penaltyOf({ majorsBehind: 9, minorsBehind: 0, patchesBehind: 0 })).toBe(100);
  });

  it("scores the project as 100 minus the mean penalty, and 100 when nothing counts", () => {
    expect(projectScore([])).toBe(100);
    expect(projectScore([0, 0, 0, 0])).toBe(100);
    expect(projectScore([40, 0, 0, 0])).toBe(90);
    expect(projectScore([100, 100])).toBe(0);
  });
});
