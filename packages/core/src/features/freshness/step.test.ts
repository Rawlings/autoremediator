import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AutonomyRefusedError } from "../autonomy/index.js";
import type { PatchResult } from "../remediate/types.js";
import { defaultRunDeps } from "../runs/deps.js";
import { getRun, listRuns, type RunDeps } from "../runs/index.js";
import { applyFreshness, MAX_FAILED_ATTEMPTS, planFreshnessStep, stepReport } from "./step.js";
import { fakeDeps, makeProject, type FakePackage } from "./testing/fixtures.js";

// Real git repositories per test: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const POLICY = "allowMajorBumps: true\nfreshness:\n  maxMajorsBehind: 0\n  maxMinorsBehind: 0\n";
const project = (policy: string, dependencies: Record<string, string>): string => {
  const dir = makeProject(dependencies, policy);
  dirs.push(dir);
  return dir;
};
const manifest = (dir: string): { dependencies: Record<string, string> } =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

const table: Record<string, FakePackage> = {
  // Two steps: 1.0.0 -> 1.5.0 (catch-up), then 1.5.0 -> 2.0.0.
  lib: { installed: "1.0.0", latest: "2.0.0", versions: ["1.0.0", "1.5.0", "2.0.0"] },
  other: { installed: "3.0.0", latest: "3.1.0", versions: ["3.0.0", "3.1.0"] },
};

/** Run deps that rewrite the manifest the way a real bump would, and fail the packages named. */
function runDeps(options: { failing?: string[]; calls?: string[] } = {}): RunDeps {
  return {
    ...defaultRunDeps,
    async applyItem(item, { cwd }): Promise<PatchResult> {
      options.calls?.push(`${item.packageName}->${item.toVersion}`);
      const base = {
        packageName: item.packageName,
        strategy: "version-bump" as const,
        fromVersion: item.fromVersion,
        toVersion: item.toVersion,
        dryRun: false,
      };
      if (options.failing?.includes(item.packageName)) {
        return {
          ...base,
          applied: false,
          unresolvedReason: "validation-failed",
          message: `npm test failed after upgrading "${item.packageName}" to ${item.toVersion}.`,
        };
      }
      const path = join(cwd, "package.json");
      const json = JSON.parse(readFileSync(path, "utf8")) as {
        dependencies: Record<string, string>;
      };
      json.dependencies[item.packageName] = `^${item.toVersion}`;
      writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
      // The lockfile moves with it, as an install would.
      writeFileSync(
        join(cwd, "package-lock.json"),
        `{"lockfileVersion":3,"locked":"${item.packageName}@${item.toVersion}"}\n`,
      );
      return { ...base, applied: true, message: "ok" };
    },
    async reinstall() {},
    async verify() {
      return { passed: true, checks: [], durationMs: 0 };
    },
  };
}

/** The registry table, but the dependencies and what is installed follow the project's manifest, as after each real step. */
function liveDeps(dir: string, packages: Record<string, FakePackage>, extra = {}) {
  const base = fakeDeps(packages, extra);
  return {
    ...base,
    readDirect: () =>
      Object.keys(manifest(dir).dependencies).map((name) => ({
        name,
        field: "dependencies" as const,
        range: "^1.0.0",
      })),
    async queryOutdated() {
      const current = manifest(dir).dependencies;
      const map = await base.queryOutdated("", {});
      for (const [name, info] of map) {
        const range = current[name];
        if (range === undefined) {
          map.delete(name);
          continue;
        }
        info.currentVersion = range.replace(/^\^/, "");
        if (info.currentVersion === info.latestVersion) map.delete(name);
      }
      return map;
    },
    isInstalled: () => true,
  };
}

