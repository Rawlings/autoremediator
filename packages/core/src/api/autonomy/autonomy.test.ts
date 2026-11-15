/**
 * Earned autonomy through the run operations, on a real git repository, with the real verifier and
 * the real track record file. Only the package-manager calls and the advisory pipeline are replaced.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendTrackEvents, readTrackRecord, recordPathOf } from "../../autonomy/record.js";
import type { NewTrackEvent } from "../../autonomy/types.js";
import type { PatchResult, RemediationReport } from "../../platform/types.js";
import { verify } from "../../remediation/verify/verifier.js";
import { planRemediation, remediate } from "../remediate/index.js";
import {
  applyPlan,
  getRun,
  persistPlan,
  rollbackRun,
  type RunDeps,
  verifyRun,
} from "../runs/index.js";
import {
  assertAutonomyAllows,
  AutonomyRefusedError,
  getAutonomy,
  recordAutonomyEvents,
} from "./index.js";

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

const pipeline = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../remediation/local/index.js", () => ({ runLocalRemediationPipeline: pipeline.run }));

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
const read = (file: string) => readFileSync(join(dir, file), "utf8");
const setLodash = (version: string) =>
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", dependencies: { lodash: version } }, null, 2),
  );
const policy = (autonomy: string | undefined, extra = "") => {
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(
    join(dir, ".github/autoremediator.yml"),
    `${extra}${autonomy ? `autonomy:\n${autonomy}\n` : "allowMajorBumps: false\n"}`,
  );
  git("add", "-A");
  git("commit", "-q", "-m", "policy", "--allow-empty");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autonomy-"));
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  setLodash("4.17.20");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
  // Run state stays out of git; the track record is the one file there that is committed.
  writeFileSync(join(dir, ".gitignore"), ".autoremediator/*\n!.autoremediator/track-record.json\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  pipeline.run.mockReset();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const preview = (from = "4.17.20", to = "4.17.21"): RemediationReport => ({
  cveId: "CVE-2021-23337",
  cveDetails: {
    id: "CVE-2021-23337",
    summary: "",
    severity: "HIGH",
    references: [],
    affectedPackages: [
      {
        name: "lodash",
        ecosystem: "npm",
        vulnerableRange: `<${to}`,
        firstPatchedVersion: to,
        source: "osv",
      },
    ],
  },
  vulnerablePackages: [],
  summary: "preview",
  results: [
    {
      packageName: "lodash",
      strategy: "version-bump",
      fromVersion: from,
      toVersion: to,
      applied: false,
      dryRun: true,
      message: "planned",
      dependencyScope: "direct",
    },
  ],
});

const applied = (): PatchResult => ({
  packageName: "lodash",
  strategy: "version-bump",
  fromVersion: "4.17.20",
  toVersion: "4.17.21",
  applied: true,
  dryRun: false,
  message: "applied",
});

const depsThat = (change: () => void): RunDeps => ({
  applyItem: vi.fn(async () => {
    change();
    return applied();
  }),
  reinstall: vi.fn(async () => undefined),
  verify: (request) => verify(request),
  attempt: async () => {
    throw new Error("no repair attempt expected");
  },
});
const goodChange = () => setLodash("4.17.21");
/** A change the verifier must reject: it edits project source. */
const badChange = () => {
  setLodash("4.17.21");
  writeFileSync(join(dir, "index.js"), "module.exports = 2;\n");
};

const runId = (n: number) => `run_${String(n).padStart(20, "0")}`;
const seed = (count: number, extra: Partial<NewTrackEvent> = {}) =>
  appendTrackEvents(
    dir,
    Array.from({ length: count }, (_, i) => ({
      type: "applied-verified" as const,
      runId: runId(i + 1),
      cveIds: ["CVE-2021-23337"],
      packages: ["lodash"],
      coverage: { tests: true, typecheck: false },
      detail: "seeded",
      ...extra,
    })),
  );

