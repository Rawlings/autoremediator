/**
 * applyPlan with agent repair: real git, real worktrees, real verifier and promotion. Replaced: the
 * package manager (package.json is the "install"), the project's type check, and the model.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepairAgent, RepairOutcome } from "../../platform/repair-agent.js";
import type { PatchResult, RemediationReport } from "../../platform/types.js";
import {
  defaultAttemptDeps,
  runRepairAttempt,
  type AttemptResult,
} from "../../remediation/repair/attempt.js";
import { verify } from "../../remediation/verify/verifier.js";
import { createWorktree } from "../../runs/worktree.js";
import { applyPlan, getRun, persistPlan, rollbackRun, verifyRun, type RunDeps } from "./index.js";

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
const read = (file: string) => readFileSync(join(dir, file), "utf8");
const setDep = (root: string, version: string) =>
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "app", dependencies: { dep: version } }, null, 2),
  );

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "repair-apply-")));
  cache = mkdtempSync(join(tmpdir(), "repair-cache-"));
  vi.stubEnv("XDG_CACHE_HOME", cache);
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  setDep(dir, "1.0.0");
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

const preview: RemediationReport = {
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
};

const upgraded = (): PatchResult => ({
  packageName: "dep",
  strategy: "version-bump",
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  applied: true,
  dryRun: false,
  message: "applied",
});

/** The upgrade works for the dependency but fails the project's own checks, so the tool rolls it back. */
const breaksTheProject =
  (reason: PatchResult["unresolvedReason"] = "validation-failed"): RunDeps["applyItem"] =>
  async () => ({
    packageName: "dep",
    strategy: "version-bump",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    applied: false,
    dryRun: false,
    unresolvedReason: reason,
    message: "npm test failed after upgrading dep to 2.0.0. Rolled back.",
  });

const agentThat = (
  repair: (worktree: string) => RepairOutcome,
): RepairAgent & { calls: number } => {
  const agent = {
    id: "scripted",
    calls: 0,
    async repair(_task: unknown, env: { worktree: string }) {
      agent.calls += 1;
      return repair(env.worktree);
    },
  };
  return agent as RepairAgent & { calls: number };
};
const submitted = (): RepairOutcome => ({
  status: "submitted",
  rationale: "dropped the removed argument",
  usage: [{ purpose: "upgrade-repair", model: "m", inputTokens: 500, outputTokens: 60 }],
  transcript: [{ step: 1, text: "editFile(...)" }],
});
const fix = (worktree: string) =>
  writeFileSync(join(worktree, "src/a.ts"), "import { f } from 'dep';\nf(1);\n");

const deps = (applyItem: RunDeps["applyItem"], over: Partial<RunDeps> = {}): RunDeps => ({
  applyItem,
  reinstall: vi.fn(async () => undefined),
  verify: (request) => verify(request),
  attempt: (request) =>
    runRepairAttempt(request, {
      ...defaultAttemptDeps,
      createWorktree: (cwd, name) => createWorktree(cwd, name, { XDG_CACHE_HOME: cache }),
      applyUpgrade: async (_item, checkout) => {
        setDep(checkout, "2.0.0");
        return upgraded();
      },
    }),
  ...over,
});

const plan = () => persistPlan(preview, { typecheck: true, runTests: true }, dir);

