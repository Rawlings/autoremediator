import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planRemediation } from "../remediate/index.js";
import type { PatchResult, RemediationReport } from "../remediate/types.js";
import type { VerificationResult } from "../verify/types.js";
import {
  applyPlan,
  getRun,
  listRuns,
  persistPlan,
  resumeRun,
  rollbackRun,
  type RunDeps,
  verifyRun,
} from "./index.js";
import { RunStore } from "./run-store.js";

let dir: string;
const pkg = () =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
const writePkg = (dependencies: Record<string, string>) =>
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies }, null, 2));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runs-api-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  writePkg({ lodash: "4.17.20", minimist: "1.2.0" });
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
  writeFileSync(join(dir, ".gitignore"), ".autoremediator\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const result = (over: Partial<PatchResult>): PatchResult => ({
  packageName: "lodash",
  strategy: "version-bump",
  fromVersion: "4.17.20",
  toVersion: "4.17.21",
  applied: false,
  dryRun: true,
  message: "planned",
  dependencyScope: "direct",
  ...over,
});

const report = (results: PatchResult[]): RemediationReport =>
  ({
    cveId: "CVE-2021-23337",
    cveDetails: null,
    vulnerablePackages: [],
    results,
    summary: "preview",
  }) as RemediationReport;

const twoItemReport = () =>
  report([
    result({}),
    result({
      packageName: "minimist",
      fromVersion: "1.2.0",
      toVersion: "1.2.6",
      strategy: "override",
    }),
    result({
      packageName: "left-pad",
      strategy: "patch-file",
      toVersion: undefined,
      fromVersion: "1.0.0",
    }),
    result({
      packageName: "qs",
      fromVersion: "6.0.0",
      toVersion: undefined,
      strategy: "none",
      unresolvedReason: "no-safe-version",
    }),
  ]);

/** No agent is configured in these tests, so an attempt is never started. */
const noAttempt: RunDeps["attempt"] = async () => {
  throw new Error("no repair attempt expected");
};

const passing: VerificationResult = {
  passed: true,
  checks: [{ name: "vuln-gone", status: "passed", message: "ok", durationMs: 0 }],
  durationMs: 0,
};

/** Applies by editing package.json, as the real tools do, without installing anything. */
function bumping(calls: string[] = []): RunDeps {
  return {
    reinstall: vi.fn(async () => undefined),
    verify: vi.fn(async () => passing),
    attempt: noAttempt,
    async applyItem(item) {
      calls.push(item.packageName);
      const manifest = pkg();
      manifest.dependencies[item.packageName] = item.toVersion;
      writePkg(manifest.dependencies);
      return result({
        packageName: item.packageName,
        fromVersion: item.fromVersion,
        toVersion: item.toVersion,
        strategy: item.strategy,
        applied: true,
        dryRun: false,
        message: "applied",
      });
    },
  };
}

describe("persistPlan", () => {
  it("records a run with a plan of the replayable items and says why others are skipped", async () => {
    const { runId, planId } = await persistPlan(twoItemReport(), {}, dir);
    const details = getRun({ cwd: dir, runId });

    expect(details.run).toMatchObject({ status: "planned", planId, cveIds: ["CVE-2021-23337"] });
    expect(
      details.plan?.items.map((item) => [item.packageName, item.toVersion, item.strategy]),
    ).toEqual([
      ["lodash", "4.17.21", "version-bump"],
      ["minimist", "1.2.6", "override"],
    ]);
    expect(details.plan?.skipped.map((skip) => skip.packageName)).toEqual(["left-pad", "qs"]);
    expect(details.plan?.skipped[0]?.reason).toMatch(/generated patch/);
    expect(details.plan?.skipped[1]?.unresolvedReason).toBe("no-safe-version");
    expect(details.ledger.ok).toBe(true);
    expect(details.ledger.events.map((event) => event.type)).toEqual(["plan.created"]);
  });

  it("gives the same plan id to the same plan, and a different one when anything differs", async () => {
    const first = await persistPlan(twoItemReport(), {}, dir);
    const second = await persistPlan(twoItemReport(), {}, dir);
    expect(second.planId).toBe(first.planId);
    expect(second.runId).not.toBe(first.runId);

    const other = await persistPlan(report([result({ toVersion: "4.17.22" })]), {}, dir);
    expect(other.planId).not.toBe(first.planId);
  });

  it("changes nothing in the project", async () => {
    const before = readFileSync(join(dir, "package.json"), "utf8");
    await persistPlan(twoItemReport(), {}, dir);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
  });
});

