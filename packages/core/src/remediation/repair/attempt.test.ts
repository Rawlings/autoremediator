/**
 * runRepairAttempt with a real git worktree and the real verifier. Only the package manager and the
 * model are replaced: the "installed" packages are whatever package.json declares, the type check is
 * a function of the source, and the agent is a script.
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

import { addMemory, readMemory } from "../../platform/memory/index.js";
import {
  DEFAULT_REPAIR_BUDGET,
  type RepairAgent,
  type RepairBudget,
  type RepairEnv,
  type RepairOutcome,
  type RepairTask,
} from "../../platform/repair-agent.js";
import type { PlanItem } from "../../runs/plan.js";
import { createWorktree } from "../../runs/worktree.js";
import { type AttemptDeps, defaultAttemptDeps, runRepairAttempt } from "./attempt.js";

vi.mock("../tools/check-inventory.js", () => ({
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

// The project type-checks once `f` is called with one argument.
vi.mock("../verify/command-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../verify/command-check.js")>()),
  runCommandCheck: vi.fn(async (_command: string[], cwd: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ok = readFileSync(join(cwd, "src/a.ts"), "utf8").includes("f(1);");
    return ok
      ? { passed: true, output: "" }
      : {
          passed: false,
          output: "src/a.ts(2,1): error TS2554: Expected 0-1 arguments, but got 2.",
        };
  }),
}));

let dir: string;
let cache: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
const read = (file: string) => readFileSync(join(dir, file), "utf8");
const setDep = (root: string, version: string) =>
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "app", dependencies: { dep: version } }, null, 2),
  );

const item: PlanItem = {
  itemId: "item_1",
  cveId: "CVE-2021-0001",
  packageName: "dep",
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  strategy: "version-bump",
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "attempt-")));
  cache = mkdtempSync(join(tmpdir(), "attempt-cache-"));
  vi.stubEnv("XDG_CACHE_HOME", cache);
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  setDep(dir, "1.0.0");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "import { f } from 'dep';\nf(1, 2);\n");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  writeFileSync(join(dir, ".gitignore"), ".autoremediator\n");
  // 1.0.0 -> 2.0.0 is a major bump, which the policy has to allow for a breaking-change repair.
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github/autoremediator.yml"), "allowMajorBumps: true\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

const advisory = {
  id: "CVE-2021-0001",
  summary: "",
  severity: "HIGH" as const,
  references: [],
  affectedPackages: [
    {
      name: "dep",
      ecosystem: "npm" as const,
      vulnerableRange: "<2.0.0",
      firstPatchedVersion: "2.0.0",
      source: "osv" as const,
    },
  ],
};

/** Applies the upgrade by editing package.json, as the real tool does, without installing. */
const deps = (over: Partial<AttemptDeps> = {}): AttemptDeps => ({
  ...defaultAttemptDeps,
  createWorktree: (cwd, name) => createWorktree(cwd, name, { XDG_CACHE_HOME: cache }),
  applyUpgrade: async (_item, checkout) => {
    setDep(checkout, "2.0.0");
    return {
      packageName: "dep",
      strategy: "version-bump",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      applied: true,
      dryRun: false,
      message: "ok",
    };
  },
  ...over,
});

const outcome = (over: Partial<RepairOutcome> = {}): RepairOutcome => ({
  status: "submitted",
  rationale: "changed f's call",
  usage: [{ purpose: "upgrade-repair", model: "m", inputTokens: 100, outputTokens: 20 }],
  transcript: [{ step: 1, text: "editFile(...) -> Edited src/a.ts" }],
  ...over,
});

const agentThat = (
  repair: (task: RepairTask, env: RepairEnv) => Promise<RepairOutcome> | RepairOutcome,
): RepairAgent & { calls: RepairTask[] } => {
  const calls: RepairTask[] = [];
  return {
    id: "scripted",
    calls,
    async repair(task, env) {
      calls.push(task);
      return repair(task, env);
    },
  };
};

const fixesTheCall = (env: RepairEnv) =>
  writeFileSync(join(env.worktree, "src/a.ts"), "import { f } from 'dep';\nf(1);\n");

const request = (
  agent: RepairAgent,
  budget: Partial<RepairBudget> = {},
  signal = new AbortController().signal,
) => ({
  cwd: dir,
  runId: "run_aaaaaaaaaaaaaaaaaaaa",
  attemptId: "attempt-1",
  item,
  options: { typecheck: true, runTests: true },
  advisories: [advisory],
  expectedRemaining: [],
  agent,
  budget: { ...DEFAULT_REPAIR_BUDGET, ...budget },
  signal,
});

