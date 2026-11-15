import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getRun } from "../runs/index.js";
import { worktreeRoot } from "../runs/worktree.js";
import { parseLockfileDependencies } from "../scan/lockfile-diff.js";
import { bisectLockfile } from "./index.js";
import { FakeRegistry } from "./testing/fake-registry.js";

/**
 * Real git, real package managers, a fake registry on 127.0.0.1: no network. A lockfile is made while
 * only the old releases exist, new releases are "published", the lockfile is regenerated, and
 * `bisect` has to find which new release breaks the command.
 */

type Manager = "npm" | "pnpm";

let scratch: string;
const registries: Record<string, FakeRegistry> = {};
const repos: Record<string, { dir: string; good: string; bad: string }> = {};

const GIT = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

/** The checks the commands under test run: which versions are installed under `mid`. */
const CHECK_JS = `
const path = require("node:path");
const fs = require("node:fs");
const base = path.dirname(require.resolve("mid"));
const version = (name) =>
  JSON.parse(fs.readFileSync(require.resolve(name + "/package.json", { paths: [base] }), "utf8")).version;
const direct = JSON.parse(fs.readFileSync(require.resolve("direct-lib/package.json"), "utf8")).version;
const mode = process.argv[2];
const fail = (why) => { console.error("FAIL: " + why + " token=ghp_" + "a".repeat(30)); process.exit(1); };
if (mode === "single" && version("leaf-b") === "1.1.0") fail("leaf-b@1.1.0 is broken: TypeError: x is not a function");
if (mode === "pair" && version("leaf-a") === "1.0.1" && version("leaf-c") === "2.0.1") fail("leaf-a@1.0.1 and leaf-c@2.0.1 disagree");
if (mode === "direct" && direct === "1.0.1") fail("direct-lib@1.0.1 is broken");
if (mode === "hang" && version("leaf-b") === "1.1.0") {
  fs.writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1000);
} else {
  console.log("ok " + version("leaf-b"));
}
`;

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const result = await execa(cmd, args, { cwd, env: { ...process.env, ...GIT }, all: true });
  return result.all ?? "";
}

