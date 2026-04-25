import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioTarget, RemediationReport } from "../../platform/types.js";
import type { ScanReport } from "../contracts.js";

const mocked = vi.hoisted(() => ({
  remediate: vi.fn(),
  remediateFromScan: vi.fn(),
}));

vi.mock("../remediate/index.js", () => ({ remediate: mocked.remediate }));
vi.mock("../remediate-from-scan/index.js", () => ({ remediateFromScan: mocked.remediateFromScan }));

import { remediatePortfolio } from "./index.js";

function makeRemediationReport(overrides: Partial<RemediationReport> = {}): RemediationReport {
  return {
    cveId: "CVE-2021-23337",
    cveDetails: null,
    vulnerablePackages: [],
    results: [],
    agentSteps: 0,
    summary: "ok",
    ...overrides,
  };
}

function makeScanReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    schemaVersion: "1.0",
    status: "ok",
    generatedAt: new Date().toISOString(),
    cveIds: [],
    reports: [],
    successCount: 0,
    failedCount: 0,
    errors: [],
    patchCount: 0,
    ...overrides,
  };
}

function makeTarget(overrides: Partial<PortfolioTarget> = {}): PortfolioTarget {
  return {
    cwd: "/tmp/service",
    cveId: "CVE-2021-23337",
    ...overrides,
  };
}

describe("remediatePortfolio campaignMode", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocked.remediate.mockResolvedValue(makeRemediationReport());
    mocked.remediateFromScan.mockResolvedValue(makeScanReport());
  });

  it("attaches threatRank to each result when campaignMode is true", async () => {
    const targets: PortfolioTarget[] = [
      makeTarget({ cwd: "/tmp/low", riskHint: { severity: "LOW" } }),
      makeTarget({ cwd: "/tmp/critical", riskHint: { severity: "CRITICAL" } }),
    ];

    const report = await remediatePortfolio(targets, { campaignMode: true });

    expect(report.targets).toHaveLength(2);
    for (const result of report.targets) {
      expect(result.threatRank).toBeDefined();
      expect(typeof result.threatRank).toBe("number");
    }
  });

  it("executes targets in descending risk order when campaignMode is true", async () => {
    const cwdOrder: string[] = [];
    mocked.remediate.mockImplementation((_cveId: string, opts: { cwd?: string }) => {
      cwdOrder.push(opts.cwd ?? "");
      return Promise.resolve(makeRemediationReport());
    });

    const targets: PortfolioTarget[] = [
      makeTarget({ cwd: "/tmp/low", riskHint: { severity: "LOW" } }),
      makeTarget({ cwd: "/tmp/high", riskHint: { severity: "HIGH" } }),
      makeTarget({ cwd: "/tmp/critical", riskHint: { severity: "CRITICAL" } }),
    ];

    await remediatePortfolio(targets, { campaignMode: true });

    expect(cwdOrder).toEqual(["/tmp/critical", "/tmp/high", "/tmp/low"]);
  });

  it("omits threatRank from results when campaignMode is false", async () => {
    const targets: PortfolioTarget[] = [
      makeTarget({ cwd: "/tmp/a", riskHint: { severity: "CRITICAL" } }),
    ];

    const report = await remediatePortfolio(targets, { campaignMode: false });

    expect(report.targets[0].threatRank).toBeUndefined();
  });

  it("omits threatRank from results when campaignMode is not set", async () => {
    const targets: PortfolioTarget[] = [
      makeTarget({ cwd: "/tmp/a", riskHint: { severity: "HIGH" } }),
    ];

    const report = await remediatePortfolio(targets, {});

    expect(report.targets[0].threatRank).toBeUndefined();
  });

  it("preserves original target order when campaignMode is not set", async () => {
    const cwdOrder: string[] = [];
    mocked.remediate.mockImplementation((_cveId: string, opts: { cwd?: string }) => {
      cwdOrder.push(opts.cwd ?? "");
      return Promise.resolve(makeRemediationReport());
    });

    const targets: PortfolioTarget[] = [
      makeTarget({ cwd: "/tmp/first", riskHint: { severity: "LOW" } }),
      makeTarget({ cwd: "/tmp/second", riskHint: { severity: "CRITICAL" } }),
    ];

    await remediatePortfolio(targets, {});

    expect(cwdOrder).toEqual(["/tmp/first", "/tmp/second"]);
  });

  it("forwards simulationMode to child remediation calls", async () => {
    await remediatePortfolio([makeTarget()], {
      dryRun: true,
      simulationMode: true,
    });

    expect(mocked.remediate).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({ dryRun: true, simulationMode: true })
    );
  });
});