describe("without an autonomy key in the policy", () => {
  it("changes nothing: no refusal, no record file, no autonomy on the report", async () => {
    policy(undefined);
    const { runId: id } = await persistPlan(preview(), {}, dir);
    const report = await applyPlan({ cwd: dir, runId: id }, depsThat(goodChange));

    expect(report.status).toBe("applied");
    expect(report.autonomy).toBeUndefined();
    expect(existsSync(recordPathOf(dir))).toBe(false);
    expect(getAutonomy({ cwd: dir })).toMatchObject({ configured: false });
    expect(() => assertAutonomyAllows(dir, undefined, "apply", "anything")).not.toThrow();
  });
});

describe("a caller-supplied policy cannot lift the repository's ceiling", () => {
  it("inline policy that has no autonomy key still leaves the repo's L1 in force", () => {
    policy("  ceiling: L1");
    for (const inline of ["{}", "---\nallowMajorBumps: true\n", '{"autonomy":{"ceiling":"L4"}}']) {
      expect(() => assertAutonomyAllows(dir, inline, "apply", "anything")).toThrow(AutonomyRefusedError);
    }
  });

  it("an explicit policy may make it stricter", () => {
    policy("  ceiling: L3");
    expect(() => assertAutonomyAllows(dir, undefined, "apply", "anything")).not.toThrow();
    expect(() => assertAutonomyAllows(dir, '{"autonomy":{"ceiling":"L1"}}', "apply", "anything")).toThrow(
      AutonomyRefusedError,
    );
  });

  it("a caller policy cannot relax the evidence rules while lowering the ceiling", () => {
    policy("  ceiling: L4");
    const relaxed =
      "{autonomy:{ceiling: L3, minVerifiedRuns: 1, window: 2, minSuccessRate: 0, cooldownDays: 0, requireTestCoverage: false}}";
    const status = getAutonomy({ cwd: dir, policy: relaxed });
    expect(status.ceiling).toBe("L3");
    const { ceiling: _lowered, ...applied } = status.settings!;
    const { ceiling: _repo, ...repo } = getAutonomy({ cwd: dir }).settings!;
    expect(applied).toEqual(repo);
  });

  it("getAutonomy reports the repo's ceiling whatever policy is passed", () => {
    policy("  ceiling: L2");
    expect(getAutonomy({ cwd: dir, policy: "{}" }).ceiling).toBe("L2");
  });
});

