import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  remediate: vi.fn(),
  remediateFromScan: vi.fn(),
  toCiSummary: vi.fn(),
  ciExitCode: vi.fn(),
}));

vi.mock("./api.js", () => ({
  remediate: mocked.remediate,
  remediateFromScan: mocked.remediateFromScan,
  toCiSummary: mocked.toCiSummary,
  ciExitCode: mocked.ciExitCode,
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
      patchFileCount: 0,
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
        preview: true,
        requestId: "req-2",
        sessionId: "session-2",
        parentRunId: "parent-2",
      })
    );
  });
});
