import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  remediate: vi.fn(),
  remediateFromScan: vi.fn(),
  toCiSummary: vi.fn(),
  ciExitCode: vi.fn(),
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
  },
}));

vi.mock("./api.js", () => ({
  remediate: mocked.remediate,
  remediateFromScan: mocked.remediateFromScan,
  toCiSummary: mocked.toCiSummary,
  ciExitCode: mocked.ciExitCode,
  OPTION_DESCRIPTIONS: mocked.optionDescriptions,
}));

import { createProgram } from "./cli.js";

describe("cli preview and correlation option forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.remediate.mockResolvedValue({ summary: "ok", results: [] });
    mocked.remediateFromScan.mockResolvedValue({
      cveIds: [],
      reports: [],
      successCount: 0,
      failedCount: 0,
      errors: [],
      patchCount: 0,
    });
    mocked.toCiSummary.mockReturnValue({ failedCount: 0 });
    mocked.ciExitCode.mockReturnValue(0);
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
});