describe("applyPlan", () => {
  it("applies each item, snapshots first, and keeps a verifiable ledger", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const calls: string[] = [];

    const applied = await applyPlan({ cwd: dir, runId }, bumping(calls));

    expect(applied).toMatchObject({ status: "applied", pending: [] });
    expect(applied.items.map((item) => item.status)).toEqual(["applied", "applied"]);
    expect(applied.skipped).toHaveLength(2);
    expect(calls).toEqual(["lodash", "minimist"]);
    expect(pkg().dependencies).toEqual({ lodash: "4.17.21", minimist: "1.2.6" });

    const details = getRun({ cwd: dir, runId });
    expect(details.run.status).toBe("applied");
    expect(details.ledger.ok).toBe(true);
    expect(details.ledger.events.map((event) => event.type)).toEqual([
      "plan.created",
      "snapshot.saved",
      "apply.start",
      "item.start",
      "item.done",
      "item.start",
      "item.done",
      "apply.end",
    ]);
    expect(details.items.map((item) => item.status)).toEqual(["applied", "applied"]);
  });

  it("finds the run by plan id", async () => {
    const { planId, runId } = await persistPlan(twoItemReport(), {}, dir);
    expect((await applyPlan({ cwd: dir, planId }, bumping())).runId).toBe(runId);
  });

  it("refuses a plan whose project has changed, and changes nothing", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    writePkg({ lodash: "4.17.20", minimist: "1.2.0", extra: "1.0.0" });
    const calls: string[] = [];

    await expect(applyPlan({ cwd: dir, runId }, bumping(calls))).rejects.toThrow(/Plan again/);
    expect(calls).toEqual([]);
    expect(getRun({ cwd: dir, runId }).run.status).toBe("planned");
  });

  it("refuses a plan when the policy changed since it was made", async () => {
    writeFileSync(join(dir, ".github-policy.yml"), "allowMajorBumps: false\n");
    const policy = join(dir, ".github-policy.yml");
    const { runId } = await persistPlan(twoItemReport(), { policy }, dir);
    writeFileSync(policy, "allowMajorBumps: true\n");
    await expect(applyPlan({ cwd: dir, runId }, bumping())).rejects.toThrow(/Plan again/);
  });

  it("applies only the chosen items and leaves the run partial", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const plan = getRun({ cwd: dir, runId }).plan!;
    const first = plan.items[0]!;

    const partial = await applyPlan({ cwd: dir, runId, itemIds: [first.itemId] }, bumping());

    expect(partial.status).toBe("partial");
    expect(partial.pending).toEqual([plan.items[1]!.itemId]);
    expect(pkg().dependencies).toEqual({ lodash: "4.17.21", minimist: "1.2.0" });
    await expect(applyPlan({ cwd: dir, runId, itemIds: ["item_nope"] }, bumping())).rejects.toThrow(
      /no item/,
    );
  });

  it("rejects runs that are already finished or rolled back", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await applyPlan({ cwd: dir, runId }, bumping());
    await expect(applyPlan({ cwd: dir, runId }, bumping())).rejects.toThrow(/nothing to apply/);
  });

  it("will not run two appliers on one run", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    writeFileSync(join(new RunStore(dir).runDir(runId), "apply.lock"), String(process.pid));
    await expect(applyPlan({ cwd: dir, runId }, bumping())).rejects.toThrow(
      /already being applied/,
    );
  });

  it("marks an item that did not apply as failed without stopping the others", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const deps: RunDeps = {
      reinstall: bumping().reinstall,
      verify: bumping().verify,
      attempt: noAttempt,
      async applyItem(item) {
        if (item.packageName === "lodash") {
          return result({
            applied: false,
            dryRun: false,
            unresolvedReason: "install-failed",
            message: "install failed",
          });
        }
        return bumping().applyItem(item, { cwd: dir, options: {} });
      },
    };

    const outcome = await applyPlan({ cwd: dir, runId }, deps);

    expect(outcome.status).toBe("partial");
    expect(outcome.items.map((item) => [item.packageName, item.status])).toEqual([
      ["lodash", "failed"],
      ["minimist", "applied"],
    ]);
    expect(outcome.items[0]).toMatchObject({
      message: "install failed",
      unresolvedReason: "install-failed",
    });
  });
});

