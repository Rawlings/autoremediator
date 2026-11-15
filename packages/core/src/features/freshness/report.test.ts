import { rmSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { orderClimbs } from "./order.js";
import { freshnessReport } from "./report.js";
import { fakeDeps, makeProject } from "./testing/fixtures.js";
import type { FreshnessClimb, FreshnessStep } from "./types.js";

// Real git repositories per test: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const project = (
  policy?: string,
  dependencies: Record<string, string> = { a: "^1.0.0" },
): string => {
  const dir = makeProject(dependencies, policy);
  dirs.push(dir);
  return dir;
};

describe("freshnessReport", () => {
  const packages = {
    // Three majors behind.
    old: {
      installed: "1.0.0",
      latest: "4.0.0",
      versions: ["1.0.0", "2.0.0", "3.0.0", "4.0.0"],
      published: { "1.0.0": "2024-06-01T00:00:00Z" },
    },
    // A minor behind.
    minor: { installed: "2.1.0", latest: "2.2.0", versions: ["2.1.0", "2.2.0"] },
    // Up to date: not reported by `outdated`, but installed.
    fresh: { installed: "5.0.0", latest: "5.0.0", versions: ["5.0.0"], current: true },
    skipped: { installed: "1.0.0", latest: "9.0.0", versions: ["1.0.0", "9.0.0"] },
    missing: { latest: "2.0.0", versions: ["2.0.0"] },
  };

  it("reports distances, age, counts and a score, worst first", async () => {
    const cwd = project("freshness:\n  maxMajorsBehind: 1\n  ignore: [skipped]\n", {});
    const report = await freshnessReport({ cwd }, fakeDeps(packages));

    expect(report.counts).toEqual({
      direct: 5,
      current: 1,
      behind: 2,
      ignored: 1,
      notInstalled: 1,
      unreadable: 0,
      exceeding: 1,
      unknownAge: 0,
    });
    expect(report.packages.map((entry) => `${entry.name}:${entry.status}`)).toEqual([
      "old:behind",
      "minor:behind",
      "fresh:current",
      "missing:not-installed",
      "skipped:ignored",
    ]);
    const old = report.packages[0]!;
    expect(old).toMatchObject({
      majorsBehind: 3,
      releasesBehind: 3,
      ageDays: 730,
      penalty: 100,
      exceeds: ["3 majors behind (limit 1)"],
    });
    // Penalties 100, 5 and 0 over the three that count: mean 35, score 65. Ignored and uninstalled do not count.
    expect(report.score).toBe(65);
    expect(report.notes.join(" ")).toMatch(/1 direct dependency is not installed/);
  });

  it("plans a climb only for packages past the policy", async () => {
    const cwd = project("freshness:\n  maxMajorsBehind: 1\n", {});
    const report = await freshnessReport({ cwd }, fakeDeps(packages));
    // `skipped` is 8 majors behind but has one release to land on, so its climb is shorter and goes first.
    expect(report.climbs.map((climb) => climb.packageName)).toEqual(["skipped", "old"]);
    expect(report.climbs[1]!.steps.map((step) => step.toVersion)).toEqual(["2.0.0", "3.0.0"]);
  });

  it("reports distances but plans nothing without a freshness policy, and says so", async () => {
    const cwd = project(undefined, {});
    const report = await freshnessReport({ cwd }, fakeDeps(packages));
    expect(report.policy).toBeNull();
    expect(report.climbs).toEqual([]);
    expect(report.counts.behind).toBe(3);
    expect(report.notes.join(" ")).toMatch(/no `freshness` key/);
  });

  it("restricts to the packages asked for, and says about one that is not a dependency", async () => {
    const cwd = project("freshness:\n  maxMajorsBehind: 0\n", {});
    const report = await freshnessReport({ cwd, packages: ["minor", "ghost"] }, fakeDeps(packages));
    expect(report.packages.map((entry) => entry.name)).toEqual(["minor"]);
    expect(report.notes.join(" ")).toMatch(/ghost is not a registry dependency/);
  });

  it("reports a package it cannot make a climb for, and keeps going", async () => {
    const cwd = project("freshness:\n  maxMajorsBehind: 0\n  maxMinorsBehind: 0\n", {});
    const report = await freshnessReport(
      { cwd },
      fakeDeps({ old: packages.old, minor: packages.minor }, { timelineFails: ["old"] }),
    );
    expect(report.climbs.map((climb) => climb.packageName)).toEqual(["minor"]);
    expect(report.unplanned).toEqual([
      {
        packageName: "old",
        reason: expect.stringMatching(/registry could not be read for old: registry exploded/),
      },
    ]);
  });

  describe("a package whose age is unknown under maxAgeDays", () => {
    const aged = {
      known: {
        installed: "1.0.0",
        latest: "1.1.0",
        versions: ["1.0.0", "1.1.0"],
        published: { "1.0.0": "2025-12-01T00:00:00Z" },
      },
      unknown: { installed: "1.0.0", latest: "1.1.0", versions: ["1.0.0", "1.1.0"] },
    };
    const AGE_POLICY = "freshness:\n  maxAgeDays: 300\n";

    it("is reported as unknown-age and left unplanned, not passed as within policy", async () => {
      const cwd = project(AGE_POLICY, {});
      const report = await freshnessReport({ cwd }, fakeDeps(aged));
      const unknown = report.packages.find((entry) => entry.name === "unknown")!;
      expect(unknown.unknownAge).toMatch(/no publish time for unknown 1\.0\.0/);
      expect(unknown.exceeds).toEqual([]);
      expect(report.packages.find((entry) => entry.name === "known")!.unknownAge).toBeUndefined();
      expect(report.counts.unknownAge).toBe(1);
      expect(report.climbs.map((climb) => climb.packageName)).toEqual([]);
      expect(report.unplanned).toEqual([
        {
          packageName: "unknown",
          reason: expect.stringMatching(/age of unknown 1\.0\.0 is unknown.*maxAgeDays/),
        },
      ]);
    });

    it("also covers a registry that could not be read", async () => {
      const cwd = project(AGE_POLICY, {});
      const report = await freshnessReport({ cwd }, fakeDeps(aged, { timelineFails: ["unknown"] }));
      expect(report.packages.find((entry) => entry.name === "unknown")!.unknownAge).toMatch(
        /registry could not be read.*registry exploded/,
      );
      expect(report.counts.unknownAge).toBe(1);
      expect(report.unplanned.map((entry) => entry.packageName)).toEqual(["unknown"]);
    });

    it("is not flagged without a maxAgeDays limit, or when the package is not behind", async () => {
      const without = project("freshness:\n  maxMajorsBehind: 5\n", {});
      expect((await freshnessReport({ cwd: without }, fakeDeps(aged))).counts.unknownAge).toBe(0);
      const cwd = project(AGE_POLICY, {});
      const current = { installed: "1.0.0", latest: "1.0.0", versions: ["1.0.0"], current: true };
      expect((await freshnessReport({ cwd }, fakeDeps({ current }))).counts.unknownAge).toBe(0);
    });
  });

  it("does not assess unless asked, and assesses once per package when asked", async () => {
    const cwd = project("freshness:\n  maxMajorsBehind: 0\n  maxMinorsBehind: 0\n", {});
    const assessed: string[] = [];
    await freshnessReport({ cwd }, fakeDeps(packages, { assessed }));
    expect(assessed).toEqual([]);
    await freshnessReport({ cwd, assess: true }, fakeDeps(packages, { assessed }));
    expect(assessed.toSorted()).toEqual([
      "minor 2.1.0->2.2.0",
      "old 1.0.0->2.0.0",
      "skipped 1.0.0->9.0.0",
    ]);
  });
});

