import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runProofOfFixPhase,
  isHarnessFailure,
  isAssertionFailure,
  sanitizePathLeakage,
  stripStackTraceFrames,
  prepareReproductionTestFile,
  assembleProofOfFixVerification,
} from "./runner.js";

describe("Proof-of-Fix Runner Adversarial White-Box Challenges", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "runner-challenge-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("Real Node process execution & quality guardrails", () => {
    it("distinguishes genuine exploit assertion failure (exit 1) in negative stage", async () => {
      const script = `
const assert = require("node:assert");
assert.strictEqual(1, 2, "EXPLOIT_REPRODUCED: state was not expected");
`;
      const testFile = join(testDir, "repro.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.harnessFailure).toBeFalsy();
      expect(result.exitCode).toBe(1);
    });

    it("accepts explicit EXPLOIT_REPRODUCED token with exit code 1", async () => {
      const script = `
console.error("EXPLOIT_REPRODUCED: arbitrary code execution verified");
process.exit(1);
`;
      const testFile = join(testDir, "token-repro.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(1);
    });

    it("rejects false negative when test passes cleanly (exit 0) in negative stage", async () => {
      const script = `
// Did not reproduce exploit
process.exit(0);
`;
      const testFile = join(testDir, "clean.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.error).toContain("failed to reproduce vulnerability");
    });

    it("rejects SyntaxError in reproduction test as harness failure", async () => {
      const script = `
const invalid = { unclosed syntax;
`;
      const testFile = join(testDir, "syntax-error.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.harnessFailure).toBe(true);
      expect(result.error).toContain("harness error");
    });

    it("rejects missing module / import resolution error as harness failure", async () => {
      const script = `
const missing = require("non-existent-module-autoremediator-404");
`;
      const testFile = join(testDir, "missing-module.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.harnessFailure).toBe(true);
      expect(result.error).toContain("harness error");
    });

    it("rejects unhandled runtime crash (ReferenceError / TypeError) as harness failure", async () => {
      const script = `
const uninitialized = undefined;
uninitialized.someMethod();
`;
      const testFile = join(testDir, "type-crash.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.harnessFailure).toBe(true);
      expect(result.error).toContain("harness error");
      expect(result.error).toContain("TypeError");
    });

    it("vetoes misleading stdout assertion token when stderr contains an unhandled crash", async () => {
      const script = `
console.log("EXPLOIT_REPRODUCED: fake message in stdout");
// but actual runtime crash in stderr:
const obj = null;
obj.crash();
`;
      const testFile = join(testDir, "fake-repro.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.harnessFailure).toBe(true);
      expect(result.error).toContain("harness error");
      expect(result.error).toContain("TypeError");
    });

    it("aborts hanging test scripts when timeout is reached", async () => {
      const script = `
while (true) {}
`;
      const testFile = join(testDir, "hang.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: testFile,
        cwd: testDir,
        timeoutMs: 800,
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.harnessFailure).toBe(true);
      expect(result.error).toContain("timed out");
    });

    it("handles native TypeScript reproduction scripts with type annotations", async () => {
      const script = `
import assert from "node:assert";
const val: number = 1;
assert.strictEqual(val, 2, "EXPLOIT_REPRODUCED: TS exploit verification");
`;
      const testFile = join(testDir, "repro.ts");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(1);
    });

    it("verifies positive stage passes on clean execution (exit 0)", async () => {
      const script = `
const assert = require("node:assert");
assert.strictEqual(2, 2);
`;
      const testFile = join(testDir, "fixed.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "positive",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("verifies positive stage fails when assertion fails on patched code", async () => {
      const script = `
const assert = require("node:assert");
assert.strictEqual(2, 3, "Still broken post-patch");
`;
      const testFile = join(testDir, "still-broken.cjs");
      await writeFile(testFile, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "positive",
        testFilePath: testFile,
        cwd: testDir,
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.error).toContain("Reproduction test failed on patched target");
    });
  });

  describe("path sanitization & stack frame decoupling", () => {
    it("strips directory paths from diagnostic text to prevent collision with assertion tokens", () => {
      const pathWithToken = "/tmp/repo/AssertionError/project";
      const diagnostic = `Error at ${pathWithToken}/index.js:42\nSome message`;

      const sanitized = sanitizePathLeakage(diagnostic, [pathWithToken]);
      expect(sanitized).not.toContain("AssertionError");
      expect(sanitized).toContain("<path>");
    });

    it("strips stack trace frames so file paths inside 'at ...' never trigger false tokens", () => {
      const stack = `
TypeError: Cannot read properties of undefined
    at file:///Users/test/AssertionError/app.js:12:4
    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)
`;
      const stripped = stripStackTraceFrames(stack);
      expect(stripped).not.toContain("AssertionError");
      expect(stripped).toContain("TypeError: Cannot read properties of undefined");
    });
  });

  describe("prepareReproductionTestFile & assembleProofOfFixVerification", () => {
    it("writes reproduction test script content to default path when string script is provided", async () => {
      const script = "console.log('test');";
      const prep = await prepareReproductionTestFile({
        cwd: testDir,
        packageName: "my-pkg",
        vulnerableVersion: "1.0.0",
        patchesDir: "./patches",
        reproductionTest: script,
      });

      expect(prep.isCreated).toBe(true);
      expect(prep.testFilePath).toBe(join(testDir, "patches", "my-pkg+1.0.0.test.cjs"));
    });

    it("uses existing reproduction test path without rewriting if file already exists", async () => {
      const existing = join(testDir, "custom.test.js");
      await writeFile(existing, "console.log('custom');", "utf8");

      const prep = await prepareReproductionTestFile({
        cwd: testDir,
        packageName: "my-pkg",
        vulnerableVersion: "1.0.0",
        proofOfFix: existing,
      });

      expect(prep.isCreated).toBe(false);
      expect(prep.testFilePath).toBe(existing);
    });

    it("assembles unified proof-of-fix verification record", () => {
      const verified = assembleProofOfFixVerification({
        reproductionTestPath: "test.js",
        negativePhase: { executed: true, passed: true, exitCode: 1, durationMs: 100 },
        positivePhase: { executed: true, passed: true, exitCode: 0, durationMs: 120 },
      });

      expect(verified.status).toBe("verified");
      expect(verified.failureReason).toBeUndefined();
      expect(verified.durationMs).toBe(220);

      const failedNegative = assembleProofOfFixVerification({
        reproductionTestPath: "test.js",
        negativePhase: { executed: true, passed: false, exitCode: 0, error: "false negative" },
        positivePhase: { executed: true, passed: true },
      });
      expect(failedNegative.status).toBe("failed");
      expect(failedNegative.failureReason).toBe("false negative");

      const failedPositive = assembleProofOfFixVerification({
        reproductionTestPath: "test.js",
        negativePhase: { executed: true, passed: true },
        positivePhase: { executed: true, passed: false, error: "post-patch failure" },
      });
      expect(failedPositive.status).toBe("failed");
      expect(failedPositive.failureReason).toBe("post-patch failure");
    });
  });
});
