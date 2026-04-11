import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  remediate: vi.fn(),
  remediateFromScan: vi.fn(),
  inspectPatchArtifact: vi.fn(),
  listPatchArtifacts: vi.fn(),
  toCiSummary: vi.fn(),
  ciExitCode: vi.fn(),
  toSarifOutput: vi.fn(),
  validatePatchArtifact: vi.fn(),
  optionDescriptions: {
    cveId: "CVE ID, e.g. CVE-2021-23337",
    inputPath: "Absolute path to the scanner output file",
    cwd: "Absolute path to the project root (default: process.cwd())",
    packageManager: "Package manager override (auto-detected by default)",
    dryRun: "If true, plan changes but write nothing",
    preview: "If true, enforce non-mutating preview mode",
    runTests: "Run package-manager test command after applying fix",
    llmProvider: "LLM provider override",
    patchesDir: "Directory to write .patch files (default: ./patches)",
    policy: "Optional path to .autoremediator policy file",
    requestId: "Request correlation ID",
    sessionId: "Session correlation ID",
    parentRunId: "Parent run correlation ID",
    idempotencyKey: "Idempotency key for replay-safe execution",
    resume: "Return cached result for matching idempotency key when available",
    actor: "Actor identity for evidence provenance",
    source: "Source system for provenance",
    format: "Scanner format (default: auto)",
    evidence: "Write evidence JSON to .autoremediator/evidence/ (default: true)",
    directDependenciesOnly: "Restrict remediation to direct dependencies only",
    preferVersionBump: "Reject override and patch remediation when version-bump-only policy is required",
    installMode: "Install behavior profile: deterministic|prefer-offline|standard",
    installPreferOffline: "Override prefer-offline flag behavior for install commands",
    enforceFrozenLockfile: "Override frozen lockfile behavior for install commands",
  },
}));

vi.mock("../api/index.js", () => ({
  remediate: mocked.remediate,
  remediateFromScan: mocked.remediateFromScan,
  inspectPatchArtifact: mocked.inspectPatchArtifact,
  listPatchArtifacts: mocked.listPatchArtifacts,
  toCiSummary: mocked.toCiSummary,
  ciExitCode: mocked.ciExitCode,
  toSarifOutput: mocked.toSarifOutput,
  validatePatchArtifact: mocked.validatePatchArtifact,
  OPTION_DESCRIPTIONS: mocked.optionDescriptions,
}));

import { createProgram } from "./index.js";

