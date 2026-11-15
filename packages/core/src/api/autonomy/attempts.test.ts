/**
 * finalizeAttempt under earned autonomy: real git worktrees and the real verifier (as in
 * runs/attempts.test.ts); only the package manager and the project's type check are replaced.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readTrackRecord } from "../../autonomy/record.js";
import type { PatchResult, RemediationReport } from "../../platform/types.js";
import { defaultAttemptDeps } from "../../remediation/repair/attempt.js";
import { verify } from "../../remediation/verify/verifier.js";
import { createWorktree } from "../../runs/worktree.js";
import { finalizeAttempt, startAttempt } from "../runs/attempts.js";
import type { RunDeps } from "../runs/deps.js";
import { getRun, persistPlan } from "../runs/index.js";
import { AutonomyRefusedError, getAutonomy } from "./index.js";

vi.mock("../../remediation/tools/check-inventory.js", () => ({
  checkInventoryTool: {
    execute: vi.fn(async ({ cwd }: { cwd: string }) => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      return {
        packages: Object.entries(manifest.dependencies).map(([name, version]) => ({
          name,
          version,
          type: "direct" as const,
        })),
      };
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
      : {
          passed: false,
          output: "src/a.ts(2,1): error TS2554: Expected 0-1 arguments, but got 2.",
        };
  }),
}));

let dir: string;
let cache: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const setDeps = (root: string, dependencies: Record<string, string>) =>
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", dependencies }, null, 2));

const initProject = (policyYaml: string) => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "autonomy-attempts-")));
  cache = mkdtempSync(join(tmpdir(), "autonomy-attempts-cache-"));
  vi.stubEnv("XDG_CACHE_HOME", cache);
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  setDeps(dir, { dep: "1.0.0" });
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, "src/a.ts"), "import { f } from 'dep';\nf(1, 2);\n");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  writeFileSync(join(dir, ".github/autoremediator.yml"), policyYaml);
  writeFileSync(join(dir, ".gitignore"), ".autoremediator/*\n!.autoremediator/track-record.json\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
};
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

const preview = (): RemediationReport => ({
  cveId: "CVE-2021-0001",
  cveDetails: {
    id: "CVE-2021-0001",
    summary: "",
    severity: "HIGH",
    references: [],
    affectedPackages: [
      {
        name: "dep",
        ecosystem: "npm",
        vulnerableRange: "<2.0.0",
        firstPatchedVersion: "2.0.0",
        source: "osv",
      },
    ],
  },
  vulnerablePackages: [],
  summary: "preview",
  results: [
    {
      packageName: "dep",
      strategy: "version-bump",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      applied: false,
      dryRun: true,
      message: "planned",
      dependencyScope: "direct",
    },
  ],
});
const upgrade = (item: { packageName: string }): PatchResult => ({
  packageName: item.packageName,
  strategy: "version-bump",
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  applied: true,
  dryRun: false,
  message: "ok",
});
const deps = (): RunDeps => ({
  applyItem: async () => {
    throw new Error("not used");
  },
  reinstall: vi.fn(async () => undefined),
  verify: (request) => verify(request),
  attempt: async () => {
    throw new Error("not used");
  },
  attemptDeps: {
    ...defaultAttemptDeps,
    createWorktree: (cwd, name) => createWorktree(cwd, name, { XDG_CACHE_HOME: cache }),
    applyUpgrade: async (item, checkout) => {
      setDeps(checkout, { [item.packageName]: "2.0.0" });
      return upgrade(item);
    },
  },
});
const fix = (worktree: string) =>
  writeFileSync(join(worktree, "src/a.ts"), "import { f } from 'dep';\nf(1);\n");

describe("finalizeAttempt under earned autonomy", () => {
  beforeEach(() => initProject("allowMajorBumps: true\nautonomy:\n  ceiling: L3\n"));

  it("records a promoted attempt as a verified run, with the tests and type check that passed", async () => {
    const { runId } = await persistPlan(preview(), { typecheck: true, runTests: true }, dir);
    const itemId = getRun({ cwd: dir, runId }).plan!.items[0]!.itemId;
    const opened = await startAttempt({ cwd: dir, runId, itemId }, deps());
    fix(opened.worktreePath!);

    const done = await finalizeAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps());
    expect(done).toMatchObject({ finalized: true, status: "promoted" });

    expect(readTrackRecord(dir).events).toMatchObject([
      {
        seq: 1,
        type: "applied-verified",
        runId,
        itemId,
        packages: ["dep"],
        coverage: { tests: true, typecheck: true },
      },
    ]);
    expect(getAutonomy({ cwd: dir })).toMatchObject({
      level: "L2",
      evidence: { verifiedRuns: 1, testsCoveredRuns: 1, typecheckCoveredRuns: 1 },
    });
  });

  it("an attempt that does not verify is not an outcome: the host is still iterating", async () => {
    const { runId } = await persistPlan(preview(), { typecheck: true }, dir);
    const itemId = getRun({ cwd: dir, runId }).plan!.items[0]!.itemId;
    const opened = await startAttempt({ cwd: dir, runId, itemId }, deps());

    const done = await finalizeAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps());
    expect(done.finalized).toBe(false);
    expect(readTrackRecord(dir).events).toEqual([]);
  });
});

describe("finalizeAttempt below L2", () => {
  it("is refused, and the checkout and project are left as they were", async () => {
    initProject("allowMajorBumps: true\nautonomy:\n  ceiling: L1\n");
    const { runId } = await persistPlan(preview(), { typecheck: true }, dir);
    const itemId = getRun({ cwd: dir, runId }).plan!.items[0]!.itemId;
    // Starting an attempt touches only an isolated checkout, so it is allowed at any level.
    const opened = await startAttempt({ cwd: dir, runId, itemId }, deps());
    fix(opened.worktreePath!);

    const refusal = finalizeAttempt({ cwd: dir, runId, attemptId: opened.attemptId }, deps());
    await expect(refusal).rejects.toBeInstanceOf(AutonomyRefusedError);
    await expect(refusal).rejects.toThrow(/autonomy is L1 \(suggest\).*Nothing was changed/s);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain('"dep": "1.0.0"');
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toContain("f(1, 2);");
  });
});