describe("applyPlan with agent repair", () => {
  it("repairs an upgrade that breaks the project and puts the verified result in place", async () => {
    const { runId } = await plan();
    const agent = agentThat((worktree) => {
      fix(worktree);
      return submitted();
    });

    const outcome = await applyPlan(
      { cwd: dir, runId, repairAgent: agent },
      deps(breaksTheProject()),
    );

    expect(outcome.status).toBe("applied");
    expect(outcome.items[0]).toMatchObject({
      status: "applied",
      repair: { status: "promoted", rounds: 1 },
    });
    expect(outcome.items[0]?.message).toMatch(
      /repaired the project with an agent: dropped the removed argument/,
    );
    // In the real project: the upgrade and the source change.
    expect(read("package.json")).toContain('"dep": "2.0.0"');
    expect(read("src/a.ts")).toBe("import { f } from 'dep';\nf(1);\n");
    expect(git("status", "--porcelain")).toContain("src/a.ts");
    // Nothing left behind.
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("keeps the attempt with the run: record, patch, transcript, verification and ledger", async () => {
    const { runId } = await plan();
    await applyPlan(
      {
        cwd: dir,
        runId,
        repairAgent: agentThat((w) => {
          fix(w);
          return submitted();
        }),
      },
      deps(breaksTheProject()),
    );

    const details = getRun({ cwd: dir, runId });
    expect(details.attempts).toHaveLength(1);
    expect(details.attempts[0]).toMatchObject({
      status: "promoted",
      agentId: "scripted",
      rounds: 1,
      inputTokens: 500,
      outputTokens: 60,
      changedFiles: ["package.json", "src/a.ts"],
    });
    const attemptDir = join(runDirOf(runId), "attempts", details.attempts[0]!.attemptId);
    expect(readFileSync(join(attemptDir, "diff.patch"), "utf8")).toContain("+f(1);");
    expect(readFileSync(join(attemptDir, "transcript.jsonl"), "utf8")).toContain("editFile");
    expect(JSON.parse(readFileSync(join(attemptDir, "verification.json"), "utf8")).passed).toBe(
      true,
    );
    expect(details.ledger.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["attempt.start", "attempt.done", "item.done"]),
    );
    expect(details.ledger.ok).toBe(true);
    expect(details.run.allowSourceEdits).toBe(true);
    expect(details.items[0]?.repair?.status).toBe("promoted");
  });

  it("can be rolled back, source edits included, and verified while applied", async () => {
    const { runId } = await plan();
    await applyPlan(
      {
        cwd: dir,
        runId,
        repairAgent: agentThat((w) => {
          fix(w);
          return submitted();
        }),
      },
      deps(breaksTheProject()),
    );

    const verified = await verifyRun(
      { cwd: dir, runId, checks: ["scope", "policy", "vuln-gone"] },
      deps(breaksTheProject()),
    );
    expect(verified.passed).toBe(true);

    await rollbackRun({ cwd: dir, runId }, deps(breaksTheProject()));
    expect(read("src/a.ts")).toBe("import { f } from 'dep';\nf(1, 2);\n");
    expect(read("package.json")).toContain('"dep": "1.0.0"');
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  it("leaves the project alone when the agent cannot repair it", async () => {
    const { runId } = await plan();
    const agent = agentThat(() => ({
      status: "gave-up",
      rationale: "the API is gone",
      usage: [],
      transcript: [],
    }));

    const outcome = await applyPlan(
      { cwd: dir, runId, repairAgent: agent },
      deps(breaksTheProject()),
    );

    expect(outcome.items[0]).toMatchObject({ status: "failed", repair: { status: "rejected" } });
    expect(outcome.items[0]?.message).toMatch(
      /An agent repair was tried and not accepted \(rejected\).*gave up: the API is gone/,
    );
    expect(read("package.json")).toContain('"dep": "1.0.0"');
    expect(git("status", "--porcelain").trim()).toBe("");
    expect(getRun({ cwd: dir, runId }).attempts[0]).toMatchObject({ status: "rejected" });
  });

  it("does not repair a failure the agent cannot do anything about", async () => {
    const { runId } = await plan();
    const agent = agentThat(() => submitted());
    const outcome = await applyPlan(
      { cwd: dir, runId, repairAgent: agent },
      deps(breaksTheProject("install-failed")),
    );
    expect(agent.calls).toBe(0);
    expect(outcome.items[0]?.repair).toBeUndefined();
  });

  it("does nothing without an agent, and never spends tokens when told not to", async () => {
    vi.stubEnv("AUTOREMEDIATOR_MODEL", "");
    const first = await plan();
    const none = await applyPlan({ cwd: dir, runId: first.runId }, deps(breaksTheProject()));
    expect(none.items[0]?.repair).toBeUndefined();

    const second = await plan();
    const agent = agentThat(() => submitted());
    const off = await applyPlan(
      { cwd: dir, runId: second.runId, repair: false, repairAgent: agent },
      deps(breaksTheProject()),
    );
    expect(agent.calls).toBe(0);
    expect(off.items[0]?.repair).toBeUndefined();
  });

  it("refuses up front to repair without a model, before changing anything", async () => {
    vi.stubEnv("AUTOREMEDIATOR_MODEL", "");
    const { runId } = await plan();
    await expect(
      applyPlan({ cwd: dir, runId, repair: true }, deps(breaksTheProject())),
    ).rejects.toThrow(/Repair needs a model/);
    expect(getRun({ cwd: dir, runId }).run.status).toBe("planned");
  });

  it("notes, and carries on, when a configured model cannot be loaded", async () => {
    vi.stubEnv("AUTOREMEDIATOR_MODEL", "nosuchprovider:model-x");
    const { runId } = await plan();
    const outcome = await applyPlan({ cwd: dir, runId }, deps(breaksTheProject()));
    expect(outcome.items[0]).toMatchObject({ status: "failed" });
    const events = getRun({ cwd: dir, runId }).ledger.events;
    expect(events.find((event) => event.type === "repair.unavailable")?.data["message"]).toMatch(
      /nosuchprovider/,
    );
  });

  it("will not put a verified change in place if it no longer applies, or fails in the project", async () => {
    const attemptReturning =
      (diff: string): RunDeps["attempt"] =>
      async () =>
        ({
          status: "verified",
          reason: "ok",
          rounds: 1,
          diff,
          changedFiles: [],
          usage: [],
          transcript: [],
          agentId: "scripted",
        }) satisfies AttemptResult;
    const agent = agentThat(() => submitted());

    // A patch against content the project does not have.
    const stale = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " something else",
      "-f(9);",
      "+f(1);",
      "",
    ].join("\n");
    const first = await plan();
    const notApplicable = await applyPlan(
      { cwd: dir, runId: first.runId, repairAgent: agent },
      deps(breaksTheProject(), { attempt: attemptReturning(stale) }),
    );
    expect(notApplicable.items[0]?.message).toMatch(/no longer applies/);

    // A patch that applies but touches a CI workflow: the in-place verification rejects it.
    const workflow = [
      "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/.github/workflows/ci.yml",
      "@@ -0,0 +1 @@",
      "+on: push",
      "",
    ].join("\n");
    const second = await plan();
    const rejected = await applyPlan(
      { cwd: dir, runId: second.runId, repairAgent: agent },
      deps(breaksTheProject(), { attempt: attemptReturning(workflow) }),
    );
    expect(rejected.items[0]?.message).toMatch(/failed verification in the project \(scope\)/);
    expect(existsSync(join(dir, ".github/workflows/ci.yml"))).toBe(false);
    expect(git("status", "--porcelain").trim()).toBe("");
    expect(getRun({ cwd: dir, runId: second.runId }).attempts[0]?.status).toBe("promotion-failed");
  });
});

import { RunStore } from "../../runs/run-store.js";
const runDirOf = (runId: string): string => new RunStore(dir).runDir(runId);
