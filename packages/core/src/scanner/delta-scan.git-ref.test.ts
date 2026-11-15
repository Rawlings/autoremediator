import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectDependencyChanges, scanDelta } from "./delta-scan.js";

let repo: string;
let outside: string;

const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ar-delta-repo-"));
  outside = mkdtempSync(join(tmpdir(), "ar-delta-out-"));
  git("init", "-q");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", dependencies: {} }));
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("scanDelta baseRef", () => {
  it("does not let a ref act as a git option", async () => {
    const target = join(outside, "planted.txt");
    await expect(scanDelta({ cwd: repo, baseRef: `--output=${target}` })).rejects.toThrow(/not a valid git ref/);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a ref that names no commit", async () => {
    await expect(collectDependencyChanges(repo, "no-such-ref")).rejects.toThrow(/not a commit/);
  });

  it("still diffs against a branch or HEAD", async () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", dependencies: { left: "1.0.0" } }));
    const changes = await collectDependencyChanges(repo, "HEAD");
    expect(changes.dependencyChanges.map((change) => change.packageName)).toEqual(["left"]);
  });
});