describe("gating by level", () => {
  it("L1 (ceiling) refuses applyPlan, says why, and changes nothing", async () => {
    policy("  ceiling: L1");
    const { runId: id } = await persistPlan(preview(), {}, dir);
    const deps = depsThat(goodChange);

    const refusal = applyPlan({ cwd: dir, runId: id }, deps);
    await expect(refusal).rejects.toBeInstanceOf(AutonomyRefusedError);
    await expect(refusal).rejects.toThrow(
      /autonomy is L1 \(suggest\).*policy ceiling is L1.*Nothing was changed/s,
    );

    expect(deps.applyItem).not.toHaveBeenCalled();
    expect(read("package.json")).toContain("4.17.20");
    expect(getRun({ cwd: dir, runId: id }).run.status).toBe("planned");
    expect(existsSync(recordPathOf(dir))).toBe(false);
  });

  it("L0 (ceiling) refuses direct remediation, and plans nothing but still reports findings", async () => {
    policy("  ceiling: L0");
    pipeline.run.mockResolvedValue({ ...preview(), results: [] });

    await expect(remediate("CVE-2021-23337", { cwd: dir })).rejects.toThrow(
      /autonomy is L0 \(observe\)/,
    );
    expect(pipeline.run).not.toHaveBeenCalled();

    const plan = await planRemediation("CVE-2021-23337", { cwd: dir });
    expect(plan.runId).toBeUndefined();
    expect(plan.autonomy).toMatchObject({ level: "L0", ceiling: "L0", autoMergeEligible: false });
    expect(plan.summary).toContain("Autonomy is L0 (observe)");
    expect(existsSync(join(dir, ".autoremediator/runs"))).toBe(false);
  });

  it("L1 still plans, and a dry run is never refused", async () => {
    policy("  ceiling: L1");
    pipeline.run.mockResolvedValue(preview());

    const plan = await planRemediation("CVE-2021-23337", { cwd: dir });
    expect(plan.runId).toMatch(/^run_/);
    expect(plan.autonomy).toMatchObject({ level: "L1", ceiling: "L1", earned: "L2" });

    await expect(remediate("CVE-2021-23337", { cwd: dir, dryRun: true })).resolves.toMatchObject({
      autonomy: { level: "L1" },
    });
    await expect(remediate("CVE-2021-23337", { cwd: dir })).rejects.toThrow(AutonomyRefusedError);
  });

  it("L2 applies, records what happened, and says so on the report", async () => {
    policy("  ceiling: L2");
    const { runId: id } = await persistPlan(preview(), { runTests: true }, dir);
    const report = await applyPlan({ cwd: dir, runId: id }, depsThat(goodChange));

    expect(report.status).toBe("applied");
    expect(report.autonomy).toMatchObject({
      level: "L2",
      earned: "L2",
      autoMergeEligible: false,
      escalate: false,
    });

    const events = readTrackRecord(dir).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      type: "applied-verified",
      runId: id,
      cveIds: ["CVE-2021-23337"],
      packages: ["lodash"],
      coverage: { tests: true, typecheck: false },
    });
    expect(getRun({ cwd: dir, runId: id }).ledger.ok).toBe(true);
  });

  it("L3 marks a clean, verified, non-major run as auto-merge eligible, without merging anything", async () => {
    policy("  ceiling: L3");
    await seed(5);
    expect(getAutonomy({ cwd: dir })).toMatchObject({ level: "L3", earned: "L3" });

    const { runId: id } = await persistPlan(preview(), {}, dir);
    const report = await applyPlan({ cwd: dir, runId: id }, depsThat(goodChange));
    expect(report.autonomy).toMatchObject({
      level: "L3",
      autoMergeEligible: true,
      escalate: false,
    });
    // Nothing was committed or merged by Autoremediator.
    expect(
      execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n"),
    ).toHaveLength(2);
  });

  it("L4 still verifies a major bump, but escalates it to a person", async () => {
    policy("  ceiling: L4", "allowMajorBumps: true\n");
    await seed(10, { coverage: { tests: true, typecheck: true } } as Partial<NewTrackEvent>);
    expect(getAutonomy({ cwd: dir })).toMatchObject({ level: "L4" });

    const { runId: id } = await persistPlan(preview("4.17.20", "5.0.0"), {}, dir);
    const deps = depsThat(() => setLodash("5.0.0"));
    const report = await applyPlan({ cwd: dir, runId: id }, deps);
    expect(report.status).toBe("applied");
    expect(report.autonomy).toMatchObject({ level: "L4", autoMergeEligible: true, escalate: true });
    expect(report.autonomy?.note).toContain("major version bump");
  });
});

