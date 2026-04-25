import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildResultSimulation } from "./reporting.js";

const mocked = vi.hoisted(() => ({
  runRemediationPipeline: vi.fn(),
  parseScanInput: vi.fn(),
  parseScanInputFromAudit: vi.fn(),
  uniqueCveIds: vi.fn(),
  loadPolicy: vi.fn(),
  isPackageAllowed: vi.fn(),
  createEvidenceLog: vi.fn(),
  addEvidenceStep: vi.fn(),
  finalizeEvidence: vi.fn(),
  writeEvidenceLog: vi.fn(),
  readIdempotentReport: vi.fn(),
  storeIdempotentReport: vi.fn(),
  findAlternativePackages: vi.fn(),
  assessPackageReachability: vi.fn(),
}));

vi.mock("../scanner/index.js", () => ({
  parseScanInput: mocked.parseScanInput,
  parseScanInputFromAudit: mocked.parseScanInputFromAudit,
  uniqueCveIds: mocked.uniqueCveIds,
}));

vi.mock("../platform/policy.js", () => ({
  loadPolicy: mocked.loadPolicy,
  isPackageAllowed: mocked.isPackageAllowed,
}));

vi.mock("../platform/evidence.js", () => ({
  createEvidenceLog: mocked.createEvidenceLog,
  addEvidenceStep: mocked.addEvidenceStep,
  finalizeEvidence: mocked.finalizeEvidence,
  writeEvidenceLog: mocked.writeEvidenceLog,
}));

vi.mock("../platform/idempotency.js", () => ({
  readIdempotentReport: mocked.readIdempotentReport,
  storeIdempotentReport: mocked.storeIdempotentReport,
}));

vi.mock("../intelligence/index.js", () => ({
  findAlternativePackages: mocked.findAlternativePackages,
}));

vi.mock("../remediation/pipeline.js", async () => {
  const actual = await vi.importActual<typeof import("../remediation/pipeline.js")>("../remediation/pipeline.js");
  return {
    ...actual,
    runRemediationPipeline: mocked.runRemediationPipeline,
    assessPackageReachability: mocked.assessPackageReachability,
  };
});

import { planRemediation, remediate, remediateFromScan, toCiSummary } from "./index.js";

