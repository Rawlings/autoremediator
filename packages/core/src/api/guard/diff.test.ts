import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { guardGitDiff, specForChange } from "./diff.js";
import { minAgeHoursFor, type GuardDeps } from "./index.js";
import type { Packument } from "./checks.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const ago = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

const doc = (name: string): Packument => ({
  name,
  "dist-tags": { latest: "1.0.0" },
  time: { created: ago(24 * 400), "1.0.0": ago(24 * 300) },
  versions: { "1.0.0": { version: "1.0.0" } },
});

function deps(missing: string[] = []): GuardDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchPackument: async (name) => {
      asked.push(name);
      return missing.includes(name) ? undefined : doc(name);
    },
    osvIds: async () => [],
    evaluate: vi.fn(async () => ({ verdict: "safe", vulnerabilities: [] })) as never,
    now: () => NOW,
  };
}

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
const manifest = (dependencies: Record<string, string>, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "app", version: "1.0.0", dependencies, ...extra }, null, 2)}\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guard-diff-"));
  git("init", "-q", "-b", "main", ".");
  manifest({ kept: "^1.0.0" });
  git("add", ".");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("specForChange", () => {
  const change = (newVersion: string | undefined) => ({
    packageName: "pkg",
    changeType: "added" as const,
    newVersion,
    dependencyType: "dependencies" as const,
    manifestPath: "package.json",
  });
  it("turns ranges and aliases into specs, and leaves non-registry forms for the guard to flag", () => {
    expect(specForChange(change("^1.2.0"))).toEqual({ spec: "pkg@^1.2.0" });
    expect(specForChange(change("npm:other@2"))).toEqual({ spec: "pkg@npm:other@2" });
    expect(specForChange(change("github:a/b"))).toEqual({ spec: "github:a/b" });
    expect(specForChange(change("https://x.test/p.tgz"))).toEqual({ spec: "https://x.test/p.tgz" });
  });
  it("skips local protocols", () => {
    for (const version of ["workspace:*", "link:../x", "file:../x", "portal:../x", "catalog:", undefined]) {
      expect(specForChange(change(version))).toHaveProperty("skip");
    }
  });
});

describe("guardGitDiff", () => {
  it("checks only what was added or changed since the ref, and reports what it skipped", async () => {
    manifest({ kept: "^1.0.0", fresh: "^2.0.0", localdep: "workspace:*" });
    const d = deps();
    const result = await guardGitDiff({ cwd: dir, offline: true, minPublishAgeHours: 0 }, d);
    expect(d.asked).toEqual(["fresh"]);
    expect(result).toMatchObject({ checked: 1, verdict: "block" });
    expect(result.skipped).toEqual([expect.objectContaining({ packageName: "localdep" })]);
  });

  it("blocks a dependency that does not exist, and is clear when nothing changed", async () => {
    manifest({ kept: "^1.0.0", lodahs: "^1.0.0" });
    const blocked = await guardGitDiff({ cwd: dir, offline: true }, deps(["lodahs"]));
    expect(blocked.verdict).toBe("block");
    expect(blocked.reports[0]?.spec).toBe("lodahs@^1.0.0");

    git("checkout", "--", "package.json");
    const clear = await guardGitDiff({ cwd: dir, offline: true }, deps());
    expect(clear).toMatchObject({ checked: 0, verdict: "allow", reports: [] });
  });

  it("ignores removed dependencies and, by default, packages only the lockfile gained", async () => {
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/kept": { version: "1.0.0" } } }));
    git("add", ".");
    git("commit", "-q", "-m", "lock");
    manifest({});
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "node_modules/kept": { version: "1.0.0" }, "node_modules/deep": { version: "3.0.0" } } }),
    );
    const d = deps();
    expect((await guardGitDiff({ cwd: dir, offline: true }, d)).checked).toBe(0);
    const withTransitive = await guardGitDiff({ cwd: dir, offline: true, includeTransitive: true }, d);
    expect(withTransitive.reports.map((report) => report.spec)).toEqual(["deep@3.0.0"]);
  });

  it("compares a branch at the merge base, so work that landed on the base is not blamed on this branch", async () => {
    git("checkout", "-q", "-b", "feature");
    manifest({ kept: "^2.0.0", mine: "^1.0.0" });
    git("commit", "-q", "-am", "mine");
    git("checkout", "-q", "main");
    manifest({ kept: "^3.0.0" });
    git("commit", "-q", "-am", "main moved on");
    git("checkout", "-q", "feature");
    // Against the tip of main, `kept` would read as a downgrade (^3 to ^2) and be skipped; against
    // the merge base it is this branch's own upgrade (^1 to ^2).
    const result = await guardGitDiff({ cwd: dir, offline: true, baseRef: "main", minPublishAgeHours: 0 }, deps());
    expect(result.reports.map((report) => report.spec).toSorted()).toEqual(["kept@^2.0.0", "mine@^1.0.0"]);
  });

  it("refuses a ref that does not exist instead of guarding everything", async () => {
    await expect(guardGitDiff({ cwd: dir, baseRef: "no-such-ref" }, deps())).rejects.toThrow(/not a commit/);
  });
});

describe("minAgeHoursFor", () => {
  const write = (file: string, content: string) => writeFileSync(join(dir, file), content);

  it("is 72 hours with no package manager cooldown", () => {
    expect(minAgeHoursFor("pkg", { cwd: dir })).toBe(72);
  });

  it("follows a longer package manager cooldown and never goes below 72", () => {
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write("pnpm-workspace.yaml", "minimumReleaseAge: 10080\n"); // minutes: one week
    expect(minAgeHoursFor("pkg", { cwd: dir })).toBe(168);
    write("pnpm-workspace.yaml", "minimumReleaseAge: 60\n");
    expect(minAgeHoursFor("pkg", { cwd: dir })).toBe(72);
  });

  it("honours the package manager's exemptions", () => {
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write("pnpm-workspace.yaml", "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - exempt-*\n");
    expect(minAgeHoursFor("exempt-pkg", { cwd: dir })).toBe(72);
    expect(minAgeHoursFor("other", { cwd: dir })).toBe(168);
  });

  it("uses an explicit value as given, including zero", () => {
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write("pnpm-workspace.yaml", "minimumReleaseAge: 10080\n");
    expect(minAgeHoursFor("pkg", { cwd: dir, minPublishAgeHours: 0 })).toBe(0);
    expect(minAgeHoursFor("pkg", { cwd: dir, minPublishAgeHours: 24 })).toBe(24);
  });
});