describe("demotion and promotion from real events", () => {
  it("a verifier failure on an applied change demotes at once, and the next apply is refused with the evidence", async () => {
    policy("  ceiling: L3");
    await seed(5);
    expect(getAutonomy({ cwd: dir }).level).toBe("L3");

    const first = await persistPlan(preview(), {}, dir);
    const rejected = await applyPlan({ cwd: dir, runId: first.runId }, depsThat(badChange));
    expect(rejected.items[0]).toMatchObject({ status: "failed" });
    expect(rejected.items[0]?.verification?.passed).toBe(false);
    expect(rejected.autonomy).toMatchObject({ level: "L1" });
    expect(read("index.js")).toBe("module.exports = 1;\n"); // the verifier took it back out

    const events = readTrackRecord(dir).events;
    expect(events.at(-1)).toMatchObject({ type: "verifier-failure", runId: first.runId });

    const status = getAutonomy({ cwd: dir });
    expect(status).toMatchObject({
      level: "L1",
      earned: "L1",
      allows: { plan: true, apply: false },
    });
    expect(status.history?.map((change) => [change.from, change.to, change.eventSeq])).toEqual([
      ["L2", "L3", 5],
      ["L3", "L1", 6],
    ]);
    expect(status.history?.[1]?.reason).toContain(first.runId);

    const second = await persistPlan(preview(), {}, dir);
    await expect(
      applyPlan({ cwd: dir, runId: second.runId }, depsThat(goodChange)),
    ).rejects.toThrow(new RegExp(`autonomy is L1.*verifier failure on ${first.runId}`, "s"));
  });

  it("a rollback demotes at once", async () => {
    policy("  ceiling: L3");
    const { runId: id } = await persistPlan(preview(), {}, dir);
    await applyPlan({ cwd: dir, runId: id }, depsThat(goodChange));
    expect(getAutonomy({ cwd: dir }).level).toBe("L2");

    await rollbackRun({ cwd: dir, runId: id }, depsThat(goodChange));
    const events = readTrackRecord(dir).events;
    expect(events.map((event) => event.type)).toEqual(["applied-verified", "rollback"]);
    expect(getAutonomy({ cwd: dir })).toMatchObject({
      level: "L1",
      cap: { level: "L1", runIds: [id] },
    });
  });

  it("a rollback of a run that changed nothing is not an incident", async () => {
    policy("  ceiling: L3");
    const { runId: id } = await persistPlan(preview(), {}, dir);
    const failing: RunDeps = {
      ...depsThat(goodChange),
      applyItem: async () => ({
        ...applied(),
        applied: false,
        unresolvedReason: "install-failed",
        message: "boom",
      }),
    };
    const report = await applyPlan({ cwd: dir, runId: id }, failing);
    expect(report.status).toBe("partial");
    expect(readTrackRecord(dir).events.map((event) => event.type)).toEqual(["apply-failed"]);

    await rollbackRun({ cwd: dir, runId: id, force: true }, failing);
    expect(readTrackRecord(dir).events.map((event) => event.type)).toEqual(["apply-failed"]);
    expect(getAutonomy({ cwd: dir }).level).toBe("L2");
  });

  it("verifyRun records a failure as an incident and a pass with tests as coverage", async () => {
    policy("  ceiling: L3");
    const { runId: id } = await persistPlan(preview(), {}, dir);
    await applyPlan({ cwd: dir, runId: id }, depsThat(goodChange));

    // The change is later undone by hand: the advisory is back, so verification fails.
    setLodash("4.17.20");
    const failed = await verifyRun(
      { cwd: dir, runId: id, checks: ["vuln-gone"], offline: true },
      depsThat(goodChange),
    );
    expect(failed.passed).toBe(false);
    expect(readTrackRecord(dir).events.at(-1)).toMatchObject({
      type: "verifier-failure",
      runId: id,
    });
    expect(getAutonomy({ cwd: dir }).level).toBe("L1");
  });

  it("a run that earns the promotion is not itself marked auto-merge eligible", async () => {
    policy("  ceiling: L3\n  minVerifiedRuns: 2\n  window: 4");
    await seed(1);
    const { runId: id } = await persistPlan(preview(), { runTests: true }, dir);
    const report = await applyPlan({ cwd: dir, runId: id }, depsThat(goodChange));

    expect(getAutonomy({ cwd: dir }).level).toBe("L3");
    expect(report.autonomy).toMatchObject({
      level: "L3",
      autoMergeEligible: false,
      escalate: false,
    });
    expect(report.autonomy?.note).toContain("applies from the next run");
  });

  it("promotes when the record meets the requirements, and says exactly what it met", async () => {
    policy("  ceiling: L4\n  minVerifiedRuns: 2\n  window: 4");
    const ids: string[] = [];
    for (const [from, to] of [
      ["4.17.20", "4.17.21"],
      ["4.17.21", "4.17.22"],
    ] as const) {
      const planned = await persistPlan(preview(from, to), { runTests: true }, dir);
      ids.push(planned.runId);
      await applyPlan(
        { cwd: dir, runId: planned.runId },
        {
          ...depsThat(() => setLodash(to)),
          applyItem: async () => {
            setLodash(to);
            return { ...applied(), fromVersion: from, toVersion: to };
          },
        },
      );
    }
    const status = getAutonomy({ cwd: dir });
    expect(status).toMatchObject({
      level: "L3",
      earned: "L3",
      evidence: { verifiedRuns: 2, testsCoveredRuns: 2, incidentRuns: 0, events: 2 },
    });
    expect(status.history).toHaveLength(1);
    expect(status.history?.[0]).toMatchObject({
      from: "L2",
      to: "L3",
      direction: "promotion",
      eventSeq: 2,
    });
    expect(status.nextPromotion?.to).toBe("L4");
    expect(ids).toHaveLength(2);
  });
});