describe("runRepairAttempt", () => {
  it("lets the agent repair the project and returns the verified change as a patch", async () => {
    const agent = agentThat((_task, env) => {
      fixesTheCall(env);
      return outcome();
    });

    const result = await runRepairAttempt(request(agent), deps());

    expect(result).toMatchObject({
      status: "verified",
      rounds: 1,
      reason: "changed f's call",
      agentId: "scripted",
    });
    expect(result.diff).toContain("-f(1, 2);");
    expect(result.diff).toContain("+f(1);");
    expect(result.diff).toContain('+    "dep": "2.0.0"');
    expect(result.changedFiles).toEqual(["package.json", "src/a.ts"]);
    expect(result.verification?.checks.map((check) => [check.name, check.status])).toEqual([
      ["scope", "passed"],
      ["policy", "passed"],
      ["supply-chain", "passed"],
      ["vuln-gone", "passed"],
      ["typecheck", "passed"],
      ["tests", "passed"],
      ["proof-of-fix", "skipped"],
    ]);
    expect(result.usage).toHaveLength(1);
    // The agent was told what the type checker said, and the project itself is untouched.
    expect(agent.calls[0]).toMatchObject({ round: 1, packageName: "dep", toVersion: "2.0.0" });
    expect(agent.calls[0]?.failure.details[0]).toContain("TS2554");
    expect(read("src/a.ts")).toBe("import { f } from 'dep';\nf(1, 2);\n");
    expect(read("package.json")).toContain("1.0.0");
  });

  it("shows the agent what the repository remembers, and lets it propose, not record", async () => {
    await addMemory(dir, { kind: "install-quirk", text: "install needs python3" });
    await addMemory(dir, { kind: "pinned-package", package: "unrelated", reason: "not this one" });
    await addMemory(dir, {
      kind: "note",
      text: "only proposed",
      status: "proposed",
      source: "agent",
    });
    const agent = agentThat(async (_task, env) => {
      fixesTheCall(env);
      const answer = await env.proposeMemory!({
        kind: "flaky-test",
        text: "src/a.test.ts",
        reason: "slow",
      });
      expect(answer).toMatch(/^Proposed mem_/);
      return outcome();
    });

    const result = await runRepairAttempt(request(agent), deps());

    expect(result.status).toBe("verified");
    const shown = agent.calls[0]?.memory ?? "";
    expect(shown).toContain("install needs python3");
    expect(shown).not.toContain("unrelated");
    expect(shown).not.toContain("only proposed");
    // The proposal went to the project's memory (not the checkout), as a proposal.
    expect(readMemory(dir).entries.filter((entry) => entry.kind === "flaky-test")).toMatchObject([
      { status: "proposed", source: "agent:run_aaaaaaaaaaaaaaaaaaaa" },
    ]);
  });

  it("still repairs when the memory file cannot be read, and says so in the transcript", async () => {
    mkdirSync(join(dir, ".autoremediator"), { recursive: true });
    writeFileSync(join(dir, ".autoremediator", "memory.md"), "x".repeat(1024 * 1024 + 1));
    const agent = agentThat((_task, env) => {
      fixesTheCall(env);
      return outcome();
    });

    const result = await runRepairAttempt(request(agent), deps());

    expect(result.status).toBe("verified");
    expect(agent.calls[0]?.memory).toBeUndefined();
    expect(result.transcript.some((entry) => entry.text.includes("memory is unreadable"))).toBe(
      true,
    );
  });

  it("does not involve the agent when the upgrade already works", async () => {
    writeFileSync(join(dir, "src/a.ts"), "import { f } from 'dep';\nf(1);\n");
    git("commit", "-aqm", "already adapted");
    const agent = agentThat(() => outcome());

    const result = await runRepairAttempt(request(agent), deps());

    expect(result).toMatchObject({ status: "verified", rounds: 0 });
    expect(agent.calls).toHaveLength(0);
    expect(result.changedFiles).toEqual(["package.json"]);
  });

  it("cleans up its checkout, whatever happens", async () => {
    const seen: string[] = [];
    const agent = agentThat((_task, env) => {
      seen.push(env.worktree);
      fixesTheCall(env);
      return outcome();
    });
    await runRepairAttempt(request(agent), deps());
    expect(seen).toHaveLength(1);
    expect(existsSync(seen[0]!)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n"),
    ).toHaveLength(1);
  });

  it("rejects when the agent gives up or runs out of budget", async () => {
    const gaveUp = await runRepairAttempt(
      request(agentThat(() => outcome({ status: "gave-up", rationale: "API removed" }))),
      deps(),
    );
    expect(gaveUp).toMatchObject({ status: "rejected", rounds: 1 });
    expect(gaveUp.reason).toMatch(/gave up: API removed/);

    const exhausted = await runRepairAttempt(
      request(agentThat(() => outcome({ status: "budget-exhausted", rationale: "steps" }))),
      deps(),
    );
    expect(exhausted.reason).toMatch(/ran out of budget: steps/);
  });

  it("sends the verifier's findings back and gives up after the round limit", async () => {
    const agent = agentThat(() => outcome({ rationale: "tried something" }));

    const result = await runRepairAttempt(request(agent, { maxRepairRounds: 2 }), deps());

    expect(result.status).toBe("rejected");
    expect(result.rounds).toBe(2);
    expect(agent.calls.map((task) => task.round)).toEqual([1, 2]);
    expect(agent.calls[1]?.previousRounds).toEqual(["tried something"]);
    expect(result.reason).toMatch(/still rejects it after 2 round\(s\): typecheck/);
    expect(result.verification?.failedCheck).toBe("typecheck");
  });

  it("recovers in a later round once the agent fixes what the verifier found", async () => {
    const agent = agentThat((task, env) => {
      if (task.round === 2) fixesTheCall(env);
      return outcome();
    });
    const result = await runRepairAttempt(request(agent), deps());
    expect(result).toMatchObject({ status: "verified", rounds: 2 });
  });

  it("rejects a repair that edits files an agent may not touch, however well the checks pass", async () => {
    const agent = agentThat((_task, env) => {
      fixesTheCall(env);
      mkdirSync(join(env.worktree, ".github", "workflows"), { recursive: true });
      writeFileSync(join(env.worktree, ".github/workflows/ci.yml"), "on: push\n");
      return outcome();
    });

    const result = await runRepairAttempt(request(agent, { maxRepairRounds: 1 }), deps());

    expect(result.status).toBe("rejected");
    expect(result.verification?.failedCheck).toBe("scope");
    expect(
      result.verification?.checks.find((check) => check.name === "scope")?.details?.[0],
    ).toMatch(/ci.yml/);
    expect(existsSync(join(dir, ".github", "workflows"))).toBe(false);
  });

  it("rejects a repair that quietly reverts the upgrade", async () => {
    const agent = agentThat((_task, env) => {
      fixesTheCall(env);
      setDep(env.worktree, "1.0.0");
      return outcome();
    });
    const result = await runRepairAttempt(request(agent, { maxRepairRounds: 1 }), deps());
    expect(result.status).toBe("rejected");
    expect(result.verification?.failedCheck).toBe("vuln-gone");
  });

  it("fails when the upgrade cannot be applied, without consulting the agent", async () => {
    const agent = agentThat(() => outcome());
    const result = await runRepairAttempt(
      request(agent),
      deps({
        applyUpgrade: async () => ({
          packageName: "dep",
          strategy: "none",
          fromVersion: "1.0.0",
          applied: false,
          dryRun: false,
          message: "install failed",
          unresolvedReason: "install-failed",
        }),
      }),
    );
    expect(result).toMatchObject({ status: "failed" });
    expect(result.reason).toMatch(/could not be applied.*install failed/);
    expect(agent.calls).toHaveLength(0);
  });

  it("treats a crashing agent as a failed attempt", async () => {
    const result = await runRepairAttempt(
      request(
        agentThat(() => {
          throw new Error("segfault");
        }),
      ),
      deps(),
    );
    expect(result).toMatchObject({ status: "failed" });
    expect(result.reason).toMatch(/the agent failed: segfault/);
  });

  it("stops asking the agent once the token budget is spent, or the attempt is cancelled", async () => {
    const spendy = agentThat(() =>
      outcome({
        usage: [{ purpose: "upgrade-repair", model: "m", inputTokens: 900, outputTokens: 200 }],
      }),
    );
    const spent = await runRepairAttempt(request(spendy, { maxTotalTokens: 1000 }), deps());
    expect(spent.reason).toMatch(/token budget was used up/);
    expect(spendy.calls).toHaveLength(1);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runRepairAttempt(
      request(
        agentThat(() => outcome()),
        {},
        controller.signal,
      ),
      deps(),
    );
    expect(cancelled.reason).toMatch(/cancelled/);
  });
});
