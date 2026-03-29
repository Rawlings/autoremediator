import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  runRemediationPipeline: vi.fn(),
  parseScanInput: vi.fn(),
  uniqueCveIds: vi.fn(),
  loadPolicy: vi.fn(),
  isPackageAllowed: vi.fn(),
  createEvidenceLog: vi.fn(),
  addEvidenceStep: vi.fn(),
  finalizeEvidence: vi.fn(),
  writeEvidenceLog: vi.fn(),
  readIdempotentReport: vi.fn(),
  storeIdempotentReport: vi.fn(),
}));

vi.mock("./remediation/pipeline.js", () => ({
  runRemediationPipeline: mocked.runRemediationPipeline,
}));

vi.mock("./scanner/index.js", () => ({
  parseScanInput: mocked.parseScanInput,
  uniqueCveIds: mocked.uniqueCveIds,
}));

vi.mock("./platform/policy.js", () => ({
  loadPolicy: mocked.loadPolicy,
  isPackageAllowed: mocked.isPackageAllowed,
}));

vi.mock("./platform/evidence.js", () => ({
  createEvidenceLog: mocked.createEvidenceLog,
  addEvidenceStep: mocked.addEvidenceStep,
  finalizeEvidence: mocked.finalizeEvidence,
  writeEvidenceLog: mocked.writeEvidenceLog,
}));

vi.mock("./platform/idempotency.js", () => ({
  readIdempotentReport: mocked.readIdempotentReport,
  storeIdempotentReport: mocked.storeIdempotentReport,
}));

import { planRemediation, remediate, remediateFromScan, toCiSummary } from "./api.js";