describe("cli preview and correlation option forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mocked.remediate.mockResolvedValue({ summary: "ok", results: [] });
    mocked.remediateFromScan.mockResolvedValue({
      cveIds: [],
      reports: [],
      successCount: 0,
      failedCount: 0,
      errors: [],
      patchCount: 0,
    });
    mocked.listPatchArtifacts.mockResolvedValue([]);
    mocked.inspectPatchArtifact.mockResolvedValue({ patchFilePath: "./patches/lodash.patch", exists: true, diffValid: true });
    mocked.validatePatchArtifact.mockResolvedValue({ patchFilePath: "./patches/lodash.patch", exists: true, manifestFound: true, diffValid: true, driftDetected: false, validationPhases: [] });
    mocked.toCiSummary.mockReturnValue({ failedCount: 0 });
    mocked.ciExitCode.mockReturnValue(0);
    mocked.toSarifOutput.mockReturnValue({ version: "2.1.0", runs: [] });
  });

  it("forwards preview and correlation options in top-level CVE mode", async () => {
    const program = createProgram();
    await program.parseAsync(
      [
        "node",
        "autoremediator",
        "CVE-2021-23337",
        "--preview",
        "--request-id",
        "req-1",
        "--session-id",
        "session-1",
        "--parent-run-id",
        "parent-1",
      ]
    );

    expect(mocked.remediate).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({
        patchesDir: undefined,
        preview: true,
        requestId: "req-1",
        sessionId: "session-1",
        parentRunId: "parent-1",
      })
    );
  });

  it("forwards preview and correlation options in top-level scan mode", async () => {
    const program = createProgram();
    await program.parseAsync(
      [
        "node",
        "autoremediator",
        "--input",
        "./audit.json",
        "--preview",
        "--request-id",
        "req-2",
        "--session-id",
        "session-2",
        "--parent-run-id",
        "parent-2",
      ]
    );

    expect(mocked.remediateFromScan).toHaveBeenCalledWith(
      "./audit.json",
      expect.objectContaining({
        patchesDir: undefined,
        preview: true,
        requestId: "req-2",
        sessionId: "session-2",
        parentRunId: "parent-2",
      })
    );
  });

  it("forwards patchesDir in top-level CVE mode", async () => {
    const program = createProgram();
    await program.parseAsync(
      [
        "CVE-2021-23337",
        "--patches-dir",
        "./custom-patches",
      ],
      { from: "user" }
    );

    expect(mocked.remediate).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({
        patchesDir: "./custom-patches",
      })
    );
  });

  it("forwards patchesDir in top-level scan mode", async () => {
    const program = createProgram();
    await program.parseAsync(
      [
        "--input",
        "./audit.json",
        "--patches-dir",
        "./custom-patches",
      ],
      { from: "user" }
    );

    expect(mocked.remediateFromScan).toHaveBeenCalledWith(
      "./audit.json",
      expect.objectContaining({
        patchesDir: "./custom-patches",
      })
    );
  });

  it("forwards evidence option in explicit cve command", async () => {
    const program = createProgram();
    await program.parseAsync(
      [
        "node",
        "autoremediator",
        "cve",
        "CVE-2021-23337",
        "--no-evidence",
      ]
    );

    expect(mocked.remediate).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({
        evidence: false,
      })
    );
  });

  it("supports ci and sarif output in explicit cve command", async () => {
    mocked.remediate.mockResolvedValue({
      cveId: "CVE-2021-23337",
      cveDetails: null,
      vulnerablePackages: [],
      results: [
        {
          packageName: "lodash",
          strategy: "none",
          fromVersion: "4.17.0",
          applied: false,
          dryRun: false,
          message: "unresolved",
        },
      ],
      agentSteps: 1,
      summary: "done",
    });

    mocked.toCiSummary.mockImplementation((value) => value);
    mocked.ciExitCode.mockReturnValue(1);

    const program = createProgram();
    await program.parseAsync(
      [
        "node",
        "autoremediator",
        "cve",
        "CVE-2021-23337",
        "--output-format",
        "sarif",
        "--ci",
      ]
    );

    expect(mocked.ciExitCode).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("forwards consensus and patch-confidence options in top-level CVE mode", async () => {
    const program = createProgram();
    await program.parseAsync(
      [
        "node",
        "autoremediator",
        "CVE-2021-23337",
        "--require-consensus-for-high-risk",
        "--consensus-provider",
        "remote",
        "--consensus-model",
        "claude-mythos-verifier",
        "--patch-confidence-low",
        "0.61",
        "--patch-confidence-medium",
        "0.72",
        "--patch-confidence-high",
        "0.91",
      ]
    );

    expect(mocked.remediate).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({
        requireConsensusForHighRisk: true,
        consensusProvider: "remote",
        consensusModel: "claude-mythos-verifier",
        patchConfidenceThresholds: {
          low: 0.61,
          medium: 0.72,
          high: 0.91,
        },
      })
    );
  });

  it("forwards install constraint options in top-level CVE mode", async () => {
    const program = createProgram();
    await program.parseAsync(
      [
        "node",
        "autoremediator",
        "CVE-2021-23337",
        "--install-mode",
        "standard",
        "--install-prefer-offline",
        "false",
        "--enforce-frozen-lockfile",
        "true",
      ]
    );

    expect(mocked.remediate).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({
        constraints: expect.objectContaining({
          installMode: "standard",
          installPreferOffline: false,
          enforceFrozenLockfile: true,
        }),
      })
    );
  });

  it("lists patch artifacts through the patches list command", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "autoremediator",
      "patches",
      "list",
      "--patches-dir",
      "./custom-patches",
    ]);

    expect(mocked.listPatchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        patchesDir: "./custom-patches",
      })
    );
  });

  it("inspects patch artifacts through the patches inspect command", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "autoremediator",
      "patches",
      "inspect",
      "./patches/lodash+4.17.0.patch",
      "--json",
    ]);

    expect(mocked.inspectPatchArtifact).toHaveBeenCalledWith(
      "./patches/lodash+4.17.0.patch",
      expect.objectContaining({ cwd: expect.any(String) })
    );
  });

  it("validates patch artifacts through the patches validate command", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "autoremediator",
      "patches",
      "validate",
      "./patches/lodash+4.17.0.patch",
      "--package-manager",
      "pnpm",
    ]);

    expect(mocked.validatePatchArtifact).toHaveBeenCalledWith(
      "./patches/lodash+4.17.0.patch",
      expect.objectContaining({ packageManager: "pnpm" })
    );
  });
});
