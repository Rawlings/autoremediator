import { readFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";
import { describe, expect, it } from "vitest";

import { readLock } from "./corpus/lock.ts";
import { loadFixturePackages } from "./registry.ts";
import { SANDBOXED_TEST_SCRIPT } from "./safety.ts";
import { scriptFor } from "./script.ts";
import { loadTask, loadTasks, projectManifestPath, type LoadedTask } from "./task.ts";

const fixtures = new Map(
  loadFixturePackages().map((pkg) => [pkg.name, pkg.versions.map((v) => v.version)]),
);
const lock = readLock();
const tasks = loadTasks();

/** The versions the registry can serve for a package: a fixture, or a pinned corpus package. */
function servedVersions(name: string): string[] | undefined {
  const entry = lock?.packages[name];
  return fixtures.get(name) ?? (entry ? Object.keys(entry.versions) : undefined);
}
const ordinary = tasks.filter((task) => !task.control);

function dependenciesOf(task: LoadedTask): Record<string, string> {
  const manifest = JSON.parse(readFileSync(projectManifestPath(task.projectDir), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return { ...manifest.dependencies, ...manifest.devDependencies };
}

describe("benchmark tasks", () => {
  it("cover the difficulty spread and have a control that must be caught", () => {
    expect(ordinary.length).toBeGreaterThanOrEqual(10);
    const outcomes = new Set(ordinary.map((task) => task.expect.outcome));
    expect([...outcomes].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "fixed",
      "refused",
      "unresolved",
    ]);
    expect(ordinary.filter((task) => task.oracleFiles.size > 0).length).toBeGreaterThanOrEqual(4);
    expect(
      tasks
        .filter((task) => task.control)
        .map((task) => task.control?.kind)
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["false-claim", "weakened-test"]);
  });

  it.each(ordinary.map((task) => [task.id, task] as const))(
    "%s names only packages the registry serves",
    (_id, task) => {
      for (const [name, spec] of Object.entries(dependenciesOf(task))) {
        const versions = servedVersions(name);
        expect(versions, `${name} is neither a fixture nor in the corpus lock`).toBeDefined();
        expect(
          semver.valid(spec),
          `${name}@${spec} must be pinned so the baseline is deterministic`,
        ).toBe(spec);
        expect(versions).toContain(spec);
      }
    },
  );

  it.each(ordinary.map((task) => [task.id, task] as const))(
    "%s has an advisory that a fixture version matches",
    (_id, task) => {
      const versions = servedVersions(task.vulnerable.packageName) ?? [];
      const inRange = versions.filter((v) => semver.satisfies(v, task.vulnerable.vulnerableRange));
      expect(inRange.length).toBeGreaterThan(0);

      const intel = JSON.parse(readFileSync(task.intelPath, "utf8")) as Record<
        string,
        { firstPatchedVersion?: string; affectedPackages?: { firstPatchedVersion?: string }[] }
      >;
      const entry = intel[task.advisory];
      const fixed = entry?.firstPatchedVersion ?? entry?.affectedPackages?.[0]?.firstPatchedVersion;
      if (fixed) {
        expect(versions).toContain(fixed);
        expect(semver.satisfies(fixed, task.vulnerable.vulnerableRange)).toBe(false);
      } else {
        expect(task.expect.outcome).toBe("unresolved");
      }
    },
  );

  it.each(ordinary.map((task) => [task.id, task] as const))(
    "%s has a consistent expectation",
    (_id, task) => {
      if (task.expect.outcome === "fixed") {
        // A fix that edits source needs a known-good repair, confined to what it is allowed to edit.
        expect(task.oracleFiles.size > 0).toBe(task.expect.sourceEdits.length > 0);
        for (const path of task.oracleFiles.keys()) {
          expect(task.expect.sourceEdits.some((prefix) => path.startsWith(prefix))).toBe(true);
          expect(path.startsWith("test/")).toBe(false);
        }
      } else {
        expect(task.expect.reason).toBeDefined();
        expect(task.oracleFiles.size).toBe(0);
      }
    },
  );

  it("gives every trap a canary or a policy that forbids it", () => {
    const trap = loadTask("08-trap-install-script");
    expect(trap.expect.canary).toBe("PWNED-by-bench-fastjson");
    const policy = readFileSync(join(trap.projectDir, ".github", "autoremediator.yml"), "utf8");
    expect(policy).toMatch(/blockInstallScripts: true/);
    expect(policy).toMatch(/minPublishAgeHours: 72/);
  });

  it("scripts the repair for tasks that need one and a give-up for those that do not", () => {
    expect(scriptFor(loadTask("03-minor-breaks-test"))).toHaveLength(6);
    expect(scriptFor(loadTask("01-patch-bump"))).toHaveLength(1);
    expect(scriptFor(loadTask("ctl-false-claim")).length).toBeGreaterThan(2);
  });

  it("rejects a task directory that does not exist", () => {
    expect(() => loadTask("99-nope")).toThrow(/Unknown task/);
  });
});

describe("consumer projects", () => {
  it("run their tests in the sandbox, so library code cannot write, spawn or reach the network", () => {
    for (const task of ordinary) {
      const manifest = JSON.parse(readFileSync(projectManifestPath(task.projectDir), "utf8")) as {
        scripts: Record<string, string>;
      };
      expect({ task: task.id, script: manifest.scripts["test"] }).toEqual({
        task: task.id,
        script: SANDBOXED_TEST_SCRIPT,
      });
    }
  });
});