describe("api preview and correlation behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocked.parseScanInput.mockReturnValue([{ cveId: "CVE-2021-23337" }]);
    mocked.uniqueCveIds.mockReturnValue(["CVE-2021-23337"]);
    mocked.loadPolicy.mockReturnValue({
      allowMajorBumps: false,
      denyPackages: [],
      allowPackages: [],
    });
    mocked.isPackageAllowed.mockReturnValue(true);
    mocked.createEvidenceLog.mockReturnValue({
      runId: "run-1",
      cveIds: ["CVE-2021-23337"],
      cwd: "/tmp/project",
      startedAt: new Date().toISOString(),
      steps: [],
    });
    mocked.writeEvidenceLog.mockReturnValue("/tmp/project/.autoremediator/evidence/run-1.json");
    mocked.readIdempotentReport.mockReturnValue(undefined);
  });

  it("planRemediation forces preview and dryRun even when disabled in options", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 1,
      summary: "preview",
    });

    await planRemediation("CVE-2021-23337", {
      dryRun: false,
      preview: false,
      requestId: "req-123",
      sessionId: "session-abc",
      parentRunId: "parent-1",
    });

    expect(mocked.runRemediationPipeline).toHaveBeenCalledTimes(1);
    expect(mocked.runRemediationPipeline).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({
        dryRun: true,
        preview: true,
        requestId: "req-123",
        sessionId: "session-abc",
        parentRunId: "parent-1",
      })
    );
  });

  it("remediateFromScan propagates correlation to evidence and report", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 2,
      summary: "done",
    });

    const report = await remediateFromScan("./audit.json", {
      cwd: "/tmp/project",
      requestId: "req-42",
      sessionId: "session-nightly",
      parentRunId: "parent-root",
    });

    expect(mocked.createEvidenceLog).toHaveBeenCalledWith(
      "/tmp/project",
      ["CVE-2021-23337"],
      expect.objectContaining({
        requestId: "req-42",
        sessionId: "session-nightly",
        parentRunId: "parent-root",
      })
    );

    expect(report.correlation).toEqual({
      requestId: "req-42",
      sessionId: "session-nightly",
      parentRunId: "parent-root",
    });
  });

  it("auto-generates requestId once and reuses it across scan CVEs", async () => {
    mocked.uniqueCveIds.mockReturnValue(["CVE-2021-23337", "CVE-2021-44906"]);
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 1,
      summary: "done",
    });

    const report = await remediateFromScan("./audit.json", {
      cwd: "/tmp/project",
    });

    const evidenceCorrelation = mocked.createEvidenceLog.mock.calls[0]?.[2] as {
      requestId: string;
      sessionId?: string;
      parentRunId?: string;
    };

    expect(evidenceCorrelation.requestId).toMatch(/^req-\d+-[a-z0-9]{6}$/);
    expect(evidenceCorrelation.sessionId).toBeUndefined();
    expect(evidenceCorrelation.parentRunId).toBeUndefined();

    expect(mocked.runRemediationPipeline).toHaveBeenNthCalledWith(
      1,
      "CVE-2021-23337",
      expect.objectContaining({ requestId: evidenceCorrelation.requestId })
    );
    expect(mocked.runRemediationPipeline).toHaveBeenNthCalledWith(
      2,
      "CVE-2021-44906",
      expect.objectContaining({ requestId: evidenceCorrelation.requestId })
    );
    expect(report.correlation?.requestId).toBe(evidenceCorrelation.requestId);
  });

  it("does not write evidence file when evidence is false", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 1,
      summary: "done",
    });

    const report = await remediateFromScan("./audit.json", {
      cwd: "/tmp/project",
      evidence: false,
      requestId: "req-no-write",
    });

    expect(mocked.writeEvidenceLog).not.toHaveBeenCalled();
    expect(report.evidenceFile).toBeUndefined();
    expect(report.correlation?.requestId).toBe("req-no-write");
  });

  it("resumes from idempotency cache when resume is enabled", async () => {
    mocked.readIdempotentReport.mockReturnValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 0,
      summary: "cached",
    });

    const report = await remediate("CVE-2021-23337", {
      cwd: "/tmp/project",
      resume: true,
      idempotencyKey: "key-1",
    });

    expect(mocked.runRemediationPipeline).not.toHaveBeenCalled();
    expect(report.resumedFromCache).toBe(true);
    expect(report.summary).toContain("resumed from idempotency cache");
  });

  it("stores idempotent report when key is provided and run mutates", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 1,
      summary: "done",
    });

    await remediate("CVE-2021-23337", {
      cwd: "/tmp/project",
      idempotencyKey: "key-store",
      dryRun: false,
      preview: false,
    });

    expect(mocked.storeIdempotentReport).toHaveBeenCalledTimes(1);
    expect(mocked.storeIdempotentReport).toHaveBeenCalledWith(
      "/tmp/project",
      "key-store",
      "CVE-2021-23337",
      expect.objectContaining({ resumedFromCache: false })
    );
  });

  it("enforces directDependenciesOnly constraint by rejecting indirect package result", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [
        {
          installed: { name: "minimist", version: "1.2.0", type: "indirect" },
          affected: {
            name: "minimist",
            ecosystem: "npm",
            vulnerableRange: ">=1.0.0 <1.2.6",
            source: "osv",
          },
        },
      ],
      results: [
        {
          packageName: "minimist",
          strategy: "version-bump",
          fromVersion: "1.2.0",
          toVersion: "1.2.6",
          applied: true,
          dryRun: false,
          message: "applied",
        },
      ],
      agentSteps: 1,
      summary: "done",
    });

    const report = await remediate("CVE-2021-23337", {
      cwd: "/tmp/project",
      constraints: { directDependenciesOnly: true },
    });

    expect(report.results[0]?.applied).toBe(false);
    expect(report.results[0]?.strategy).toBe("none");
    expect(report.results[0]?.message).toContain("Constraint blocked remediation for indirect dependency");
  });

  it("enforces preferVersionBump by rejecting non-version-bump result", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [
        {
          packageName: "lodash",
          strategy: "patch-file",
          fromVersion: "4.17.0",
          applied: true,
          dryRun: false,
          message: "patched",
        },
      ],
      agentSteps: 1,
      summary: "done",
    });

    const report = await remediate("CVE-2021-23337", {
      cwd: "/tmp/project",
      constraints: { preferVersionBump: true },
    });

    expect(report.results[0]?.applied).toBe(false);
    expect(report.results[0]?.strategy).toBe("none");
    expect(report.results[0]?.message).toContain("Constraint prefers version-bump");
  });

  it("enforces preferVersionBump by rejecting override result", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [
        {
          packageName: "minimist",
          strategy: "override",
          fromVersion: "1.2.0",
          toVersion: "1.2.8",
          applied: true,
          dryRun: false,
          message: "overridden",
        },
      ],
      agentSteps: 1,
      summary: "done",
    });

    const report = await remediate("CVE-2021-23337", {
      cwd: "/tmp/project",
      constraints: { preferVersionBump: true },
    });

    expect(report.results[0]?.applied).toBe(false);
    expect(report.results[0]?.strategy).toBe("none");
    expect(report.results[0]?.message).toContain("Constraint prefers version-bump");
  });

  it("aggregates strategy counts and unresolved reasons into scan report and CI summary", async () => {
    mocked.uniqueCveIds.mockReturnValue(["CVE-2021-23337"]);
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [
        {
          installed: { name: "lodash", version: "4.17.0", type: "direct" },
          affected: {
            name: "lodash",
            ecosystem: "npm",
            vulnerableRange: ">=4.0.0 <4.17.21",
            source: "osv",
          },
        },
        {
          installed: { name: "minimist", version: "1.2.0", type: "indirect" },
          affected: {
            name: "minimist",
            ecosystem: "npm",
            vulnerableRange: ">=1.0.0 <1.2.8",
            source: "osv",
          },
        },
        {
          installed: { name: "debug", version: "2.6.8", type: "indirect" },
          affected: {
            name: "debug",
            ecosystem: "npm",
            vulnerableRange: ">=2.0.0 <2.6.9",
            source: "osv",
          },
        },
      ],
      results: [
        {
          packageName: "lodash",
          strategy: "version-bump",
          fromVersion: "4.17.0",
          toVersion: "4.17.21",
          applied: true,
          dryRun: false,
          message: "bumped",
        },
        {
          packageName: "minimist",
          strategy: "override",
          fromVersion: "1.2.0",
          toVersion: "1.2.8",
          applied: true,
          dryRun: false,
          message: "overridden",
        },
        {
          packageName: "debug",
          strategy: "none",
          fromVersion: "2.6.8",
          applied: false,
          dryRun: false,
          unresolvedReason: "no-safe-version",
          message: "unresolved",
        },
      ],
      agentSteps: 1,
      summary: "done",
    });

    const report = await remediateFromScan("./audit.json", {
      cwd: "/tmp/project",
    });
    const summary = toCiSummary(report);

    expect(report.strategyCounts).toEqual({
      "version-bump": 1,
      override: 1,
      none: 1,
    });
    expect(report.dependencyScopeCounts).toEqual({
      direct: 1,
      transitive: 2,
    });
    expect(report.unresolvedByReason).toEqual({
      "no-safe-version": 1,
    });
    expect(summary.strategyCounts).toEqual(report.strategyCounts);
    expect(summary.dependencyScopeCounts).toEqual(report.dependencyScopeCounts);
    expect(summary.unresolvedByReason).toEqual(report.unresolvedByReason);
    expect(mocked.writeEvidenceLog).toHaveBeenCalledWith(
      "/tmp/project",
      expect.objectContaining({
        summary: expect.objectContaining({
          strategyCounts: {
            "version-bump": 1,
            override: 1,
            none: 1,
          },
          dependencyScopeCounts: {
            direct: 1,
            transitive: 2,
          },
          unresolvedByReason: {
            "no-safe-version": 1,
          },
        }),
      })
    );
  });
});
