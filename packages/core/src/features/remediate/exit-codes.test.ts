import { describe, expect, it } from "vitest";

import type { CiSummary } from "./contracts.js";
import { ciExitCode, EXIT_CODES } from "./reporting.js";

function summary(overrides: Partial<CiSummary>): CiSummary {
  return {
    schemaVersion: "1.0",
    status: "ok",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cveCount: 1,
    remediationCount: 1,
    successCount: 0,
    failedCount: 0,
    errors: [],
    ...overrides,
  };
}

describe("ciExitCode", () => {
  it("is 0 when nothing failed", () => {
    expect(ciExitCode(summary({ successCount: 2 }))).toBe(EXIT_CODES.ok);
    expect(ciExitCode(summary({}))).toBe(EXIT_CODES.ok);
  });

  it("is 1 when everything failed and 2 when only some did", () => {
    expect(ciExitCode(summary({ failedCount: 2 }))).toBe(EXIT_CODES.failed);
    expect(ciExitCode(summary({ failedCount: 1, successCount: 1 }))).toBe(EXIT_CODES.partial);
  });

  it("is 3 when the only failures wait for approval", () => {
    expect(
      ciExitCode(
        summary({ failedCount: 2, successCount: 1, unresolvedByReason: { "policy-blocked": 2 } }),
      ),
    ).toBe(EXIT_CODES.needsApproval);
  });

  it("is 4 when the only failures are forbidden by policy", () => {
    expect(
      ciExitCode(
        summary({
          failedCount: 2,
          unresolvedByReason: { "constraint-blocked": 1, "major-bump-required": 1 },
        }),
      ),
    ).toBe(EXIT_CODES.policyBlocked);
  });

  it("prefers approval over policy when both are present and nothing else failed", () => {
    expect(
      ciExitCode(
        summary({
          failedCount: 2,
          unresolvedByReason: { "policy-blocked": 1, "constraint-blocked": 1 },
        }),
      ),
    ).toBe(EXIT_CODES.needsApproval);
  });

  it("lets a real failure outrank approval and policy", () => {
    expect(
      ciExitCode(
        summary({
          failedCount: 2,
          unresolvedByReason: { "policy-blocked": 1, "install-failed": 1 },
        }),
      ),
    ).toBe(EXIT_CODES.failed);
    expect(
      ciExitCode(
        summary({
          failedCount: 2,
          successCount: 3,
          unresolvedByReason: { "policy-blocked": 1, "install-failed": 1 },
        }),
      ),
    ).toBe(EXIT_CODES.partial);
  });

  it("treats errors with no recorded reason as failures", () => {
    expect(
      ciExitCode(summary({ failedCount: 1, errors: [{ cveId: "CVE-1", message: "x" }] })),
    ).toBe(EXIT_CODES.failed);
  });
});
