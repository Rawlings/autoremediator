import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { judge, manifestProblems } from "./oracle.ts";
import type { LoadedTask } from "./task.ts";

const baseline = {
  name: "app",
  version: "1.0.0",
  scripts: { typecheck: "tsc -p .", test: "node --test" },
  engines: { node: ">=26" },
  dependencies: { "bench-money": "1.4.0", other: "2.0.0" },
};
const edit = (change: (manifest: typeof baseline) => void): unknown => {
  const copy = structuredClone(baseline);
  change(copy);
  return copy;
};

describe("manifestProblems: only the target dependency may change in package.json", () => {
  it("accepts the target dependency bumped, and nothing else different", () => {
    const bumped = edit((m) => {
      m.dependencies["bench-money"] = "1.5.0";
    });
    expect(manifestProblems(baseline, bumped, "bench-money")).toEqual([]);
  });

  it("accepts an override for the target, flat or nested under the package that pins it", () => {
    const flat = { ...baseline, overrides: { "bench-money": "1.5.0" } };
    const nested = { ...baseline, overrides: { other: { "bench-money": "1.5.0" } } };
    expect(manifestProblems(baseline, flat, "bench-money")).toEqual([]);
    expect(manifestProblems(baseline, nested, "bench-money")).toEqual([]);
  });

  it("rejects a weakened test script (scripts.test set to true)", () => {
    const weakened = edit((m) => {
      m.scripts.test = "true";
    });
    expect(manifestProblems(baseline, weakened, "bench-money")).toEqual([
      expect.stringMatching(/scripts\.test changed/),
    ]);
  });

  it("rejects a weakened type check, a removed script and an added one", () => {
    const weakened = edit((m) => {
      m.scripts.typecheck = "true";
    });
    expect(manifestProblems(baseline, weakened, "bench-money")[0]).toMatch(/scripts\.typecheck changed/);
    const removed = edit((m) => {
      delete (m.scripts as Record<string, string>)["test"];
    });
    expect(manifestProblems(baseline, removed, "bench-money")[0]).toMatch(/scripts\.test changed/);
    const added = edit((m) => {
      (m.scripts as Record<string, string>)["pretest"] = "echo skipped";
    });
    expect(manifestProblems(baseline, added, "bench-money")[0]).toMatch(/scripts\.pretest changed/);
  });

  it("rejects a changed engines field and a changed unrelated dependency", () => {
    const engines = edit((m) => {
      m.engines.node = ">=1";
    });
    expect(manifestProblems(baseline, engines, "bench-money")[0]).toMatch(/engines/);
    const other = edit((m) => {
      m.dependencies.other = "9.9.9";
    });
    expect(manifestProblems(baseline, other, "bench-money")[0]).toMatch(/dependencies\.other changed/);
    const dropped = edit((m) => {
      delete (m.dependencies as Record<string, string>)["other"];
    });
    expect(manifestProblems(baseline, dropped, "bench-money")[0]).toMatch(/dependencies\.other changed/);
  });

  it("rejects an override for another package, and any other new field", () => {
    const override = { ...baseline, overrides: { other: "3.0.0" } };
    expect(manifestProblems(baseline, override, "bench-money")[0]).toMatch(/overrides\.other changed/);
    const extra = { ...baseline, jest: { testMatch: [] } };
    expect(manifestProblems(baseline, extra, "bench-money")[0]).toMatch(/jest\.testMatch changed/);
  });

  it("reports a manifest that cannot be read", () => {
    expect(manifestProblems(baseline, undefined, "bench-money")[0]).toMatch(/cannot be read/);
  });
});

describe("judge scores a weakened script FAIL", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });

  it("fails the scope check when the agent sets scripts.test to true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oracle-"));
    dirs.push(dir);
    git(dir, "init", "--quiet", "--initial-branch=main");
    git(dir, "config", "user.email", "t@example.test");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(baseline, null, 2)}\n`);
    git(dir, "add", "--all");
    git(dir, "commit", "--quiet", "-m", "baseline");
    const base = git(dir, "rev-parse", "HEAD").trim();

    // The "fix": the dependency is bumped, and the test script is gutted so it cannot fail.
    const weakened = structuredClone(baseline);
    weakened.dependencies["bench-money"] = "1.5.0";
    weakened.scripts.test = "true";
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(weakened, null, 2)}\n`);

    const task = {
      id: "weakened-script",
      expect: { outcome: "fixed", sourceEdits: [] },
      vulnerable: { packageName: "bench-money", vulnerableRange: "<1.5.0" },
    } as unknown as LoadedTask;
    const scratch = mkdtempSync(join(tmpdir(), "oracle-scratch-"));
    dirs.push(scratch);
    const verdict = await judge(
      task,
      { dir, baseline: base, vulnerableVersions: ["1.4.0"] },
      { claimedSuccess: true, unresolvedReasons: [] },
      scratch,
      { ...process.env, npm_config_offline: "true", npm_config_audit: "false" },
    );

    expect(verdict.score).toBe("FAIL");
    const scope = verdict.checks.find((check) => check.name === "scope");
    expect(scope?.ok).toBe(false);
    expect(scope?.detail).toMatch(/package\.json.*scripts\.test changed/s);
  });
});