describe("resumeRun", () => {
  it("continues after a crash, skipping what was already applied", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const calls: string[] = [];
    const crashing: RunDeps = {
      reinstall: bumping().reinstall,
      verify: bumping().verify,
      attempt: noAttempt,
      async applyItem(item, context) {
        if (item.packageName === "minimist") throw new Error("disk on fire");
        return bumping(calls).applyItem(item, context);
      },
    };

    await expect(applyPlan({ cwd: dir, runId }, crashing)).resolves.toMatchObject({
      status: "failed",
      items: [{ status: "applied" }, { status: "failed", message: "disk on fire" }],
    });
    expect(getRun({ cwd: dir, runId }).run.error).toBe("disk on fire");

    const resumed = await resumeRun({ cwd: dir, runId }, bumping(calls));

    expect(resumed.status).toBe("applied");
    expect(resumed.items.map((item) => item.packageName)).toEqual(["minimist"]);
    expect(calls).toEqual(["lodash", "minimist"]);
    expect(pkg().dependencies).toEqual({ lodash: "4.17.21", minimist: "1.2.6" });
  });

  it("refuses to resume when a step left the project half-changed", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const halfDone: RunDeps = {
      reinstall: bumping().reinstall,
      verify: bumping().verify,
      attempt: noAttempt,
      async applyItem(item, context) {
        if (item.packageName === "minimist") {
          writePkg({ lodash: "4.17.21", minimist: "1.2.0", stray: "0.0.1" });
          throw new Error("killed mid-install");
        }
        return bumping().applyItem(item, context);
      },
    };
    await applyPlan({ cwd: dir, runId }, halfDone);

    await expect(resumeRun({ cwd: dir, runId }, bumping())).rejects.toThrow(/last completed step/);
  });

  it("is not for a run that has not started", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await expect(resumeRun({ cwd: dir, runId })).rejects.toThrow(/use applyPlan/);
  });
});

