import { rmSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { addMemory } from "../memory/index.js";
import { defaultRunDeps } from "../runs/deps.js";
import { applyPlan, getRun, type RunDeps } from "../runs/index.js";
import { freshnessReport } from "./report.js";
import { applyFreshness, planFreshnessStep } from "./step.js";
import { fakeDeps, makeProject, type FakePackage } from "./testing/fixtures.js";

// Real git repositories per test: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const POLICY = "allowMajorBumps: true\nfreshness:\n  maxMajorsBehind: 0\n  maxMinorsBehind: 0\n";
const project = (dependencies: Record<string, string>): string => {
  const dir = makeProject(dependencies, POLICY);
  dirs.push(dir);
  return dir;
};

const table: Record<string, FakePackage> = {
  lib: { installed: "1.0.0", latest: "1.2.0", versions: ["1.0.0", "1.1.0", "1.2.0"] },
  other: { installed: "3.0.0", latest: "3.1.0", versions: ["3.0.0", "3.1.0"] },
};

const onlyLib = { lib: table.lib! };
const onlyOther = { other: table.other! };

/** Run deps that would apply anything: a refusal must therefore come from the planner or applyPlan itself. */
const permissive = (calls: string[]): RunDeps => ({
  ...defaultRunDeps,
  async applyItem(item) {
    calls.push(`${item.packageName}->${item.toVersion}`);
    return {
      packageName: item.packageName,
      strategy: "version-bump",
      fromVersion: item.fromVersion,
      toVersion: item.toVersion,
      dryRun: false,
      applied: true,
      message: "ok",
    };
  },
  async reinstall() {},
  async verify() {
    return { passed: true, checks: [], durationMs: 0 };
  },
});

describe("freshness and remediation memory", () => {
  it("leaves a pinned package alone and says why, unless memory is ignored", async () => {
    const cwd = project({ lib: "^1.0.0", other: "^3.0.0" });
    await addMemory(cwd, {
      kind: "pinned-package",
      package: "lib",
      reason: "v1.2 drops a callback",
    });

    const report = await freshnessReport({ cwd }, fakeDeps(table));
    expect(report.climbs.map((climb) => climb.packageName)).toEqual(["other"]);
    expect(report.unplanned).toEqual([
      {
        packageName: "lib",
        reason: expect.stringMatching(/Memory pins "lib": v1\.2 drops a callback/),
      },
    ]);

    const ignoring = await freshnessReport({ cwd, ignoreMemory: true }, fakeDeps(table));
    expect(ignoring.climbs.map((climb) => climb.packageName)).toEqual(["lib", "other"].toSorted());
    expect(ignoring.unplanned).toEqual([]);
  });

  it("never plans or applies a step for a pinned package", async () => {
    const cwd = project({ lib: "^1.0.0" });
    await addMemory(cwd, { kind: "pinned-package", package: "lib", reason: "stay" });
    const plan = await planFreshnessStep({ cwd }, fakeDeps(onlyLib));
    expect(plan.planned).toBeUndefined();
    expect(plan.reason).toMatch(/memory|no climb could be made/i);

    const calls: string[] = [];
    const result = await applyFreshness({ cwd }, fakeDeps(onlyLib), permissive(calls));
    expect(result.status).toBe("nothing-to-do");
    expect(calls).toEqual([]);
  });

  it("does not propose a version a rejected-upgrade entry names, and picks the next one", async () => {
    const cwd = project({ lib: "^1.0.0" });
    await addMemory(cwd, {
      kind: "rejected-upgrade",
      package: "lib",
      toVersion: "1.2.0",
      reason: "the tests check failed after the upgrade",
    });
    const report = await freshnessReport({ cwd }, fakeDeps(onlyLib));
    expect(report.climbs[0]!.steps.map((step) => step.toVersion)).toEqual(["1.1.0"]);

    const ignoring = await freshnessReport({ cwd, ignoreMemory: true }, fakeDeps(onlyLib));
    expect(ignoring.climbs[0]!.steps.map((step) => step.toVersion)).toEqual(["1.2.0"]);
  });

  it("lists a package whose every newer release was rejected, with the reason", async () => {
    const cwd = project({ other: "^3.0.0" });
    await addMemory(cwd, {
      kind: "rejected-upgrade",
      package: "other",
      toVersion: "3.1.0",
      reason: "breaks our build",
    });
    const report = await freshnessReport({ cwd }, fakeDeps(onlyOther));
    expect(report.climbs).toEqual([]);
    expect(report.unplanned).toEqual([
      {
        packageName: "other",
        reason: expect.stringMatching(/other@3\.1\.0 was rejected earlier: breaks our build/),
      },
    ]);
  });

  it("re-checks pins when a plan is applied, and refuses before changing anything", async () => {
    const cwd = project({ other: "^3.0.0" });
    const planned = await planFreshnessStep({ cwd }, fakeDeps(onlyOther));
    expect(planned.planned).toBeDefined();
    // Pinned after the plan was made and reviewed.
    await addMemory(cwd, {
      kind: "pinned-package",
      package: "other",
      reason: "frozen for the release",
    });

    const calls: string[] = [];
    await expect(
      applyPlan({ cwd, runId: planned.planned!.runId }, permissive(calls)),
    ).rejects.toThrow(/Memory pins "other": frozen for the release/);
    expect(calls).toEqual([]);
    expect(getRun({ cwd, runId: planned.planned!.runId }).run.status).toBe("planned");
  });

  it("applies a plan made with ignoreMemory despite a pin", async () => {
    const cwd = project({ other: "^3.0.0" });
    await addMemory(cwd, { kind: "pinned-package", package: "other", reason: "frozen" });
    const planned = await planFreshnessStep({ cwd, ignoreMemory: true }, fakeDeps(onlyOther));
    expect(planned.planned).toBeDefined();
    const calls: string[] = [];
    const run = await applyPlan({ cwd, runId: planned.planned!.runId }, permissive(calls));
    expect(run.status).toBe("applied");
    expect(calls).toEqual(["other->3.1.0"]);
  });
});
