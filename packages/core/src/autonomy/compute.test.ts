import { describe, expect, it } from "vitest";

import { evaluate, effectiveLevel, nextPromotion, signalsFor, transitionsOf } from "./compute.js";
import {
  type AutonomyConfig,
  type AutonomyLevel,
  resolveAutonomyConfig,
  type TrackEvent,
  type TrackEventType,
} from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (days: number) => new Date(T0 + days * DAY);

const config = (overrides: Partial<AutonomyConfig> = {}): AutonomyConfig => ({
  ...resolveAutonomyConfig({ ceiling: "L4" }),
  ...overrides,
});

/** Build a record from compact specs; sequence numbers and run ids are assigned in order. */
function record(
  specs: Array<{
    type: TrackEventType;
    day?: number;
    run?: number;
    tests?: boolean;
    typecheck?: boolean;
  }>,
): TrackEvent[] {
  return specs.map((spec, index) => ({
    seq: index + 1,
    at: at(spec.day ?? index * 0.01).toISOString(),
    type: spec.type,
    runId: `run_${String(spec.run ?? index + 1).padStart(20, "0")}`,
    cveIds: ["CVE-2021-0001"],
    packages: ["dep"],
    coverage: { tests: spec.tests ?? false, typecheck: spec.typecheck ?? false },
    detail: "test",
  }));
}

const verified = (count: number, extra: { tests?: boolean; typecheck?: boolean } = {}) =>
  Array.from({ length: count }, () => ({ type: "applied-verified" as const, ...extra }));

const levelAt = (events: TrackEvent[], cfg: AutonomyConfig, now: Date) =>
  effectiveLevel(evaluate(events, cfg, now), cfg);