describe("api preview and correlation behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocked.parseScanInput.mockReturnValue([{ cveId: "CVE-2021-23337" }]);
    mocked.parseScanInputFromAudit.mockResolvedValue([{ cveId: "CVE-2021-23337" }]);
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
    mocked.findAlternativePackages.mockResolvedValue([]);
    mocked.assessPackageReachability.mockReturnValue({
      packageName: "minimist",
      status: "reachable",
      reason: "Found import",
      evidence: [{ filePath: "src/index.ts", matchType: "import" }],
    });
  });

  it("planRemediation rejects explicit dryRun/preview options", async () => {
    await expect(
      planRemediation("CVE-2021-23337", {
        dryRun: false,
        requestId: "req-123",
      })
    ).rejects.toThrow(
      "planRemediation always runs with dryRun=true and preview=true. Remove dryRun/preview from options."
    );

    await expect(
      planRemediation("CVE-2021-23337", {
        preview: false,
        requestId: "req-123",
      })
    ).rejects.toThrow(
      "planRemediation always runs with dryRun=true and preview=true. Remove dryRun/preview from options."
    );

    expect(mocked.runRemediationPipeline).not.toHaveBeenCalled();
  });

  it("planRemediation forces preview and dryRun for valid options", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 1,
      summary: "preview",
    });

    await planRemediation("CVE-2021-23337", {
      simulationMode: true,
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
        simulationMode: true,
        requestId: "req-123",
        sessionId: "session-abc",
        parentRunId: "parent-1",
      })
    );
  });

  it("rejects simulationMode for mutating remediate runs", async () => {
    await expect(
      remediate("CVE-2021-23337", {
        cwd: "/tmp/project",
        simulationMode: true,
      })
    ).rejects.toThrow("simulationMode requires dryRun=true or preview=true.");

    expect(mocked.runRemediationPipeline).not.toHaveBeenCalled();
  });

  it("rejects simulationMode for mutating scan runs", async () => {
    await expect(
      remediateFromScan("./audit.json", {
        cwd: "/tmp/project",
        simulationMode: true,
      })
    ).rejects.toThrow("simulationMode requires dryRun=true or preview=true.");

    expect(mocked.runRemediationPipeline).not.toHaveBeenCalled();
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

  it("passes constraints to pipeline without post-hoc result rewrites", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [
        {
          installed: { name: "minimist", version: "1.2.0", type: "transitive" },
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

    expect(mocked.runRemediationPipeline).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({
        constraints: expect.objectContaining({ directDependenciesOnly: true }),
      })
    );
    expect(report.results[0]?.applied).toBe(true);
    expect(report.results[0]?.strategy).toBe("version-bump");
  });

  it("builds deterministic planned mutations and rebuttal findings", () => {
    const report = {
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [
        {
          installed: { name: "minimist", version: "1.2.0", type: "transitive" as const },
          affected: {
            name: "minimist",
            ecosystem: "npm" as const,
            vulnerableRange: ">=1.0.0 <1.2.8",
            source: "osv" as const,
          },
        },
      ],
      results: [
        {
          packageName: "minimist",
          strategy: "patch-file" as const,
          fromVersion: "1.2.0",
          patchFilePath: "./patches/minimist.patch",
          patchArtifact: {
            schemaVersion: "1.0" as const,
            packageName: "minimist",
            vulnerableVersion: "1.2.0",
            patchFilePath: "./patches/minimist.patch",
            manifestFilePath: "./patches/minimist.patch.json",
            patchFileName: "minimist.patch",
            generatedAt: new Date().toISOString(),
            applied: false,
            dryRun: true,
            validationPhases: [{ phase: "apply" as const, passed: false }],
          },
          applied: false,
          dryRun: true,
          message: "planned patch",
          unresolvedReason: "patch-confidence-too-low" as const,
          dispositionReason: "low-confidence",
          riskLevel: "high" as const,
          escalationAction: "open-issue" as const,
          regressionDetected: true,
          validation: { passed: false },
          validationPhases: [{ phase: "test" as const, passed: false }],
        },
      ],
      agentSteps: 1,
      summary: "planned",
      exploitSignalTriggered: true,
      slaBreaches: [
        {
          cveId: "CVE-2021-23337",
          severity: "HIGH" as const,
          publishedAt: "2026-01-01T00:00:00.000Z",
          deadlineAt: "2026-01-02T00:00:00.000Z",
          hoursOverdue: 24,
        },
      ],
    };

    const simulation = buildResultSimulation(report, report.results[0], {
      dryRun: true,
      simulationMode: true,
      runTests: false,
    });

    expect(simulation).toEqual({
      mode: "dry-run",
      wouldMutate: true,
      plannedMutations: [
        {
          target: "patch-file",
          reason: "Would write a generated patch artifact.",
          path: "./patches/minimist.patch",
        },
        {
          target: "patch-manifest",
          reason: "Would write patch artifact manifest metadata.",
          path: "./patches/minimist.patch.json",
        },
        {
          target: "install-state",
          reason: "Would refresh installed dependency state.",
        },
      ],
      rebuttalFindings: expect.arrayContaining([
        expect.objectContaining({ code: "unresolved-reason", severity: "warning", sourceSignals: ["unresolvedReason"] }),
        expect.objectContaining({ code: "validation-risk", severity: "high" }),
        expect.objectContaining({ code: "regression-risk", severity: "high", sourceSignals: ["regressionDetected"] }),
        expect.objectContaining({ code: "low-confidence", severity: "warning" }),
        expect.objectContaining({ code: "high-risk-patch", severity: "warning", sourceSignals: ["riskLevel"] }),
        expect.objectContaining({ code: "transitive-target", severity: "info", sourceSignals: ["dependencyScope"] }),
        expect.objectContaining({ code: "escalation-planned", severity: "warning", sourceSignals: ["escalationAction"] }),
        expect.objectContaining({ code: "exploit-signal", severity: "high", sourceSignals: ["exploitSignalTriggered"] }),
        expect.objectContaining({ code: "sla-breach", severity: "warning", sourceSignals: ["slaBreaches"] }),
        expect.objectContaining({ code: "tests-not-run", severity: "warning", sourceSignals: ["runTests"] }),
      ]),
    });
  });

  it("writes direct-remediation evidence by default and supports disabling it", async () => {
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

    const withEvidence = await remediate("CVE-2021-23337", {
      cwd: "/tmp/project",
    });
    expect(withEvidence.evidenceFile).toBe("/tmp/project/.autoremediator/evidence/run-1.json");
    expect(mocked.writeEvidenceLog).toHaveBeenCalled();

    vi.clearAllMocks();
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 1,
      summary: "done",
    });

    const withoutEvidence = await remediate("CVE-2021-23337", {
      cwd: "/tmp/project",
      evidence: false,
    });

    expect(withoutEvidence.evidenceFile).toBeUndefined();
    expect(mocked.writeEvidenceLog).not.toHaveBeenCalled();
  });

  it("emits containment evidence step for blocked escalation results", async () => {
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [
        {
          packageName: "lodash",
          strategy: "version-bump",
          fromVersion: "4.17.0",
          toVersion: "4.17.21",
          applied: false,
          dryRun: false,
          unresolvedReason: "policy-blocked",
          disposition: "escalate",
          dispositionReason: "kev-exploit-signal",
          message: "blocked by containment",
        },
      ],
      agentSteps: 1,
      summary: "done",
    });

    await remediate("CVE-2021-23337", {
      cwd: "/tmp/project",
      containmentMode: true,
    });

    expect(mocked.addEvidenceStep).toHaveBeenCalledWith(
      expect.anything(),
      "containment-summary",
      { cveId: "CVE-2021-23337" },
      expect.objectContaining({
        containmentCount: 1,
        blockedUnresolvedReason: "policy-blocked",
        blockedDisposition: "escalate",
      })
    );
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
          installed: { name: "minimist", version: "1.2.0", type: "transitive" },
          affected: {
            name: "minimist",
            ecosystem: "npm",
            vulnerableRange: ">=1.0.0 <1.2.8",
            source: "osv",
          },
        },
        {
          installed: { name: "debug", version: "2.6.8", type: "transitive" },
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
          escalationAction: "open-issue",
          message: "unresolved",
        },
      ],
      agentSteps: 1,
      summary: "done",
    });

    const report = await remediateFromScan("./audit.json", {
      cwd: "/tmp/project",
      dryRun: true,
      simulationMode: true,
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
    expect(report.escalationCounts).toEqual({
      "open-issue": 1,
    });
    expect(report.reports[0]?.results[0]?.simulation?.plannedMutations).toEqual([
      {
        target: "package-manifest",
        reason: "Would update the package manifest dependency declaration.",
      },
      {
        target: "lockfile",
        reason: "Would update the dependency lockfile to reflect resolved versions.",
      },
      {
        target: "install-state",
        reason: "Would refresh installed dependency state.",
      },
    ]);
    expect(report.simulationSummary).toEqual({
      mode: "dry-run",
      resultCount: 3,
      wouldMutateCount: 2,
      nonMutatingCount: 1,
      rebuttalResultCount: 3,
      plannedMutationCounts: {
        "package-manifest": 2,
        lockfile: 2,
        "install-state": 2,
      },
      rebuttalCounts: {
        "escalation-planned": 1,
        "transitive-target": 2,
        "tests-not-run": 2,
        "unresolved-reason": 1,
      },
    });
    expect(summary.strategyCounts).toEqual(report.strategyCounts);
    expect(summary.dependencyScopeCounts).toEqual(report.dependencyScopeCounts);
    expect(summary.unresolvedByReason).toEqual(report.unresolvedByReason);
    expect(summary.escalationCounts).toEqual(report.escalationCounts);
    expect(summary.simulationSummary).toEqual(report.simulationSummary);
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
          escalationCounts: {
            "open-issue": 1,
          },
          simulationSummary: expect.objectContaining({
            mode: "dry-run",
            resultCount: 3,
          }),
        }),
      })
    );
  });

  it("aggregates containmentCount into scan evidence summary for blocked escalations", async () => {
    mocked.uniqueCveIds.mockReturnValue(["CVE-2021-23337", "CVE-2021-44906"]);
    mocked.runRemediationPipeline
      .mockResolvedValueOnce({
        cveId: "CVE-2021-23337",
        cveDetails: null,
        vulnerablePackages: [],
        results: [
          {
            packageName: "lodash",
            strategy: "version-bump",
            fromVersion: "4.17.0",
            toVersion: "4.17.21",
            applied: false,
            dryRun: false,
            unresolvedReason: "policy-blocked",
            disposition: "escalate",
            dispositionReason: "kev-exploit-signal",
            message: "blocked by containment",
          },
        ],
        agentSteps: 1,
        summary: "blocked",
      })
      .mockResolvedValueOnce({
        cveId: "CVE-2021-44906",
        cveDetails: null,
        vulnerablePackages: [],
        results: [
          {
            packageName: "debug",
            strategy: "none",
            fromVersion: "2.6.8",
            applied: false,
            dryRun: false,
            unresolvedReason: "no-safe-version",
            disposition: "simulate-only",
            dispositionReason: "no-safe-version",
            message: "unresolved",
          },
        ],
        agentSteps: 1,
        summary: "unresolved",
      });

    await remediateFromScan("./audit.json", {
      cwd: "/tmp/project",
      containmentMode: true,
    });

    expect(mocked.writeEvidenceLog).toHaveBeenCalledWith(
      "/tmp/project",
      expect.objectContaining({
        summary: expect.objectContaining({
          containmentCount: 1,
        }),
      })
    );
  });

  it("uses native audit parsing path when audit option is enabled", async () => {
    mocked.parseScanInputFromAudit.mockResolvedValue([{ cveId: "CVE-2021-23337" }]);
    mocked.uniqueCveIds.mockReturnValue(["CVE-2021-23337"]);
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 1,
      summary: "done",
    });

    await remediateFromScan("", {
      cwd: "/tmp/project",
      audit: true,
      packageManager: "npm",
      format: "auto",
    });

    expect(mocked.parseScanInputFromAudit).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      packageManager: "npm",
      format: "auto",
    });
    expect(mocked.parseScanInput).not.toHaveBeenCalled();
  });

  it("forwards workspace constraint to native audit parsing", async () => {
    mocked.parseScanInputFromAudit.mockResolvedValue([{ cveId: "CVE-2021-23337" }]);
    mocked.uniqueCveIds.mockReturnValue(["CVE-2021-23337"]);
    mocked.runRemediationPipeline.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [],
      agentSteps: 1,
      summary: "done",
    });

    await remediateFromScan("", {
      cwd: "/tmp/project",
      audit: true,
      packageManager: "npm",
      format: "auto",
      constraints: {
        workspace: "web-app",
      },
    });

    expect(mocked.parseScanInputFromAudit).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      packageManager: "npm",
      format: "auto",
      workspace: "web-app",
    });
  });
});