const step = (packageName: string, level: FreshnessStep["level"]): FreshnessStep => ({
  packageName,
  field: "dependencies",
  fromVersion: "1.0.0",
  toVersion: level === "major" ? "2.0.0" : "1.1.0",
  level,
  kind: level === "major" ? "major" : "catch-up",
  index: 1,
  of: 1,
});
const climb = (
  name: string,
  level: FreshnessStep["level"],
  breakability?: "Low" | "Medium" | "High" | "Unknown",
  extra: Partial<FreshnessClimb> = {},
): FreshnessClimb => ({
  packageName: name,
  installed: "1.0.0",
  latest: "2.0.0",
  steps: [step(name, level)],
  ...(breakability ? { assessment: { breakability, summary: "" } } : {}),
  ...extra,
});

describe("orderClimbs", () => {
  it("puts the least breakable first: Low, Medium, Unknown, High", () => {
    const ordered = orderClimbs([
      climb("high", "patch", "High"),
      climb("unknown", "patch", "Unknown"),
      climb("medium", "patch", "Medium"),
      climb("low", "major", "Low"),
    ]);
    expect(ordered.map((entry) => entry.packageName)).toEqual(["low", "medium", "unknown", "high"]);
  });

  it("breaks a tie on rating by step size, then by how near the climb is to done, then by name", () => {
    const longer = {
      ...climb("c-long", "minor", "Low"),
      steps: [step("c-long", "minor"), step("c-long", "major")],
    };
    const ordered = orderClimbs([
      climb("b-major", "major", "Low"),
      climb("a-minor", "minor", "Low"),
      longer,
      climb("a-patch", "patch", "Low"),
      climb("z-minor", "minor", "Low"),
    ]);
    expect(ordered.map((entry) => entry.packageName)).toEqual([
      "a-patch",
      "a-minor",
      "z-minor",
      "c-long",
      "b-major",
    ]);
  });

  it("orders by step size alone when nothing was assessed", () => {
    const ordered = orderClimbs([climb("m", "major"), climb("p", "patch"), climb("n", "minor")]);
    expect(ordered.map((entry) => entry.packageName)).toEqual(["p", "n", "m"]);
  });

  it("puts held climbs last whatever their rating", () => {
    const held = { held: { reason: "high-breakability" as const, message: "x" } };
    const ordered = orderClimbs([
      climb("held-low", "patch", "Low", held),
      climb("ok-medium", "minor", "Medium"),
    ]);
    expect(ordered.map((entry) => entry.packageName)).toEqual(["ok-medium", "held-low"]);
  });

  it("does not change its input", () => {
    const input = [climb("b", "major"), climb("a", "patch")];
    orderClimbs(input);
    expect(input.map((entry) => entry.packageName)).toEqual(["b", "a"]);
  });
});