describe("earned level", () => {
  const cases: Array<{
    name: string;
    cfg?: Partial<AutonomyConfig>;
    specs: Parameters<typeof record>[0];
    now?: number;
    earned: AutonomyLevel;
    level: AutonomyLevel;
  }> = [
    { name: "empty record starts at L2", specs: [], earned: "L2", level: "L2" },
    {
      name: "the ceiling lowers an empty record",
      cfg: { ceiling: "L1" },
      specs: [],
      earned: "L2",
      level: "L1",
    },
    { name: "the ceiling can be L0", cfg: { ceiling: "L0" }, specs: [], earned: "L2", level: "L0" },
    {
      name: "four verified runs with tests are not enough for L3 (needs 5)",
      specs: verified(4, { tests: true }),
      earned: "L2",
      level: "L2",
    },
    {
      name: "five verified runs with tests reach L3",
      specs: verified(5, { tests: true }),
      earned: "L3",
      level: "L3",
    },
    {
      name: "five verified runs without test coverage stay at L2 when coverage is required",
      specs: verified(5),
      earned: "L2",
      level: "L2",
    },
    {
      name: "coverage is not needed when requireTestCoverage is off",
      cfg: { requireTestCoverage: false },
      specs: verified(5),
      earned: "L3",
      level: "L3",
    },
    {
      name: "L4 needs twice the runs, tests and a type check",
      specs: verified(10, { tests: true, typecheck: true }),
      earned: "L4",
      level: "L4",
    },
    {
      name: "ten runs with tests but no type check stop at L3",
      specs: verified(10, { tests: true }),
      earned: "L3",
      level: "L3",
    },
    {
      name: "the ceiling caps an earned L4",
      cfg: { ceiling: "L2" },
      specs: verified(10, { tests: true, typecheck: true }),
      earned: "L4",
      level: "L2",
    },
    {
      name: "unverified applies are not evidence",
      specs: Array.from({ length: 8 }, () => ({
        type: "applied-unverified" as const,
        tests: true,
      })),
      earned: "L2",
      level: "L2",
    },
    {
      name: "a failed apply lowers the success rate below the bar",
      // 5 verified of 6 judged = 83% < 90%
      specs: [...verified(5, { tests: true }), { type: "apply-failed" as const }],
      earned: "L2",
      level: "L2",
    },
    {
      name: "success rate at the bar still qualifies",
      cfg: { minSuccessRate: 0.8 },
      specs: [...verified(5, { tests: true }), { type: "apply-failed" as const }],
      earned: "L3",
      level: "L3",
    },
    {
      name: "a rollback demotes immediately to L1",
      specs: [...verified(5, { tests: true }), { type: "rollback" as const, run: 1, day: 1 }],
      now: 1.5,
      earned: "L1",
      level: "L1",
    },
    {
      name: "a verifier failure demotes immediately to L1",
      specs: [...verified(5, { tests: true }), { type: "verifier-failure" as const, day: 1 }],
      now: 1.5,
      earned: "L1",
      level: "L1",
    },
    {
      name: "two incidents in the cooldown go to L0",
      specs: [
        ...verified(5, { tests: true }),
        { type: "rollback" as const, run: 1, day: 1 },
        { type: "verifier-failure" as const, run: 99, day: 2 },
      ],
      now: 2.5,
      earned: "L0",
      level: "L0",
    },
    {
      name: "several incidents on one run are one incident",
      specs: [
        ...verified(5, { tests: true }),
        { type: "verifier-failure" as const, run: 1, day: 1 },
        { type: "rollback" as const, run: 1, day: 1.1 },
      ],
      now: 2,
      earned: "L1",
      level: "L1",
    },
    {
      name: "after the cooldown the cap lifts, but the incident still blocks L3 while in the window",
      specs: [...verified(5, { tests: true }), { type: "rollback" as const, run: 1, day: 1 }],
      now: 9,
      earned: "L2",
      level: "L2",
    },
    {
      name: "cooldownDays 0 never caps, though the incident still blocks promotion",
      cfg: { cooldownDays: 0 },
      specs: [...verified(5, { tests: true }), { type: "rollback" as const, run: 1, day: 1 }],
      now: 1.1,
      earned: "L2",
      level: "L2",
    },
    {
      name: "the incident leaves the window after enough newer outcomes and L3 returns",
      cfg: { window: 10, minVerifiedRuns: 5 },
      specs: [{ type: "rollback" as const, run: 1, day: 1 }, ...verified(10, { tests: true })],
      now: 30,
      earned: "L3",
      level: "L3",
    },
    {
      name: "verifyRun evidence adds coverage to its run",
      specs: [
        ...verified(5),
        ...[1, 2, 3, 4, 5].map((run) => ({ type: "verify-passed" as const, run, tests: true })),
      ],
      // the verify-passed events are for runs 1..5, whose apply events are the first five
      earned: "L3",
      level: "L3",
    },
  ];

  for (const testCase of cases) {
    it(`gives ${testCase.earned} earned and ${testCase.level} in force: ${testCase.name}`, () => {
      const cfg = config(testCase.cfg);
      const events = record(testCase.specs);
      const now = at(testCase.now ?? 0.5);
      const evaluation = evaluate(events, cfg, now);
      expect(evaluation.earned).toBe(testCase.earned);
      expect(effectiveLevel(evaluation, cfg)).toBe(testCase.level);
    });
  }

  it("is deterministic: the same inputs give the same evaluation", () => {
    const events = record([...verified(7, { tests: true }), { type: "apply-failed" }]);
    const first = evaluate(events, config(), at(3));
    const second = evaluate(structuredClone(events), config(), at(3));
    expect(second).toEqual(first);
  });

  it("counts only the recent window", () => {
    // Twenty old failures followed by five fresh verified runs: with a window of 5 only the latter count.
    const events = record([
      ...Array.from({ length: 20 }, () => ({ type: "apply-failed" as const })),
      ...verified(5, { tests: true }),
    ]);
    expect(evaluate(events, config({ window: 10 }), at(1)).stats).toMatchObject({
      verifiedRuns: 5,
      failedRuns: 5,
    });
    expect(evaluate(events, config({ window: 5, minVerifiedRuns: 2 }), at(1)).stats).toMatchObject({
      outcomes: 5,
      verifiedRuns: 5,
      failedRuns: 0,
      successRate: 1,
    });
  });

  it("applies the window to distinct runs, so runs with several items can still reach L4", () => {
    // Ten verified runs of three items each: thirty events, but only ten runs.
    const specs = Array.from({ length: 10 }, (_, run) =>
      Array.from({ length: 3 }, () => ({
        type: "applied-verified" as const,
        run: run + 1,
        tests: true,
        typecheck: true,
      })),
    ).flat();
    const events = record(specs);
    const evaluation = evaluate(events, config({ window: 20 }), at(1));
    expect(evaluation.stats).toMatchObject({ runs: 10, verifiedRuns: 10, outcomes: 30 });
    expect(evaluation.earned).toBe("L4");
  });

  it("keeps only the last N runs, however many events each has, and drops older ones whole", () => {
    // Run 1 failed (one event); runs 2-4 verified with two events each. A window of 3 runs ends at run 2.
    const events = record([
      { type: "apply-failed", run: 1 },
      ...[2, 3, 4].flatMap((run) => [
        { type: "applied-verified" as const, run, tests: true },
        { type: "applied-verified" as const, run, tests: true },
      ]),
    ]);
    expect(evaluate(events, config({ window: 3, minVerifiedRuns: 1 }), at(1)).stats).toMatchObject({
      runs: 3,
      outcomes: 6,
      verifiedRuns: 3,
      failedRuns: 0,
    });
    expect(evaluate(events, config({ window: 4, minVerifiedRuns: 1 }), at(1)).stats).toMatchObject({
      runs: 4,
      failedRuns: 1,
    });
  });

  it("counts a run as verified when it has a verified change and no incident or failed apply", () => {
    const events = record([
      { type: "applied-verified", run: 1 },
      { type: "applied-unverified", run: 1 },
      { type: "applied-verified", run: 2 },
      { type: "rollback", run: 2 },
      { type: "applied-verified", run: 3 },
      { type: "apply-failed", run: 3 },
    ]);
    expect(evaluate(events, config(), at(1)).stats).toMatchObject({
      verifiedRuns: 1,
      incidentRuns: 1,
      failedRuns: 1,
    });
  });

  it("counts coverage per verified run, not per event", () => {
    const events = record([
      { type: "applied-verified", run: 1, tests: true, typecheck: true },
      { type: "applied-verified", run: 1, tests: true, typecheck: true },
      { type: "applied-verified", run: 2 },
    ]);
    expect(evaluate(events, config(), at(1)).stats).toMatchObject({
      verifiedRuns: 2,
      testsCoveredRuns: 1,
      typecheckCoveredRuns: 1,
    });
  });
});