describe("rollbackRun", () => {
  it("restores the files the run changed", async () => {
    const original = readFileSync(join(dir, "package.json"), "utf8");
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await applyPlan({ cwd: dir, runId }, bumping());
    expect(readFileSync(join(dir, "package.json"), "utf8")).not.toBe(original);

    const deps = bumping();
    const rolled = await rollbackRun({ cwd: dir, runId }, deps);

    expect(rolled).toMatchObject({ status: "rolled-back", matchesBase: true, reinstalled: true });
    expect(vi.mocked(deps.reinstall)).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(original);
    const details = getRun({ cwd: dir, runId });
    expect(details.run.status).toBe("rolled-back");
    expect(details.ledger.events.at(-1)?.type).toBe("rollback");
    expect(details.ledger.ok).toBe(true);
  });

  it("works from a fresh process: everything it needs is on disk", async () => {
    const original = readFileSync(join(dir, "package.json"), "utf8");
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await applyPlan({ cwd: dir, runId }, bumping());
    vi.resetModules();
    const fresh = await import("./index.js");

    await fresh.rollbackRun({ cwd: dir, runId }, bumping());

    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(original);
  });

  it("refuses when the project changed since the run, unless forced", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await applyPlan({ cwd: dir, runId }, bumping());
    writePkg({ lodash: "4.17.21", minimist: "1.2.6", mine: "9.9.9" });

    await expect(rollbackRun({ cwd: dir, runId }, bumping())).rejects.toThrow(
      /discard those changes/,
    );
    expect(pkg().dependencies["mine"]).toBe("9.9.9");

    await rollbackRun({ cwd: dir, runId, force: true }, bumping());
    expect(pkg().dependencies).toEqual({ lodash: "4.17.20", minimist: "1.2.0" });
  });

  it("has nothing to undo for an unapplied or already rolled-back run", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await expect(rollbackRun({ cwd: dir, runId }, bumping())).rejects.toThrow(
      /nothing to roll back/,
    );
    await applyPlan({ cwd: dir, runId }, bumping());
    await rollbackRun({ cwd: dir, runId }, bumping());
    await expect(rollbackRun({ cwd: dir, runId }, bumping())).rejects.toThrow(
      /already rolled back/,
    );
    await expect(applyPlan({ cwd: dir, runId }, bumping())).rejects.toThrow(/nothing to apply/);
  });

  it("refuses a snapshot recorded for a different directory", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await applyPlan({ cwd: dir, runId }, bumping());
    const manifest = join(new RunStore(dir).runDir(runId), "snapshot", "snapshot.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(dir, "/somewhere/else"));
    await expect(rollbackRun({ cwd: dir, runId }, bumping())).rejects.toThrow(
      /different directory/,
    );
  });
});

describe("tampering and bad input", () => {
  it("refuses to apply a run whose ledger was edited", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const file = join(new RunStore(dir).runDir(runId), "steps.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"items":2', '"items":0'));

    await expect(applyPlan({ cwd: dir, runId }, bumping())).rejects.toThrow(
      /ledger failed verification/,
    );
    expect(getRun({ cwd: dir, runId }).ledger.ok).toBe(false);
  });

  it("rejects ids that could escape the runs directory", () => {
    expect(() => getRun({ cwd: dir, runId: "../../package" })).toThrow(/Invalid run id/);
    return expect(applyPlan({ cwd: dir, runId: "../x" }, bumping())).rejects.toThrow(
      /Invalid run id/,
    );
  });

  it("needs an id, and reports unknown ones", async () => {
    await expect(applyPlan({ cwd: dir }, bumping())).rejects.toThrow(/runId or a planId/);
    await expect(
      applyPlan({ cwd: dir, planId: "plan_0000000000000000" }, bumping()),
    ).rejects.toThrow(/No run found/);
    await expect(
      applyPlan({ cwd: dir, runId: "run_" + "a".repeat(20) }, bumping()),
    ).rejects.toThrow(/not found/);
  });
});

describe("listRuns", () => {
  it("lists newest first and filters by status", async () => {
    const first = await persistPlan(twoItemReport(), {}, dir);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    const second = await persistPlan(report([result({ toVersion: "4.17.22" })]), {}, dir);
    await applyPlan({ cwd: dir, runId: second.runId }, bumping());

    expect(listRuns({ cwd: dir }).map((run) => run.runId)).toEqual([second.runId, first.runId]);
    expect(listRuns({ cwd: dir, status: "planned" }).map((run) => run.runId)).toEqual([
      first.runId,
    ]);
    expect(listRuns({ cwd: dir, limit: 1 })).toHaveLength(1);
  });
});

