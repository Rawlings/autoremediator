import { describe, expect, it } from "vitest";
import type { PortfolioTarget } from "../../platform/types.js";
import { rankPortfolioTargets, scorePortfolioTarget } from "./risk-score.js";

function makeTarget(overrides: Partial<PortfolioTarget> = {}): PortfolioTarget {
  return {
    cwd: "/tmp/project",
    cveId: "CVE-2021-23337",
    ...overrides,
  };
}

describe("scorePortfolioTarget", () => {
  it("returns 0 when riskHint is absent", () => {
    expect(scorePortfolioTarget(makeTarget())).toBe(0);
  });

  it("applies severity weights", () => {
    expect(scorePortfolioTarget(makeTarget({ riskHint: { severity: "CRITICAL" } }))).toBe(40);
    expect(scorePortfolioTarget(makeTarget({ riskHint: { severity: "HIGH" } }))).toBe(30);
    expect(scorePortfolioTarget(makeTarget({ riskHint: { severity: "MEDIUM" } }))).toBe(10);
    expect(scorePortfolioTarget(makeTarget({ riskHint: { severity: "LOW" } }))).toBe(5);
    expect(scorePortfolioTarget(makeTarget({ riskHint: { severity: "UNKNOWN" } }))).toBe(0);
  });

  it("adds exploit and SLA bonuses", () => {
    const score = scorePortfolioTarget(
      makeTarget({
        riskHint: {
          severity: "HIGH",
          exploitSignal: true,
          slaBreached: true,
        },
      })
    );

    expect(score).toBe(75);
  });
});

describe("rankPortfolioTargets", () => {
  it("sorts descending by score and returns one-based ranks", () => {
    const low = makeTarget({ cwd: "/tmp/low", riskHint: { severity: "LOW" } });
    const high = makeTarget({ cwd: "/tmp/high", riskHint: { severity: "HIGH" } });
    const criticalWithExploit = makeTarget({
      cwd: "/tmp/critical",
      riskHint: { severity: "CRITICAL", exploitSignal: true },
    });

    const ranked = rankPortfolioTargets([low, criticalWithExploit, high]);

    expect(ranked).toEqual([
      { target: criticalWithExploit, rank: 1 },
      { target: high, rank: 2 },
      { target: low, rank: 3 },
    ]);
  });

  it("keeps input order for equal scores", () => {
    const first = makeTarget({ cwd: "/tmp/first" });
    const second = makeTarget({ cwd: "/tmp/second" });

    const ranked = rankPortfolioTargets([first, second]);

    expect(ranked).toEqual([
      { target: first, rank: 1 },
      { target: second, rank: 2 },
    ]);
  });
});