describe("explanations", () => {
  it("cites the incident behind a cap", () => {
    const events = record([...verified(5, { tests: true }), { type: "rollback", run: 3, day: 1 }]);
    const evaluation = evaluate(events, config(), at(2));
    expect(evaluation.cap).toMatchObject({
      level: "L1",
      eventSeqs: [6],
      runIds: [`run_${"3".padStart(20, "0")}`],
    });
    expect(evaluation.cap?.until).toBe(at(8).toISOString());
    expect(evaluation.reasons[0]).toContain("rollback");
    expect(evaluation.reasons[0]).toContain("event #6");
  });

  it("lists what the next promotion needs", () => {
    const events = record(verified(3, { tests: true }));
    const evaluation = evaluate(events, config(), at(1));
    const next = nextPromotion(evaluation, config())!;
    expect(next.to).toBe("L3");
    expect(next.blockedByCeiling).toBe(false);
    expect(
      next.requirements
        .filter((requirement) => !requirement.met)
        .map((requirement) => requirement.name),
    ).toEqual(["verified runs", "verified runs whose tests passed"]);
  });

  it("says when the ceiling is what blocks the next level, and has nothing after L4", () => {
    const evaluation = evaluate(
      record(verified(5, { tests: true })),
      config({ ceiling: "L2" }),
      at(1),
    );
    expect(nextPromotion(evaluation, config({ ceiling: "L2" }))).toMatchObject({
      to: "L3",
      blockedByCeiling: true,
    });
    const top = evaluate(record(verified(10, { tests: true, typecheck: true })), config(), at(1));
    expect(nextPromotion(top, config())).toBeUndefined();
  });

  it("points at the end of the cooldown when a cap is what holds the level down", () => {
    const events = record([{ type: "rollback", day: 1 }]);
    const evaluation = evaluate(events, config(), at(2));
    expect(nextPromotion(evaluation, config())).toMatchObject({
      to: "L2",
      cappedUntil: at(8).toISOString(),
      requirements: [],
    });
  });
});