describe("planFreshnessStep", () => {
  it("records the first step of the safest climb as a one-item plan and changes nothing", async () => {
    const cwd = project(POLICY, { lib: "^1.0.0", other: "^3.0.0" });
    const before = readFileSync(join(cwd, "package.json"), "utf8");
    const result = await planFreshnessStep({ cwd }, fakeDeps(table));

    // Equal ratings and step size: `other` is one step from done, `lib` has two.
    expect(result.planned?.step).toMatchObject({
      packageName: "other",
      fromVersion: "3.0.0",
      toVersion: "3.1.0",
      level: "minor",
    });
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(before);

    const run = getRun({ cwd, runId: result.planned!.runId });
    expect(run.run.status).toBe("planned");
    expect(run.plan?.planId).toBe(result.planned!.planId);
    expect(run.plan?.items).toEqual([
      expect.objectContaining({
        packageName: "other",
        fromVersion: "3.0.0",
        toVersion: "3.1.0",
        strategy: "version-bump",
        dependencyScope: "direct",
        cveId: "FRESHNESS-3.1.0",
      }),
    ]);
    // One plan only: applying it changes what any other plan was made against.
    expect(listRuns({ cwd })).toHaveLength(1);
  });

  it("carries runTests and typecheck into the plan so applying it runs the same checks", async () => {
    const cwd = project(POLICY, { other: "^3.0.0" });
    const result = await planFreshnessStep(
      { cwd, runTests: true, typecheck: true },
      fakeDeps(table),
    );
    const plan = getRun({ cwd, runId: result.planned!.runId }).plan!;
    expect(plan.options).toMatchObject({ runTests: true, typecheck: true });
  });

  it("restricts to --package, and records nothing when everything is within the policy", async () => {
    const cwd = project(POLICY, { lib: "^1.0.0", other: "^3.0.0" });
    const only = await planFreshnessStep({ cwd, packages: ["lib"] }, fakeDeps(table));
    expect(only.planned?.step.packageName).toBe("lib");

    const clean = project(POLICY, { other: "^3.0.0" });
    const nothing = await planFreshnessStep(
      { cwd: clean },
      fakeDeps({ other: { ...table.other!, current: true } }),
    );
    expect(nothing.planned).toBeUndefined();
    expect(nothing.reason).toMatch(/within the freshness policy/);
    expect(listRuns({ cwd: clean })).toHaveLength(0);
  });

  it("says why when there is no freshness policy, and when every step is held", async () => {
    const none = project("allowMajorBumps: true\n", { lib: "^1.0.0" });
    expect((await planFreshnessStep({ cwd: none }, fakeDeps(table))).reason).toMatch(
      /no `freshness` key/,
    );

    const cwd = project(POLICY, { lib: "^1.0.0" });
    const held = await planFreshnessStep(
      { cwd },
      fakeDeps(
        { lib: table.lib! },
        { assess: { lib: { breakability: "High", summary: "removed export is used" } } },
      ),
    );
    expect(held.planned).toBeUndefined();
    expect(held.reason).toMatch(/held/);
    expect(held.held).toEqual([
      {
        packageName: "lib",
        reason: expect.stringMatching(/removed export is used Held: pass allowHigh/),
      },
    ]);
  });

  it("records no plan at autonomy L0 (observe) and a plan at L1", async () => {
    const l0 = project(`${POLICY}autonomy:\n  ceiling: L0\n`, { other: "^3.0.0" });
    const observed = await planFreshnessStep({ cwd: l0 }, fakeDeps(table));
    expect(observed.planned).toBeUndefined();
    expect(observed.reason).toMatch(/L0 \(observe\)/);
    expect(listRuns({ cwd: l0 })).toHaveLength(0);

    const l1 = project(`${POLICY}autonomy:\n  ceiling: L1\n`, { other: "^3.0.0" });
    expect((await planFreshnessStep({ cwd: l1 }, fakeDeps(table))).planned).toBeDefined();
  });
});

describe("stepReport", () => {
  it("is named for the step, so each one has its own branch and run", () => {
    const report = stepReport(
      {
        packageName: "lib",
        field: "dependencies",
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        level: "major",
        kind: "major",
        index: 2,
        of: 3,
      },
      { breakability: "Medium", score: 20, summary: "one signature changed" },
    );
    expect(report.cveId).toBe("FRESHNESS-2.0.0");
    expect(report.results[0]).toMatchObject({
      strategy: "version-bump",
      dryRun: true,
      applied: false,
    });
    expect(report.results[0]!.message).toMatch(/step 2 of 3.*Medium: one signature changed/);
  });
});