describe("planRemediation records a run", () => {
  const preview = report([result({})]);
  const withPipeline = async <T>(action: () => Promise<T>): Promise<T> => {
    vi.resetModules();
    return action();
  };

  it("returns the run and plan ids on the report, and leaves the project alone", async () => {
    vi.doMock("../remediate/local/index.js", () => ({
      runLocalRemediationPipeline: vi.fn(async () => preview),
    }));
    const { planRemediation: plan } = await withPipeline(() => import("../remediate/index.js"));
    const before = readFileSync(join(dir, "package.json"), "utf8");

    const planned = await plan("CVE-2021-23337", { cwd: dir });

    expect(planned.runId).toMatch(/^run_[0-9a-z]{20}$/);
    expect(planned.planId).toMatch(/^plan_[0-9a-f]{16}$/);
    expect(getRun({ cwd: dir, runId: planned.runId! }).plan?.planId).toBe(planned.planId);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
    vi.doUnmock("../remediate/local/index.js");
  });

  it("records nothing when evidence is off", async () => {
    vi.doMock("../remediate/local/index.js", () => ({
      runLocalRemediationPipeline: vi.fn(async () => preview),
    }));
    const { planRemediation: plan } = await withPipeline(() => import("../remediate/index.js"));

    const planned = await plan("CVE-2021-23337", { cwd: dir, evidence: false });

    expect(planned.runId).toBeUndefined();
    expect(listRuns({ cwd: dir })).toEqual([]);
    vi.doUnmock("../remediate/local/index.js");
  });
});

// Imported so a missing export fails typecheck rather than only at runtime.
void planRemediation;

describe("rollbackRun reinstall", () => {
  it("restores the files even when the reinstall fails, and says so", async () => {
    const original = readFileSync(join(dir, "package.json"), "utf8");
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await applyPlan({ cwd: dir, runId }, bumping());
    const failing: RunDeps = {
      ...bumping(),
      reinstall: vi.fn(async () => {
        throw new Error("npm ci can only install with an existing package-lock.json");
      }),
    };

    const rolled = await rollbackRun({ cwd: dir, runId }, failing);

    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(original);
    expect(rolled).toMatchObject({ status: "rolled-back", reinstalled: false });
    expect(rolled.reinstallNote).toMatch(/package-lock/);
    expect(rolled.message).toMatch(/not reinstalled/);
  });

  it("can skip the reinstall", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await applyPlan({ cwd: dir, runId }, bumping());
    const deps = bumping();

    const rolled = await rollbackRun({ cwd: dir, runId, reinstall: false }, deps);

    expect(vi.mocked(deps.reinstall)).not.toHaveBeenCalled();
    expect(rolled).toMatchObject({
      reinstalled: false,
      reinstallNote: "skipped (reinstall: false)",
    });
  });
});