describe("transitions", () => {
  it("replays promotions and demotions, each citing its cause", () => {
    const events = record([
      ...verified(5, { tests: true }), // seq 1..5: promoted to L3 at seq 5
      { type: "rollback", run: 1, day: 1 }, // seq 6: demoted to L1
      { type: "applied-verified", day: 20, tests: true }, // seq 7: cooldown over, back to L2
    ]);
    const changes = transitionsOf(events, config(), at(20));
    expect(
      changes.map((change) => [change.from, change.to, change.cause, change.eventSeq]),
    ).toEqual([
      ["L2", "L3", "event", 5],
      ["L3", "L1", "event", 6],
      ["L1", "L2", "cooldown", undefined],
    ]);
    expect(changes[0]?.direction).toBe("promotion");
    expect(changes[0]?.reason).toContain("verified runs: 5");
    expect(changes[1]).toMatchObject({ direction: "demotion", eventSeqs: [6] });
    expect(changes[1]?.reason).toContain("rollback");
    expect(changes[2]?.reason).toContain("cap ended");
  });

  it("shows a cooldown that ended after the last event", () => {
    const events = record([{ type: "rollback", day: 1 }]);
    expect(transitionsOf(events, config(), at(2)).map((change) => change.to)).toEqual(["L1"]);
    expect(transitionsOf(events, config(), at(10)).map((change) => change.to)).toEqual([
      "L1",
      "L2",
    ]);
  });

  it("explains a demotion that is not an incident", () => {
    const events = record([
      ...verified(5, { tests: true }),
      { type: "apply-failed" },
      { type: "apply-failed" },
    ]);
    const changes = transitionsOf(events, config(), at(1));
    expect(changes.at(-1)).toMatchObject({
      from: "L3",
      to: "L2",
      direction: "demotion",
      cause: "event",
    });
    expect(changes.at(-1)?.reason).toContain("success rate");
  });

  it("has no transitions for an empty or steady record", () => {
    expect(transitionsOf([], config(), at(1))).toEqual([]);
    expect(transitionsOf(record(verified(2)), config(), at(1))).toEqual([]);
  });
});

describe("level signals", () => {
  const clean = { fullyApplied: true, allVerified: true, anyMajorBump: false, anyFailed: false };
  const cases: Array<[AutonomyLevel, Partial<typeof clean>, boolean, boolean]> = [
    ["L2", {}, false, false],
    ["L3", {}, true, false],
    ["L3", { anyMajorBump: true }, false, false],
    ["L3", { fullyApplied: false }, false, false],
    ["L3", { anyFailed: true }, false, false],
    ["L4", {}, true, false],
    ["L4", { anyMajorBump: true }, true, true],
    ["L4", { fullyApplied: false, anyFailed: true }, false, true],
    ["L4", { allVerified: false }, false, true],
  ];
  for (const [level, facts, eligible, escalate] of cases) {
    it(`${level} with ${JSON.stringify(facts)} -> autoMergeEligible ${eligible}, escalate ${escalate}`, () => {
      const signals = signalsFor(level, { ...clean, ...facts });
      expect(signals).toMatchObject({ autoMergeEligible: eligible, escalate });
    });
  }
});

describe("effective level is min(ceiling, earned)", () => {
  const levels: AutonomyLevel[] = ["L0", "L1", "L2", "L3", "L4"];
  for (const ceiling of levels) {
    it(`ceiling ${ceiling} never exceeds itself`, () => {
      const cfg = config({ ceiling });
      const events = record(verified(10, { tests: true, typecheck: true }));
      const level = levelAt(events, cfg, at(1));
      expect(Number(level.slice(1))).toBeLessThanOrEqual(Number(ceiling.slice(1)));
      expect(level).toBe(ceiling);
    });
  }
});