async function makeRepo(
  manager: Manager,
  registry: FakeRegistry,
): Promise<{ dir: string; good: string; bad: string }> {
  const dir = join(scratch, `${manager}-repo`);
  mkdirSync(dir, { recursive: true });
  await run("git", ["init", "--quiet", "--initial-branch=main"], dir);
  writeFileSync(join(dir, ".npmrc"), `registry=${registry.url}/\n`);
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.autoremediator\n");
  writeFileSync(join(dir, "check.js"), CHECK_JS);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "app", version: "1.0.0", private: true, dependencies: { mid: "^1.0.0", "direct-lib": "^1.0.0" } }, null, 2)}\n`,
  );
  const install = (): Promise<string> =>
    manager === "npm"
      ? run("npm", ["install", "--no-audit", "--no-fund"], dir)
      : run("pnpm", ["install", "--no-frozen-lockfile"], dir);
  const lockfile = manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";

  await install();
  await run("git", ["add", "--all"], dir);
  await run("git", ["commit", "--quiet", "-m", "good: old releases locked"], dir);
  const good = (await run("git", ["rev-parse", "HEAD"], dir)).trim();

  // The registry now has newer releases; a fresh resolution picks them all up.
  for (const [name, version] of [
    ["leaf-a", "1.0.1"],
    ["leaf-b", "1.1.0"],
    ["leaf-c", "2.0.1"],
    ["leaf-d", "1.0.1"],
    ["direct-lib", "1.0.1"],
  ] as const) {
    await registry.publish({ name, version });
  }
  rmSync(join(dir, lockfile));
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  await install();
  await run("git", ["add", "--all"], dir);
  await run("git", ["commit", "--quiet", "-m", "bad: lockfile regenerated"], dir);
  const bad = (await run("git", ["rev-parse", "HEAD"], dir)).trim();

  const before = parseLockfileDependencies(
    lockfile,
    await run("git", ["show", `${good}:${lockfile}`], dir),
  );
  const after = parseLockfileDependencies(
    lockfile,
    await run("git", ["show", `${bad}:${lockfile}`], dir),
  );
  expect([...(after.get("leaf-b") ?? [])]).toEqual(["1.1.0"]);
  expect([...(before.get("leaf-b") ?? [])]).toEqual(["1.0.0"]);
  return { dir, good, bad };
}

async function clone(source: string, name: string): Promise<string> {
  const dir = join(scratch, name);
  await run("git", ["clone", "--quiet", source, dir], scratch);
  return dir;
}

async function worktreeLines(dir: string): Promise<string[]> {
  return (await run("git", ["worktree", "list"], dir)).trim().split("\n");
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "bisect-e2e-"));
  // Package managers and git run with everything private to this test.
  for (const name of Object.keys(process.env)) {
    if (/^(npm_|NPM_|PNPM_|INIT_CWD$)/.test(name)) vi.stubEnv(name, undefined as unknown as string);
  }
  vi.stubEnv("npm_config_cache", join(scratch, "npm-cache"));
  vi.stubEnv("npm_config_store_dir", join(scratch, "pnpm-store"));
  vi.stubEnv("npm_config_userconfig", join(scratch, "no-npmrc"));
  vi.stubEnv("XDG_CACHE_HOME", join(scratch, "xdg-cache"));
  vi.stubEnv("XDG_DATA_HOME", join(scratch, "xdg-data"));
  for (const [key, value] of Object.entries(GIT)) vi.stubEnv(key, value);

  for (const manager of ["npm", "pnpm"] as const) {
    // One registry per manager: each starts with only the old releases, so each lockfile starts old.
    const registry = new FakeRegistry();
    registries[manager] = registry;
    await registry.start();
    const old: Array<[string, string]> = [
      ["leaf-a", "1.0.0"],
      ["leaf-b", "1.0.0"],
      ["leaf-c", "2.0.0"],
      ["leaf-d", "1.0.0"],
      ["direct-lib", "1.0.0"],
    ];
    for (const [name, version] of old) {
      await registry.publish({
        name,
        version,
        files: { "index.js": `module.exports = ${JSON.stringify(`${name}@${version}`)};\n` },
      });
    }
    await registry.publish({
      name: "mid",
      version: "1.0.0",
      dependencies: {
        "leaf-a": "^1.0.0",
        "leaf-b": "^1.0.0",
        "leaf-c": "^2.0.0",
        "leaf-d": "^1.0.0",
      },
    });
    repos[manager] = await makeRepo(manager, registry);
  }
}, 180_000);

afterAll(async () => {
  await Promise.all(Object.values(registries).map((registry) => registry.stop()));
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const LOCKFILE: Record<Manager, string> = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml" };
const FROZEN_INSTALL: Record<Manager, string> = {
  npm: "npm ci",
  pnpm: "pnpm install --frozen-lockfile",
};

describe.each(["npm", "pnpm"] as const)("bisect with real %s and a local registry", (manager) => {
  it("finds the one transitive update that breaks the command", async () => {
    const repo = repos[manager]!;
    const report = await bisectLockfile({
      cwd: repo.dir,
      good: repo.good,
      command: "node check.js single",
    });

    expect(report.status).toBe("culprit");
    expect(report.culprits).toEqual([
      {
        packageName: "leaf-b",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        dependencyScope: "transitive",
      },
    ]);
    expect(report.updates.map((item) => item.packageName)).toEqual([
      "direct-lib",
      "leaf-a",
      "leaf-b",
      "leaf-c",
      "leaf-d",
    ]);
    expect(report.holdingBackFixes).toBe(true);
    expect(report.packageManager).toBe(manager);
    expect(report.lockfile).toBe(LOCKFILE[manager]);

    // Evidence: the good ref passed, the bad ref failed with the output, every step recorded.
    expect(report.steps[0]).toMatchObject({ kind: "good-ref", outcome: "pass", phase: "command" });
    expect(report.steps[0]?.install?.command).toContain(FROZEN_INSTALL[manager]);
    expect(report.steps[1]).toMatchObject({ kind: "bad-ref", outcome: "fail", phase: "command" });
    expect(report.steps[1]?.run?.exitCode).toBe(1);
    expect(report.steps[1]?.outputTail).toContain("leaf-b@1.1.0 is broken");
    expect(report.steps[1]?.run?.durationMs).toBeGreaterThan(0);
    // Credentials in the output do not reach the report.
    expect(JSON.stringify(report)).not.toContain("ghp_");
    expect(report.steps[1]?.outputTail).toContain("[redacted]");
    expect(report.steps.map((step) => step.kind)).toContain("subset");
    expect(report.stepsUsed).toBeLessThanOrEqual(8);

    // The remedy is a plan in the run store that pins the package back; nothing was applied.
    expect(report.remedy?.pins).toEqual([
      { packageName: "leaf-b", version: "1.0.0", strategy: "override" },
    ]);
    expect(report.remedy?.runId).toBeDefined();
    expect(report.remedy?.applied).toBeUndefined();
    const details = getRun({ cwd: repo.dir, runId: report.remedy?.runId ?? "" });
    expect(details.run.status).toBe("planned");
    expect(details.plan?.items).toMatchObject([
      {
        packageName: "leaf-b",
        fromVersion: "1.1.0",
        toVersion: "1.0.0",
        strategy: "override",
        dependencyScope: "transitive",
      },
    ]);

    // The main checkout is as it was, and no checkout is left behind.
    expect((await run("git", ["status", "--porcelain"], repo.dir)).trim()).toBe("");
    await expect(worktreeLines(repo.dir)).resolves.toHaveLength(1);
    const root = worktreeRoot(
      await run("git", ["rev-parse", "--show-toplevel"], repo.dir).then((text) => text.trim()),
    );
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  }, 240_000);

  it("reports the smallest set of updates that fail only together", async () => {
    const repo = repos[manager]!;
    const report = await bisectLockfile({
      cwd: repo.dir,
      good: repo.good,
      command: "node check.js pair",
    });
    expect(report.status).toBe("culprit-set");
    expect(report.culprits.map((item) => item.packageName).toSorted()).toEqual([
      "leaf-a",
      "leaf-c",
    ]);
    expect(report.holdingBackFixes).toBe(true);
    expect(report.remedy?.pins.map((pin) => pin.packageName).toSorted()).toEqual([
      "leaf-a",
      "leaf-c",
    ]);
  }, 240_000);

  it("finds a direct dependency and applies the pin when asked, through the run machinery", async () => {
    const repo = repos[manager]!;
    const dir = await clone(repo.dir, `${manager}-apply`);
    const report = await bisectLockfile({
      cwd: dir,
      good: repo.good,
      command: "node check.js direct",
      apply: true,
    });
    expect(report.status).toBe("culprit");
    expect(report.culprits).toMatchObject([
      { packageName: "direct-lib", dependencyScope: "direct" },
    ]);
    expect(report.remedy?.pins).toEqual([
      { packageName: "direct-lib", version: "1.0.0", strategy: "version-bump" },
    ]);
    expect(report.remedy?.applied).toMatchObject({ effective: true, status: "applied" });

    const lock = parseLockfileDependencies(
      LOCKFILE[manager],
      readFileSync(join(dir, LOCKFILE[manager]), "utf8"),
    );
    expect([...(lock.get("direct-lib") ?? [])]).toEqual(["1.0.0"]);
    // A direct dependency is pinned to the exact version: a range would keep the newer lock entry.
    expect(
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["direct-lib"],
    ).toBe("1.0.0");
    expect((await run("node", ["check.js", "direct"], dir)).trim()).toBe("ok 1.1.0");
  }, 240_000);
});

describe("bisect with real pnpm: applying a transitive pin", () => {
  it("checks the lockfile after applying and says so when the override was not honoured", async () => {
    const repo = repos["pnpm"]!;
    const dir = await clone(repo.dir, "pnpm-apply-transitive");
    const report = await bisectLockfile({
      cwd: dir,
      good: repo.good,
      command: "node check.js single",
      apply: true,
    });
    expect(report.status).toBe("culprit");
    const applied = report.remedy?.applied;
    const lock = parseLockfileDependencies(
      "pnpm-lock.yaml",
      readFileSync(join(dir, "pnpm-lock.yaml"), "utf8"),
    );
    // Whatever the existing override step did, the report agrees with the lockfile.
    expect(applied?.effective).toBe([...(lock.get("leaf-b") ?? [])].join() === "1.0.0");
    if (!applied?.effective) expect(applied?.note).toContain("pnpm-workspace.yaml");
  }, 240_000);
});

describe("bisect with real npm: failure modes", () => {
  it("kills a command that hangs, counts it as failing, and leaves no process behind", async () => {
    const repo = repos["npm"]!;
    const pidFile = join(scratch, "hang.pid");
    const report = await bisectLockfile({
      cwd: repo.dir,
      good: repo.good,
      command: `node check.js hang ${JSON.stringify(pidFile)}`,
      timeoutSeconds: 3,
    });
    expect(report.status).toBe("culprit");
    expect(report.culprits[0]?.packageName).toBe("leaf-b");
    const bad = report.steps.find((step) => step.kind === "bad-ref");
    expect(bad?.run?.timedOut).toBe(true);
    expect(bad?.note).toContain("killed after 3s");
    expect(bad?.run?.durationMs).toBeGreaterThanOrEqual(2900);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(worktreeLines(repo.dir)).resolves.toHaveLength(1);
  }, 180_000);

  it("says so when the failure does not come from a locked version", async () => {
    const repo = repos["npm"]!;
    const dir = await clone(repo.dir, "npm-source-change");
    writeFileSync(join(dir, "broken-marker"), "x\n");
    await run("git", ["add", "--all"], dir);
    await run("git", ["commit", "--quiet", "-m", "source change"], dir);
    const report = await bisectLockfile({
      cwd: dir,
      good: repo.good,
      command: "test ! -f broken-marker",
    });
    expect(report.status).toBe("not-attributable");
    expect(report.summary).toContain("does not come from a version change");
    expect(report.culprits).toEqual([]);
    expect(report.remedy).toBeUndefined();
  }, 180_000);

  it("says not reproducible when the command passes at the bad ref, or fails at the good one", async () => {
    const repo = repos["npm"]!;
    const passes = await bisectLockfile({
      cwd: repo.dir,
      good: repo.good,
      command: "node check.js none",
    });
    expect(passes.status).toBe("not-reproducible");
    expect(passes.summary).toContain("passes at the bad ref");
    expect(passes.steps.map((step) => step.kind)).toEqual(["good-ref", "bad-ref"]);

    const failsAtGood = await bisectLockfile({ cwd: repo.dir, good: repo.good, command: "exit 3" });
    expect(failsAtGood.status).toBe("not-reproducible");
    expect(failsAtGood.summary).toContain("does not pass at the good ref");
    expect(failsAtGood.steps).toHaveLength(1);
    expect(failsAtGood.steps[0]?.run?.exitCode).toBe(3);
    await expect(worktreeLines(repo.dir)).resolves.toHaveLength(1);
  }, 180_000);

  it("stops at the step limit and says the answer is not final", async () => {
    const repo = repos["npm"]!;
    const report = await bisectLockfile({
      cwd: repo.dir,
      good: repo.good,
      command: "node check.js single",
      maxSteps: 2,
    });
    expect(report.status).toBe("incomplete");
    expect(report.stopped).toBe("max-steps");
    expect(report.stepsUsed).toBe(2);
    expect(report.culprits.map((item) => item.packageName)).toContain("leaf-b");
    expect(report.culprits.length).toBeLessThan(report.updates.length);
    expect(report.remedy).toBeUndefined();
  }, 180_000);

  it("removes its checkouts and processes when interrupted", async () => {
    const repo = repos["npm"]!;
    const pidFile = join(scratch, "interrupt.pid");
    const controller = new AbortController();
    const started = Date.now();
    const pending = bisectLockfile({
      cwd: repo.dir,
      good: repo.good,
      command: `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`,
      signal: controller.signal,
    });
    // Wait until the command is running in the good checkout, then press Ctrl-C.
    while (!existsSync(pidFile)) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    controller.abort();
    const report = await pending;
    expect(report.status).toBe("incomplete");
    expect(report.stopped).toBe("interrupted");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    await expect(worktreeLines(repo.dir)).resolves.toHaveLength(1);
  }, 180_000);
});
