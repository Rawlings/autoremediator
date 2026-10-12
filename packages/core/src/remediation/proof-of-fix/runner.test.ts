import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleProofOfFixVerification,
  isAssertionFailure,
  isHarnessFailure,
  prepareReproductionTestFile,
  runProofOfFixPhase,
} from "./runner.js";

describe("proof-of-fix runner (real on-disk execution)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pof-runner-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("negative phase succeeds when exploit test fails assertion on unpatched code (reproducing vulnerability)", async () => {
    const testFile = join(tempDir, "repro.cjs");
    writeFileSync(
      testFile,
      `const assert = require("node:assert");
function vulnerableSanitize(input) { return input; }
// Assert sanitized output; vulnerable implementation fails with AssertionError
assert.strictEqual(vulnerableSanitize("<script>"), "&lt;script&gt;");
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("AssertionError");
  });

  it("negative phase fails when exploit test unexpectedly passes on unpatched code (false negative)", async () => {
    const testFile = join(tempDir, "repro-pass.cjs");
    writeFileSync(
      testFile,
      `const assert = require("node:assert");
function alreadyClean(input) { return "&lt;script&gt;"; }
assert.strictEqual(alreadyClean("<script>"), "&lt;script&gt;");
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain("failed to reproduce vulnerability");
  });

  it("negative phase rejects harness syntax errors as harness failures rather than exploit reproduction", async () => {
    const testFile = join(tempDir, "syntax-error.cjs");
    writeFileSync(testFile, `const invalid = ;\n`, "utf8");

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.output).toContain("SyntaxError");
  });

  it("negative phase rejects missing test file as harness error", async () => {
    const missingFile = join(tempDir, "does-not-exist.js");

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: missingFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.error).toContain("harness error");
  });

  it("positive phase succeeds when exploit test passes after remediation", async () => {
    const testFile = join(tempDir, "repro-fixed.cjs");
    writeFileSync(
      testFile,
      `const assert = require("node:assert");
function patchedSanitize(input) { return "&lt;script&gt;"; }
assert.strictEqual(patchedSanitize("<script>"), "&lt;script&gt;");
console.log("Remediation verified");
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "positive",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Remediation verified");
  });

  it("positive phase fails when exploit test still fails after remediation", async () => {
    const testFile = join(tempDir, "repro-still-broken.cjs");
    writeFileSync(
      testFile,
      `const assert = require("node:assert");
function broken(input) { return input; }
assert.strictEqual(broken("<script>"), "&lt;script&gt;");
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "positive",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Reproduction test failed on patched target");
  });

  it("terminates hanging test scripts when timeout is exceeded", async () => {
    const hangFile = join(tempDir, "hang.cjs");
    writeFileSync(hangFile, `setInterval(() => {}, 60000);\n`, "utf8");

    const negResult = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: hangFile,
      cwd: tempDir,
      timeoutMs: 300,
    });
    expect(negResult.executed).toBe(true);
    expect(negResult.passed).toBe(false);
    expect(negResult.error).toContain("timed out");

    const posResult = await runProofOfFixPhase({
      stage: "positive",
      testFilePath: hangFile,
      cwd: tempDir,
      timeoutMs: 300,
    });
    expect(posResult.executed).toBe(true);
    expect(posResult.passed).toBe(false);
    expect(posResult.error).toContain("failed on patched target");
  });

  it("executes TypeScript reproduction test files using Node experimental strip types", async () => {
    const tsFile = join(tempDir, "repro.ts");
    writeFileSync(
      tsFile,
      `import assert from "node:assert";
interface SanitizeResult { sanitized: string; }
function sanitize(input: string): SanitizeResult {
  return { sanitized: "&lt;script&gt;" };
}
const res: SanitizeResult = sanitize("<script>");
assert.strictEqual(res.sanitized, "&lt;script&gt;");
console.log("TypeScript repro passed");
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "positive",
      testFilePath: tsFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("TypeScript repro passed");
  });

  it("assembles verified status when negative and positive phases pass", () => {
    const verification = assembleProofOfFixVerification({
      reproductionTestPath: "/repo/patches/poc.test.cjs",
      negativePhase: { executed: true, passed: true, exitCode: 1, durationMs: 20 },
      positivePhase: { executed: true, passed: true, exitCode: 0, durationMs: 15 },
      regressionPhase: { executed: true, passed: true, durationMs: 10 },
    });

    expect(verification.status).toBe("verified");
    expect(verification.reproductionTestPath).toBe("/repo/patches/poc.test.cjs");
    expect(verification.failureReason).toBeUndefined();
    expect(verification.durationMs).toBe(45);
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

  it("assembles failed status when positive phase fails", () => {
    const verification = assembleProofOfFixVerification({
      reproductionTestPath: "/repo/patches/poc.test.cjs",
      negativePhase: { executed: true, passed: true, exitCode: 1 },
      positivePhase: {
        executed: true,
        passed: false,
        error: "Still vulnerable",
      },
    });

    expect(verification.status).toBe("failed");
    expect(verification.failureReason).toBe("Still vulnerable");
  });

  it("negative phase rejects unhandled TypeError as harness failure rather than exploit reproduction", async () => {
    const testFile = join(tempDir, "type-error.cjs");
    writeFileSync(
      testFile,
      `// Unhandled TypeError in reproduction test script
const obj = null;
obj.somePropertyAccess();
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.output).toContain("TypeError");
  });

  it("negative phase rejects unhandled RangeError as harness failure rather than exploit reproduction", async () => {
    const testFile = join(tempDir, "range-error.cjs");
    writeFileSync(
      testFile,
      `// Unhandled RangeError in reproduction test script
const invalid = new Array(-1);
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.output).toContain("RangeError");
  });

  it("negative phase rejects unhandled crashes inside workspace directory paths named with assertion words", async () => {
    const trickyDir = join(tempDir, "my assertion error repo");
    mkdirSync(trickyDir, { recursive: true });
    const testFile = join(trickyDir, "repro.cjs");
    writeFileSync(
      testFile,
      `// Unhandled crash inside path with assertion words
const obj = null;
obj.executeAction();
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: trickyDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.output).toContain("TypeError");
  });

  it("negative phase rejects unhandled crashes when test file name contains assertion keywords", async () => {
    const trickyDir = join(tempDir, "workspace-project");
    mkdirSync(trickyDir, { recursive: true });
    const testFile = join(trickyDir, "assertion-failed-repro.cjs");
    writeFileSync(
      testFile,
      `// Unhandled crash inside file named with assertion keywords
const invalid = new Array(-1);
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: trickyDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.output).toContain("RangeError");
  });

  it("negative phase rejects stdout debug prints followed by unhandled runtime crash", async () => {
    const testFile = join(tempDir, "debug-stdout-crash.cjs");
    writeFileSync(
      testFile,
      `// Deceptive stdout logging before unhandled crash
console.log("Debug: testing if assertion failed flag is set");
console.log("Starting test for AssertionError reproduction");
console.log("exploit reproduced in test harness");
const obj = null;
obj.crash();
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.output).toContain("TypeError");
  });

  it("negative phase rejects unhandled application Error whose message contains assertion words", async () => {
    const testFile = join(tempDir, "error-message-deception.cjs");
    writeFileSync(
      testFile,
      `// Unhandled generic Error with message containing assertion words
throw new Error("Handled assertion error in input validator");
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.output).toContain("Handled assertion error in input validator");
  });

  it("negative phase accepts genuine assertion failures even in directories with assertion keywords in path", async () => {
    const trickyDir = join(tempDir, "my assertion error repo");
    mkdirSync(trickyDir, { recursive: true });
    const testFile = join(trickyDir, "genuine-assert.cjs");
    writeFileSync(
      testFile,
      `const assert = require("node:assert");
function vulnerableSanitize(input) { return input; }
assert.strictEqual(vulnerableSanitize("<script>"), "&lt;script&gt;");
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: trickyDir,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("AssertionError");
  });

  it("negative phase accepts genuine assertion failure using node:assert/strict", async () => {
    const testFile = join(tempDir, "strict-assert.cjs");
    writeFileSync(
      testFile,
      `const assert = require("node:assert/strict");
assert.deepEqual({ sanitized: false }, { sanitized: true });
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("AssertionError");
  });

  it("negative phase accepts genuine assertion failure with EXPLOIT_REPRODUCED token", async () => {
    const testFile = join(tempDir, "exploit-reproduced.cjs");
    writeFileSync(
      testFile,
      `const assert = require("node:assert");
assert.fail("EXPLOIT_REPRODUCED: prototype pollution verified");
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("EXPLOIT_REPRODUCED");
  });

  it("negative phase rejects unhandled custom Error subclass preceded by deceptive stdout logging", async () => {
    const testFile = join(tempDir, "custom-error.cjs");
    writeFileSync(
      testFile,
      `console.log("Assertion failed: mock check failed");\nclass CustomDbError extends Error {}\nthrow new CustomDbError("connection refused");\n`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("CustomDbError");
  });

  it("negative phase rejects non-assertion diagnostic 'Assertion failed to reproduce' on exit 1", async () => {
    const testFile = join(tempDir, "repro-aborted.cjs");
    writeFileSync(
      testFile,
      `console.log("Assertion failed to reproduce, test aborted");\nprocess.exit(1);\n`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Assertion failed to reproduce");
  });

  it("negative phase rejects primitive string throw preceded by stdout assertion print", async () => {
    const testFile = join(tempDir, "string-throw.cjs");
    writeFileSync(
      testFile,
      `console.log("Assertion failed: mock check");\nthrow "raw string error";\n`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("raw string error");
  });

  it("negative phase rejects deceptive stdout sentence mentioning EXPLOIT_REPRODUCED on exit 1", async () => {
    const testFile = join(tempDir, "token-sentence.cjs");
    writeFileSync(
      testFile,
      `console.log("Target did not output EXPLOIT_REPRODUCED token; aborting test");\nprocess.exit(1);\n`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.harnessFailure).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Target did not output EXPLOIT_REPRODUCED token");
  });

  describe("classification and helper utilities", () => {
    it("correctly classifies harness failures vs non-harness failures", () => {
      expect(isHarnessFailure({ output: "SyntaxError: Unexpected token", exitCode: 1 })).toBe(true);
      expect(
        isHarnessFailure({
          output: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module",
          exitCode: 1,
        }),
      ).toBe(true);
      expect(isHarnessFailure({ output: "ENOENT: no such file or directory", exitCode: 1 })).toBe(
        true,
      );
      expect(isHarnessFailure({ output: "node: bad option: --invalid", exitCode: 1 })).toBe(true);
      expect(isHarnessFailure({ output: "", exitCode: 127 })).toBe(true);
      expect(isHarnessFailure({ output: "", signal: "SIGSEGV" })).toBe(true);
      expect(isHarnessFailure({ output: "ReferenceError: foo is not defined", exitCode: 1 })).toBe(
        true,
      );
      expect(
        isHarnessFailure({
          output: "TypeError: Cannot read properties of null (reading 'foo')",
          exitCode: 1,
        }),
      ).toBe(true);
      expect(
        isHarnessFailure({
          output: "RangeError: Maximum call stack size exceeded",
          exitCode: 1,
        }),
      ).toBe(true);
      expect(
        isHarnessFailure({
          output: "RangeError: Invalid array length",
          exitCode: 1,
        }),
      ).toBe(true);
      expect(
        isHarnessFailure({
          output: "URIError: URI malformed",
          exitCode: 1,
        }),
      ).toBe(true);
      expect(
        isHarnessFailure({
          output: "EvalError: Code generation from strings disallowed",
          exitCode: 1,
        }),
      ).toBe(true);

      expect(
        isHarnessFailure({
          output: "AssertionError [ERR_ASSERTION]: expected 1 to be 2",
          exitCode: 1,
        }),
      ).toBe(false);
    });

    it("correctly identifies genuine assertion failures", () => {
      expect(isAssertionFailure("AssertionError: expected true to be false", 1)).toBe(true);
      expect(
        isAssertionFailure(
          "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal",
          1,
        ),
      ).toBe(true);
      expect(isAssertionFailure("ERR_ASSERTION: Values not equal", 1)).toBe(true);
      expect(isAssertionFailure("EXPLOIT_REPRODUCED", 1)).toBe(true);
      expect(isAssertionFailure("AssertionError", 0)).toBe(false);
      expect(isAssertionFailure("TypeError: Cannot read properties of undefined", 1)).toBe(false);
      expect(isAssertionFailure("RangeError: Maximum call stack size exceeded", 1)).toBe(false);
      expect(isAssertionFailure("URIError: URI malformed", 1)).toBe(false);
      expect(isAssertionFailure("EvalError: Code generation from strings disallowed", 1)).toBe(
        false,
      );
      expect(
        isAssertionFailure(
          "Command failed with exit code 1: node '/path/to/my assertion error repo/repro.cjs'",
          1,
        ),
      ).toBe(false);
      expect(
        isAssertionFailure("Debug: testing if assertion failed flag is set\nTypeError: null", 1),
      ).toBe(false);
      expect(isAssertionFailure("Error: Handled assertion error in input validator", 1)).toBe(
        false,
      );
      expect(isAssertionFailure("Assertion failed to reproduce, test aborted", 1)).toBe(false);
      expect(
        isAssertionFailure("Target did not output EXPLOIT_REPRODUCED token; aborting test", 1),
      ).toBe(false);
    });

    it("prepares reproduction test file from string content or file reference", async () => {
      const inlineTest = 'const assert = require("node:assert"); assert(true);';
      const prepared = await prepareReproductionTestFile({
        cwd: tempDir,
        packageName: "@scope/pkg",
        vulnerableVersion: "1.0.0",
        patchesDir: "./patches",
        reproductionTest: inlineTest,
      });

      expect(prepared.isCreated).toBe(true);
      expect(prepared.testFilePath).toBeDefined();
      expect(prepared.testFilePath).toContain("scope+pkg+1.0.0.test.cjs");

      // Second call finds existing file
      const existing = await prepareReproductionTestFile({
        cwd: tempDir,
        packageName: "@scope/pkg",
        vulnerableVersion: "1.0.0",
        patchesDir: "./patches",
        proofOfFix: prepared.testFilePath,
      });
      expect(existing.isCreated).toBe(false);
      expect(existing.testFilePath).toBe(prepared.testFilePath);
    });
  });
});