describe("verification during apply", () => {
  const failing = (failedCheck: "vuln-gone" | "scope" = "vuln-gone"): VerificationResult => ({
    passed: false,
    failedCheck,
    checks: [
      {
        name: failedCheck,
        status: "failed",
        message: "lodash@4.17.10 is still vulnerable",
        details: ["lodash@4.17.10 is still in <4.17.21"],
        durationMs: 0,
      },
    ],
    durationMs: 0,
  });

  it("verifies each applied item with the cheap checks and records that it did", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const deps = bumping();

    const applied = await applyPlan({ cwd: dir, runId }, deps);

    expect(applied.items.every((item) => item.verification?.passed)).toBe(true);
    const calls = vi.mocked(deps.verify).mock.calls.map(([request]) => request);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.checks).toEqual(["scope", "policy", "supply-chain", "vuln-gone"]);
    // The first item is judged while the second is still to do, and the plan's skipped findings stay open.
    expect(calls[0]?.expectedRemaining).toEqual(["left-pad", "qs", "minimist"]);
    expect(calls[1]?.expectedRemaining).toEqual(["left-pad", "qs"]);
    // It sees the files as they were before the item, so it can tell what the item changed.
    expect(JSON.parse(calls[0]!.baseFiles.get("package.json")!).dependencies.lodash).toBe(
      "4.17.20",
    );
    expect(
      getRun({ cwd: dir, runId })
        .ledger.events.filter((event) => event.type === "item.done")
        .every((event) => event.data["verified"] === true),
    ).toBe(true);
  });

  it("takes an item back out when verification fails, and carries on with the rest", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const deps = bumping();
    vi.mocked(deps.verify).mockResolvedValueOnce(failing());

    const outcome = await applyPlan({ cwd: dir, runId }, deps);

    expect(outcome.status).toBe("partial");
    expect(outcome.items.map((item) => [item.packageName, item.status])).toEqual([
      ["lodash", "failed"],
      ["minimist", "applied"],
    ]);
    expect(outcome.items[0]?.message).toMatch(/Verification failed \(vuln-gone\)/);
    expect(outcome.items[0]?.verification?.failedCheck).toBe("vuln-gone");
    // lodash is back where it was; minimist went through.
    expect(pkg().dependencies).toEqual({ lodash: "4.17.20", minimist: "1.2.6" });
    expect(deps.reinstall).toHaveBeenCalledTimes(1);

    const events = getRun({ cwd: dir, runId }).ledger.events;
    expect(events.map((event) => event.type)).toContain("item.rejected");
    expect(events.find((event) => event.type === "item.rejected")?.data).toMatchObject({
      failedCheck: "vuln-gone",
      details: ["lodash@4.17.10 is still in <4.17.21"],
    });
    expect(getRun({ cwd: dir, runId }).items[0]).toMatchObject({
      packageName: "lodash",
      status: "failed",
    });
  });

  it("leaves a rejected item retryable and a later rollback intact", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const original = readFileSync(join(dir, "package.json"), "utf8");
    const rejecting = bumping();
    vi.mocked(rejecting.verify).mockResolvedValueOnce(failing());
    await applyPlan({ cwd: dir, runId }, rejecting);

    const resumed = await resumeRun({ cwd: dir, runId }, bumping());
    expect(resumed.status).toBe("applied");
    await rollbackRun({ cwd: dir, runId }, bumping());
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(original);
  });

  it("does not verify when asked not to", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const deps = bumping();
    const outcome = await applyPlan({ cwd: dir, runId, verify: false }, deps);
    expect(deps.verify).not.toHaveBeenCalled();
    expect(outcome.items.every((item) => item.verification === undefined)).toBe(true);
  });

  it("does not verify an item that did not apply", async () => {
    const { runId } = await persistPlan(report([result({})]), {}, dir);
    const deps: RunDeps = {
      ...bumping(),
      applyItem: async () =>
        result({
          applied: false,
          dryRun: false,
          unresolvedReason: "install-failed",
          message: "no",
        }),
    };
    await applyPlan({ cwd: dir, runId }, deps);
    expect(deps.verify).not.toHaveBeenCalled();
  });
});

describe("verifyRun", () => {
  it("verifies an applied run against its snapshot and records the result", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await applyPlan({ cwd: dir, runId }, bumping());
    const deps = bumping();

    const verified = await verifyRun({ cwd: dir, runId, checks: ["scope", "vuln-gone"] }, deps);

    expect(verified).toMatchObject({ runId, passed: true });
    const request = vi.mocked(deps.verify).mock.calls[0]![0];
    expect(request.checks).toEqual(["scope", "vuln-gone"]);
    expect(JSON.parse(request.baseFiles.get("package.json")!).dependencies.lodash).toBe("4.17.20");
    expect(request.expectedRemaining).toEqual(["left-pad", "qs"]);
    expect(new RunStore(dir).hasFile(runId, "verification.json")).toBe(true);
    expect(getRun({ cwd: dir, runId }).ledger.events.at(-1)).toMatchObject({
      type: "verify",
      data: { passed: true },
    });
  });

  it("treats items that were never applied as expected to remain", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    const first = getRun({ cwd: dir, runId }).plan!.items[0]!;
    await applyPlan({ cwd: dir, runId, itemIds: [first.itemId] }, bumping());
    const deps = bumping();

    await verifyRun({ cwd: dir, runId }, deps);

    expect(vi.mocked(deps.verify).mock.calls[0]![0].expectedRemaining).toEqual([
      "left-pad",
      "qs",
      "minimist",
    ]);
  });

  it("has nothing to verify before a run was applied", async () => {
    const { runId } = await persistPlan(twoItemReport(), {}, dir);
    await expect(verifyRun({ cwd: dir, runId }, bumping())).rejects.toThrow(/nothing to verify/);
  });
});
