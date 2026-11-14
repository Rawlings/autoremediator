/**
 * Host-driven attempts: real git worktrees, the real verifier and the real promotion path. Replaced:
 * the package manager (package.json is the "install") and the project's type check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PatchResult, RemediationReport } from "../../platform/types.js";
import { defaultAttemptDeps } from "../../remediation/repair/attempt.js";
import { verify } from "../../remediation/verify/verifier.js";
import { createWorktree } from "../../runs/worktree.js";
import {
  abandonAttempt,
  finalizeAttempt,
  proposePatch,
  startAttempt,
  verifyAttempt,
} from "./attempts.js";
import type { RunDeps } from "./deps.js";
import { getRun, persistPlan, rollbackRun } from "./index.js";

vi.mock("../../remediation/tools/check-inventory.js", () => ({
  checkInventoryTool: {
    execute: vi.fn(async ({ cwd }: { cwd: string }) => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { dependencies: Record<string, string> };
      return { packages: Object.entries(manifest.dependencies).map(([name, version]) => ({ name, version, type: "direct" as const })) };
    }),
  },
}));
vi.mock("../../remediation/verify/command-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../remediation/verify/command-check.js")>()),
  runCommandCheck: vi.fn(async (_command: string[], cwd: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return readFileSync(join(cwd, "src/a.ts"), "utf8").includes("f(1);")
      ? { passed: true, output: "" }
      : { passed: false, output: "src/a.ts(2,1): error TS2554: Expected 0-1 arguments, but got 2." };
  }),
}));

let dir: string;
let cache: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const read = (file: string) => readFileSync(join(dir, file), "utf8");
const setDeps = (root: string, dependencies: Record<string, string>) =>
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", dependencies }, null, 2));

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "attempts-")));
  cache = mkdtempSync(join(tmpdir(), "attempts-cache-"));
  vi.stubEnv("XDG_CACHE_HOME", cache);
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  setDeps(dir, { dep: "1.0.0", other: "1.0.0" });
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, "src/a.ts"), "import { f } from 'dep';\nf(1, 2);\n");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  writeFileSync(join(dir, ".github/autoremediator.yml"), "allowMajorBumps: true\n");
  writeFileSync(join(dir, ".gitignore"), ".autoremediator\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

/** The advisory affects exactly the packages the plan covers. */
const advisoryFor = (packages: string[]) => ({
  id: "CVE-2021-0001",
  summary: "",
  severity: "HIGH" as const,
  references: [],
  affectedPackages: packages.map((name) => ({
    name,
    ecosystem: "npm" as const,
    vulnerableRange: "<2.0.0",
    firstPatchedVersion: "2.0.0",
    source: "osv" as const,
  })),
});
const preview = (...packages: string[]): RemediationReport => ({
  cveId: "CVE-2021-0001",
  cveDetails: advisoryFor(packages),
  vulnerablePackages: [],
  summary: "preview",
  results: packages.map((packageName) => ({
    packageName,
    strategy: "version-bump" as const,
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    applied: false,
    dryRun: true,
    message: "planned",
    dependencyScope: "direct" as const,
  })),
});

const upgrade = (item: { packageName: string }): PatchResult => ({
  packageName: item.packageName, strategy: "version-bump", fromVersion: "1.0.0", toVersion: "2.0.0", applied: true, dryRun: false, message: "ok",
});

const deps = (): RunDeps => ({
  applyItem: async () => { throw new Error("not used"); },
  reinstall: vi.fn(async () => undefined),
  verify: (request) => verify(request),
  attempt: async () => { throw new Error("not used"); },
  attemptDeps: {
    ...defaultAttemptDeps,
    createWorktree: (cwd, name) => createWorktree(cwd, name, { XDG_CACHE_HOME: cache }),
    applyUpgrade: async (item, checkout) => {
      const manifest = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as { dependencies: Record<string, string> };
      manifest.dependencies[item.packageName] = "2.0.0";
      setDeps(checkout, manifest.dependencies);
      return upgrade(item);
    },
  },
});

const fix = (worktree: string) => writeFileSync(join(worktree, "src/a.ts"), "import { f } from 'dep';\nf(1);\n");
const fixPatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " import { f } from 'dep';",
  "-f(1, 2);",
  "+f(1);",
  "",
].join("\n");

const plan = (...packages: string[]) => persistPlan(preview(...packages), { typecheck: true, runTests: true }, dir);
const itemOf = (runId: string, name: string) => getRun({ cwd: dir, runId }).plan!.items.find((item) => item.packageName === name)!.itemId;