describe("holds", () => {
  const table = {
    risky: { installed: "1.0.0", latest: "2.0.0", versions: ["1.0.0", "2.0.0"] },
    safe: { installed: "1.0.0", latest: "1.1.0", versions: ["1.0.0", "1.1.0"] },
  };
  const assess = {
    risky: {
      breakability: "High" as const,
      score: 70,
      summary: "a removed export is called in src/a.ts.",
    },
  };

  it("holds a High step unless allowHigh, and orders it after the safe one", async () => {
    const cwd = project(
      "allowMajorBumps: true\nfreshness:\n  maxMajorsBehind: 0\n  maxMinorsBehind: 0\n",
      {},
    );
    const held = await freshnessReport({ cwd, assess: true }, fakeDeps(table, { assess }));
    expect(held.climbs.map((entry) => entry.packageName)).toEqual(["safe", "risky"]);
    expect(held.climbs[1]!.held).toEqual({
      reason: "high-breakability",
      message: expect.stringMatching(
        /a removed export is called in src\/a\.ts\. Held: pass allowHigh/,
      ),
    });

    const allowed = await freshnessReport(
      { cwd, assess: true, allowHigh: true },
      fakeDeps(table, { assess }),
    );
    expect(allowed.climbs.every((entry) => entry.held === undefined)).toBe(true);
  });

  it("holds a step that crosses a major while allowMajorBumps is off", async () => {
    const cwd = project("freshness:\n  maxMajorsBehind: 0\n", {});
    const report = await freshnessReport({ cwd }, fakeDeps(table));
    const risky = report.climbs.find((entry) => entry.packageName === "risky")!;
    expect(risky.held?.reason).toBe("major-bump-not-allowed");
    expect(risky.held?.message).toMatch(/allowMajorBumps is off/);
  });

  it("holds a step that crosses a 0.x minor while allowMajorBumps is off", async () => {
    const cwd = project("freshness:\n  maxMinorsBehind: 0\n", {});
    const report = await freshnessReport(
      { cwd },
      fakeDeps({ zero: { installed: "0.2.0", latest: "0.9.0", versions: ["0.2.0", "0.9.0"] } }),
    );
    expect(report.climbs[0]!.held?.reason).toBe("major-bump-not-allowed");
    const allowed = project("allowMajorBumps: true\nfreshness:\n  maxMinorsBehind: 0\n", {});
    const free = await freshnessReport(
      { cwd: allowed },
      fakeDeps({ zero: { installed: "0.2.0", latest: "0.9.0", versions: ["0.2.0", "0.9.0"] } }),
    );
    expect(free.climbs[0]!.held).toBeUndefined();
  });

  it("holds a step whose only newer release is deprecated", async () => {
    const cwd = project("freshness:\n  maxMinorsBehind: 0\n", {});
    const base = fakeDeps({
      dep: { installed: "3.4.0", latest: "3.5.0", versions: ["3.4.0", "3.5.0"] },
    });
    const deps = {
      ...base,
      async fetchTimeline(name: string, dir: string) {
        const timeline = await base.fetchTimeline(name, dir);
        return timeline && { ...timeline, deprecated: new Set(["3.5.0"]) };
      },
    };
    const report = await freshnessReport({ cwd }, deps);
    expect(report.climbs[0]!.held).toEqual({
      reason: "only-newer-release-deprecated",
      message: expect.stringMatching(/only newer release is deprecated/),
    });
  });

  it("holds a package the policy denies", async () => {
    const cwd = project("denyPackages: [safe]\nfreshness:\n  maxMinorsBehind: 0\n", {});
    const report = await freshnessReport({ cwd }, fakeDeps(table));
    expect(report.climbs.find((entry) => entry.packageName === "safe")?.held?.reason).toBe(
      "package-not-allowed",
    );
  });

  it("rates an upgrade it could not assess as Unknown and does not hold it", async () => {
    const cwd = project("freshness:\n  maxMinorsBehind: 0\n", {});
    const report = await freshnessReport(
      { cwd, assess: true },
      fakeDeps(table, {
        assess: {
          safe: { breakability: "Unknown", summary: "could not assess safe 1.0.0 -> 1.1.0: 404" },
        },
      }),
    );
    const safe = report.climbs.find((entry) => entry.packageName === "safe")!;
    expect(safe.assessment?.breakability).toBe("Unknown");
    expect(safe.held).toBeUndefined();
  });
});
