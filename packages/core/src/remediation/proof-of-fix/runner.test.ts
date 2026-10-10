import { describe, expect, it, vi } from "vitest";
import { assembleProofOfFixVerification, runProofOfFixPhase } from "./runner.js";
import * as safeExecModule from "../../platform/safe-exec.js";

describe("proof-of-fix runner", () => {
  it("negative phase succeeds when exploit test fails on unpatched code (reproducing vulnerability)", async () => {
    vi.spyOn(safeExecModule, "safeExeca").mockRejectedValueOnce({
      exitCode: 1,
      message: "AssertionError: exploit succeeded",
      stderr: "Vulnerability reproduced",
    });

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: "/test/repro.js",
      cwd: "/repo",
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("AssertionError: exploit succeeded");
  });

  it("negative phase fails when exploit test unexpectedly passes on unpatched code (false negative)", async () => {
    vi.spyOn(safeExecModule, "safeExeca").mockResolvedValueOnce({
      exitCode: 0,
      stdout: "All assertions passed",
      stderr: "",
    } as any);

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: "/test/repro.js",
      cwd: "/repo",
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("failed to reproduce vulnerability");
  });

  it("positive phase succeeds when exploit test passes after remediation", async () => {
    vi.spyOn(safeExecModule, "safeExeca").mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Exploit mitigated",
      stderr: "",
    } as any);

    const result = await runProofOfFixPhase({
      stage: "positive",
      testFilePath: "/test/repro.js",
      cwd: "/repo",
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("positive phase fails when exploit test still fails after remediation", async () => {
    vi.spyOn(safeExecModule, "safeExeca").mockRejectedValueOnce({
      exitCode: 1,
      message: "Exploit still works",
      stderr: "Failed",
    });

    const result = await runProofOfFixPhase({
      stage: "positive",
      testFilePath: "/test/repro.js",
      cwd: "/repo",
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("Reproduction test failed on patched target");
  });

  it("assembles verified status when negative and positive phases pass", () => {
    const verification = assembleProofOfFixVerification({
      reproductionTestPath: "/repo/patches/poc.test.cjs",
      negativePhase: { executed: true, passed: true, exitCode: 1 },
      positivePhase: { executed: true, passed: true, exitCode: 0 },
      regressionPhase: { executed: true, passed: true },
    });

    expect(verification.status).toBe("verified");
    expect(verification.reproductionTestPath).toBe("/repo/patches/poc.test.cjs");
    expect(verification.failureReason).toBeUndefined();
  });

  it("assembles failed status when negative phase fails", () => {
    const verification = assembleProofOfFixVerification({
      reproductionTestPath: "/repo/patches/poc.test.cjs",
      negativePhase: {
        executed: true,
        passed: false,
        error: "Did not reproduce",
      },
      positivePhase: { executed: true, passed: true, exitCode: 0 },
    });

    expect(verification.status).toBe("failed");
    expect(verification.failureReason).toBe("Did not reproduce");
  });
});