describe("host-driven attempts", () => {
  it("opens an isolated checkout with the upgrade applied and says what is broken", async () => {
    const { runId } = await plan("dep");
    const view = await startAttempt({ cwd: dir, runId, itemId: itemOf(runId, "dep") }, deps());

    expect(view).toMatchObject({ status: "open", runId });
    expect(view.attemptId).toMatch(/^attempt_[0-9a-z]{12}$/);
    expect(view.worktreePath).toBeDefined();
    expect(view.worktreePath!.startsWith(dir)).toBe(false);
    expect(readFileSync(join(view.worktreePath!, "package.json"), "utf8")).toContain('"dep": "2.0.0"');
    expect(view.verification?.passed).toBe(false);
    expect(view.failure).toMatchObject({ failedCheck: "typecheck" });
    expect(view.failure?.details[0]).toContain("TS2554");
    // The project is untouched, and the attempt is on record.
    expect(read("package.json")).toContain('"dep": "1.0.0"');
    expect(getRun({ cwd: dir, runId }).attempts).toMatchObject([{ attemptId: view.attemptId, status: "open", agentId: "host" }]);
    await abandonAttempt({ cwd: dir, runId, attemptId: view.attemptId });
  });

  it("lets the host edit the checkout directly, verify, finalize, and later roll back", async () => {
    const { runId } = await plan("dep", "other");
    const deps_ = deps();
    const opened = await startAttempt({ cwd: dir, runId, itemId: itemOf(runId, "dep") }, deps_);
    fix(opened.worktreePath!);

    const checked = await verifyAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps_);
    expect(checked.verification?.passed).toBe(true);
    expect(checked.failure).toBeUndefined();

    const done = await finalizeAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps_);
    expect(done).toMatchObject({ finalized: true, status: "promoted" });
    expect(read("src/a.ts")).toBe("import { f } from 'dep';\nf(1);\n");
    expect(read("package.json")).toContain('"dep": "2.0.0"');
    expect(existsSync(opened.worktreePath!)).toBe(false);
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);

    const details = getRun({ cwd: dir, runId });
    expect(details.run).toMatchObject({ status: "partial", allowSourceEdits: true }); // "other" is still pending
    expect(details.items[0]).toMatchObject({ packageName: "dep", status: "applied" });
    expect(details.attempts[0]).toMatchObject({ status: "promoted" });
    expect(details.ledger.ok).toBe(true);

    await rollbackRun({ cwd: dir, runId }, deps_);
    expect(read("src/a.ts")).toBe("import { f } from 'dep';\nf(1, 2);\n");
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  it("completes the run when the last item is finalized", async () => {
    const { runId } = await plan("dep");
    const deps_ = deps();
    const opened = await startAttempt({ cwd: dir, runId, itemId: itemOf(runId, "dep") }, deps_);
    fix(opened.worktreePath!);
    await finalizeAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps_);
    expect(getRun({ cwd: dir, runId }).run.status).toBe("applied");
  });

  it("accepts a patch from the host, applied to the checkout", async () => {
    const { runId } = await plan("dep");
    const deps_ = deps();
    const opened = await startAttempt({ cwd: dir, runId, itemId: itemOf(runId, "dep") }, deps_);

    const proposed = await proposePatch({ cwd: dir, runId, attemptId: opened.attemptId, diff: fixPatch });

    expect(proposed.changedFiles).toEqual(["src/a.ts"]);
    expect(readFileSync(join(opened.worktreePath!, "src/a.ts"), "utf8")).toContain("f(1);");
    expect(read("src/a.ts")).toContain("f(1, 2);");
    expect((await verifyAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps_)).verification?.passed).toBe(true);
    await abandonAttempt({ cwd: dir, runId, attemptId: opened.attemptId });
  });

  it("refuses patches that change what a host may not", async () => {
    const { runId } = await plan("dep");
    const opened = await startAttempt({ cwd: dir, runId, itemId: itemOf(runId, "dep") }, deps());
    const propose = (diff: string) => proposePatch({ cwd: dir, runId, attemptId: opened.attemptId, diff });
    const file = (name: string, body: string[]) =>
      [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, ...body, ""].join("\n");

    await expect(propose(file("package.json", ["@@ -1,1 +1,1 @@", "-{", "+{ "]))).rejects.toThrow(/Patch refused/);
    await expect(propose(file(".github/workflows/ci.yml", ["@@ -0,0 +1 @@", "+on: push"]))).rejects.toThrow(/Patch refused|does not apply/);
    await expect(propose(file("README.md", ["@@ -0,0 +1 @@", "+hi"]))).rejects.toThrow(/Patch refused/);
    await expect(propose("diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n")).rejects.toThrow(/file mode/);
    await expect(propose("diff --git a/x b/y\nrename from x\nrename to y\n")).rejects.toThrow(/renames/);
    await expect(propose("GIT binary patch\nliteral 1\n")).rejects.toThrow(/binary/);
    await expect(propose("   \n")).rejects.toThrow(/empty/);
    await expect(propose("this is not a diff")).rejects.toThrow(/valid unified diff|changes no files/);
    await expect(propose("x".repeat(250_000))).rejects.toThrow(/larger than/);
    // A patch for text the checkout does not have.
    const stale = file("src/a.ts", ["@@ -1,2 +1,2 @@", " something else", "-f(9);", "+f(1);"]);
    await expect(propose(stale)).rejects.toThrow(/does not apply/);

    expect(readFileSync(join(opened.worktreePath!, "package.json"), "utf8")).toContain("2.0.0");
    await abandonAttempt({ cwd: dir, runId, attemptId: opened.attemptId });
  });

  it("does not finalize something that does not verify, and leaves the attempt open", async () => {
    const { runId } = await plan("dep");
    const deps_ = deps();
    const opened = await startAttempt({ cwd: dir, runId, itemId: itemOf(runId, "dep") }, deps_);

    const result = await finalizeAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps_);

    expect(result).toMatchObject({ finalized: false, status: "open" });
    expect(result.failure?.failedCheck).toBe("typecheck");
    expect(read("package.json")).toContain('"dep": "1.0.0"');
    expect(existsSync(opened.worktreePath!)).toBe(true);
    await abandonAttempt({ cwd: dir, runId, attemptId: opened.attemptId });
  });

  it("will not finalize a change that sneaks in something out of scope", async () => {
    const { runId } = await plan("dep");
    const deps_ = deps();
    const opened = await startAttempt({ cwd: dir, runId, itemId: itemOf(runId, "dep") }, deps_);
    fix(opened.worktreePath!);
    mkdirSync(join(opened.worktreePath!, ".github/workflows"), { recursive: true });
    writeFileSync(join(opened.worktreePath!, ".github/workflows/ci.yml"), "on: push\n");

    const result = await finalizeAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps_);

    expect(result.finalized).toBe(false);
    expect(result.verification?.failedCheck).toBe("scope");
    expect(existsSync(join(dir, ".github/workflows"))).toBe(false);
    await abandonAttempt({ cwd: dir, runId, attemptId: opened.attemptId });
  });

  it("abandons an attempt cleanly", async () => {
    const { runId } = await plan("dep");
    const opened = await startAttempt({ cwd: dir, runId, itemId: itemOf(runId, "dep") }, deps());
    const closed = await abandonAttempt({ cwd: dir, runId, attemptId: opened.attemptId });

    expect(closed.status).toBe("abandoned");
    expect(existsSync(opened.worktreePath!)).toBe(false);
    await expect(verifyAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps())).rejects.toThrow(/abandoned/);
    await expect(abandonAttempt({ cwd: dir, runId, attemptId: opened.attemptId })).rejects.toThrow(/abandoned/);
  });

  it("limits how many attempts can be open at once", async () => {
    const { runId } = await plan("dep");
    const itemId = itemOf(runId, "dep");
    const opened = [] as string[];
    for (let i = 0; i < 4; i++) opened.push((await startAttempt({ cwd: dir, runId, itemId }, deps())).attemptId);
    await expect(startAttempt({ cwd: dir, runId, itemId }, deps())).rejects.toThrow(/4 open attempts/);
    for (const attemptId of opened) await abandonAttempt({ cwd: dir, runId, attemptId });
  });

  it("refuses to start, or finalize, once the project has moved on", async () => {
    const { runId } = await plan("dep");
    const itemId = itemOf(runId, "dep");
    const deps_ = deps();
    const opened = await startAttempt({ cwd: dir, runId, itemId }, deps_);
    fix(opened.worktreePath!);
    setDeps(dir, { dep: "1.0.0", other: "1.0.0", extra: "1.0.0" });

    await expect(finalizeAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps_)).rejects.toThrow(/changed since/);
    await expect(startAttempt({ cwd: dir, runId, itemId }, deps_)).rejects.toThrow(/Plan again/);
    await abandonAttempt({ cwd: dir, runId, attemptId: opened.attemptId });
  });

  it("knows nothing it should not: unknown items and attempts, bad states", async () => {
    const { runId } = await plan("dep");
    await expect(startAttempt({ cwd: dir, runId, itemId: "item_000000000000" }, deps())).rejects.toThrow(/no plan item/);
    await expect(verifyAttempt({ cwd: dir, runId, attemptId: "attempt_000000000000" }, deps())).rejects.toThrow(/not found/);
  });

  it("survives the process that started it: another can finalize the attempt", async () => {
    const { runId } = await plan("dep");
    const opened = await startAttempt({ cwd: dir, runId, itemId: itemOf(runId, "dep") }, deps());
    fix(opened.worktreePath!);

    vi.resetModules();
    const fresh = await import("./attempts.js");
    const done = await fresh.finalizeAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps());

    expect(done.finalized).toBe(true);
    expect(read("src/a.ts")).toContain("f(1);");
  });
});