describe("robustness", () => {
  it("never fails or undoes a run because the record could not be written", async () => {
    policy("  ceiling: L3");
    mkdirSync(join(dir, ".autoremediator"), { recursive: true });
    writeFileSync(join(dir, ".autoremediator/locks"), "a file where the lock directory should be");

    const { runId: id } = await persistPlan(preview(), {}, dir);
    const report = await applyPlan({ cwd: dir, runId: id }, depsThat(goodChange));

    expect(report.status).toBe("applied");
    expect(read("package.json")).toContain("4.17.21");
    expect(existsSync(recordPathOf(dir))).toBe(false);
    const details = getRun({ cwd: dir, runId: id });
    expect(details.ledger.events.some((event) => event.type === "autonomy.record-failed")).toBe(
      true,
    );
    expect(details.ledger.ok).toBe(true);
  });

  it("recordAutonomyEvents reports a problem instead of throwing", async () => {
    policy("  ceiling: L3");
    mkdirSync(join(dir, ".autoremediator"), { recursive: true });
    writeFileSync(join(dir, ".autoremediator/locks"), "x");
    const result = await recordAutonomyEvents(dir, undefined, [
      {
        type: "rollback",
        runId: runId(1),
        cveIds: [],
        packages: [],
        coverage: { tests: false, typecheck: false },
        detail: "x",
      },
    ]);
    expect(result.recorded).toBe(0);
    expect(result.problem).toBeTruthy();
  });

  it("records nothing when autonomy is not configured", async () => {
    policy(undefined);
    const result = await recordAutonomyEvents(dir, undefined, [
      {
        type: "rollback",
        runId: runId(1),
        cveIds: [],
        packages: [],
        coverage: { tests: false, typecheck: false },
        detail: "x",
      },
    ]);
    expect(result).toEqual({ recorded: 0 });
    expect(existsSync(recordPathOf(dir))).toBe(false);
  });

  it("treats a damaged record as L0 and refuses to apply, leaving the record as it is", async () => {
    policy("  ceiling: L3");
    mkdirSync(join(dir, ".autoremediator"), { recursive: true });
    writeFileSync(recordPathOf(dir), "{broken");
    const { runId: id } = await persistPlan(preview(), {}, dir);

    await expect(applyPlan({ cwd: dir, runId: id }, depsThat(goodChange))).rejects.toThrow(
      /autonomy is L0.*not valid JSON/s,
    );
    expect(read("package.json")).toContain("4.17.20");
    expect(read(".autoremediator/track-record.json")).toBe("{broken");
    expect(getAutonomy({ cwd: dir })).toMatchObject({
      level: "L0",
      recordError: expect.stringContaining("not valid JSON"),
    });
  });

  it("a committed record that changes after a run does not trip `runs verify`'s scope check", async () => {
    policy("  ceiling: L3");
    await seed(1);
    git("add", "-A");
    git("commit", "-q", "-m", "track record");

    const { runId: id } = await persistPlan(preview(), {}, dir);
    await applyPlan({ cwd: dir, runId: id }, depsThat(goodChange));
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }),
    ).toContain(".autoremediator/track-record.json");

    // A later run appends to the record after this run's snapshot was taken.
    await seed(1, { runId: runId(77) });
    const result = await verifyRun(
      { cwd: dir, runId: id, checks: ["scope"] },
      depsThat(goodChange),
    );
    expect(result.passed).toBe(true);
    expect(result.checks[0]).toMatchObject({ name: "scope", status: "passed" });
  });
});