describe("applyFreshness", () => {
  it("takes one step by default, as its own run, and leaves the rest for the next call", async () => {
    const cwd = project(POLICY, { lib: "^1.0.0", other: "^3.0.0" });
    const calls: string[] = [];
    const result = await applyFreshness({ cwd }, liveDeps(cwd, table), runDeps({ calls }));

    expect(calls).toEqual(["other->3.1.0"]);
    expect(result.status).toBe("ok");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ status: "applied", step: { packageName: "other" } });
    expect(manifest(cwd).dependencies).toEqual({ lib: "^1.0.0", other: "^3.1.0" });
    expect(result.remaining).toEqual(["lib"]);
    expect(listRuns({ cwd }).map((run) => run.status)).toEqual(["applied"]);
  });

  it("takes up to maxSteps steps, one run each, climbing a package one jump at a time", async () => {
    const cwd = project(POLICY, { lib: "^1.0.0", other: "^3.0.0" });
    const calls: string[] = [];
    const result = await applyFreshness(
      { cwd, maxSteps: 3 },
      liveDeps(cwd, table),
      runDeps({ calls }),
    );

    expect(calls).toEqual(["other->3.1.0", "lib->1.5.0", "lib->2.0.0"]);
    expect(result.status).toBe("ok");
    expect(manifest(cwd).dependencies).toEqual({ lib: "^2.0.0", other: "^3.1.0" });
    expect(new Set(result.steps.map((step) => step.runId)).size).toBe(3);
    expect(listRuns({ cwd })).toHaveLength(3);
    expect(result.remaining).toEqual([]);
  });

  it("rolls back a step that does not hold, stops that package, and moves on to the next", async () => {
    const cwd = project(POLICY, { lib: "^1.0.0", other: "^3.0.0" });
    const before = readFileSync(join(cwd, "package.json"), "utf8");
    // `lib` is tried first only if it ranks first: make `other` the failing one.
    const result = await applyFreshness(
      { cwd, maxSteps: 1 },
      liveDeps(cwd, table),
      runDeps({ failing: ["other"] }),
    );

    expect(result.status).toBe("partial");
    const failed = result.steps.find((step) => step.status === "failed")!;
    expect(failed.step.packageName).toBe("other");
    expect(failed.rolledBack).toBe(true);
    expect(failed.message).toMatch(/did not hold: npm test failed/);
    expect(getRun({ cwd, runId: failed.runId! }).run.status).toBe("rolled-back");
    expect(result.stopped).toEqual([
      { packageName: "other", reason: expect.stringMatching(/npm test failed/) },
    ]);

    // `other` is left alone, and `lib` still climbed.
    expect(manifest(cwd).dependencies.other).toBe("^3.0.0");
    expect(manifest(cwd).dependencies.lib).toBe("^1.5.0");
    expect(readFileSync(join(cwd, "package.json"), "utf8")).not.toBe(before);
    // The failed package is not retried within the same call.
    expect(result.steps.filter((step) => step.step.packageName === "other")).toHaveLength(1);
  });

  it("stops trying after MAX_FAILED_ATTEMPTS failures even with steps to spare", async () => {
    const names = ["a", "b", "c", "d", "e"];
    const packages = Object.fromEntries(
      names.map((name) => [
        name,
        { installed: "1.0.0", latest: "1.1.0", versions: ["1.0.0", "1.1.0"] },
      ]),
    );
    const cwd = project(POLICY, Object.fromEntries(names.map((name) => [name, "^1.0.0"])));
    const calls: string[] = [];
    const result = await applyFreshness(
      { cwd, maxSteps: 5 },
      liveDeps(cwd, packages),
      runDeps({ failing: names, calls }),
    );
    expect(calls).toHaveLength(MAX_FAILED_ATTEMPTS);
    expect(result.status).toBe("failed");
    expect(result.steps.every((step) => step.status === "failed" && step.rolledBack)).toBe(true);
  });

  it("does not apply a verification failure: the verifier decides, not the apply step", async () => {
    const cwd = project(POLICY, { other: "^3.0.0" });
    const deps = runDeps();
    const rejecting: RunDeps = {
      ...deps,
      async verify() {
        return {
          passed: false,
          failedCheck: "scope",
          checks: [
            {
              name: "scope",
              status: "failed",
              message: "src/index.ts changed",
              details: [],
              durationMs: 0,
            },
          ],
          durationMs: 0,
        };
      },
    };
    const result = await applyFreshness({ cwd }, liveDeps(cwd, table), rejecting);
    expect(result.status).toBe("failed");
    expect(result.steps[0]!.message).toMatch(
      /Verification failed \(scope\): src\/index\.ts changed/,
    );
    expect(manifest(cwd).dependencies.other).toBe("^3.0.0");
  });

  it("refuses below L2 before recording or changing anything", async () => {
    const cwd = project(`${POLICY}autonomy:\n  ceiling: L1\n`, { other: "^3.0.0" });
    await expect(applyFreshness({ cwd }, fakeDeps(table), runDeps())).rejects.toThrow(
      AutonomyRefusedError,
    );
    await expect(applyFreshness({ cwd }, fakeDeps(table), runDeps())).rejects.toThrow(
      /does not allow changing the project/,
    );
    expect(listRuns({ cwd })).toHaveLength(0);
    expect(manifest(cwd).dependencies.other).toBe("^3.0.0");
  });

  it("records each step in the autonomy track record when the policy opts in", async () => {
    const cwd = project(`${POLICY}autonomy:\n  ceiling: L2\n`, { other: "^3.0.0" });
    await applyFreshness({ cwd }, liveDeps(cwd, table), runDeps());
    const record = JSON.parse(
      readFileSync(join(cwd, ".autoremediator", "track-record.json"), "utf8"),
    ) as {
      events: Array<{ type: string; packages: string[] }>;
    };
    expect(record.events.map((event) => `${event.type}:${event.packages.join(",")}`)).toEqual([
      expect.stringMatching(/^applied-(un)?verified:other$/),
    ]);
  });

  it("reports nothing to do, with the reason, when every dependency is within the policy", async () => {
    const cwd = project(POLICY, { other: "^3.0.0" });
    const result = await applyFreshness(
      { cwd },
      fakeDeps({ other: { ...table.other!, current: true } }),
      runDeps(),
    );
    expect(result.status).toBe("nothing-to-do");
    expect(result.message).toMatch(/within the freshness policy/);
    expect(listRuns({ cwd })).toHaveLength(0);
  });

  it("rejects a maxSteps that is not a small whole number", async () => {
    const cwd = project(POLICY, { other: "^3.0.0" });
    await expect(applyFreshness({ cwd, maxSteps: 0 }, fakeDeps(table), runDeps())).rejects.toThrow(
      /maxSteps/,
    );
    await expect(
      applyFreshness({ cwd, maxSteps: 1.5 }, fakeDeps(table), runDeps()),
    ).rejects.toThrow(/maxSteps/);
    await expect(
      applyFreshness({ cwd, maxSteps: 500 }, fakeDeps(table), runDeps()),
    ).rejects.toThrow(/maxSteps/);
  });
});
