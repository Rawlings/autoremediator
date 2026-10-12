import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleProofOfFixVerification,
  runProofOfFixPhase,
} from "../../packages/core/src/remediation/proof-of-fix/runner.js";
import { cleanupTempDir, createTempDir } from "../fixtures/temp-repo.js";

describe("Tier 1 - Domain 2: Dual-Stage Proof-of-Fix Verification", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("pof-test-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("F5: negative phase succeeds when real Node process fails assertion (exploit reproduced)", async () => {
    // Write target file with vulnerable implementation
    writeFileSync(
      join(tempDir, "target.js"),
      `export function sanitize(input) { return input; } // vulnerable: does not sanitize\n`,
      "utf8",
    );

    // Write reproduction script that asserts sanitized output
    const testFile = join(tempDir, "repro.js");
    writeFileSync(
      testFile,
      `import assert from "node:assert";
import { sanitize } from "./target.js";
// Expect sanitized string; vulnerable implementation returns raw input, triggering AssertionError
assert.strictEqual(sanitize("<script>"), "&lt;script&gt;");
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

  it("F5: negative phase fails when exploit reproduction test passes (false negative)", async () => {
    // Write target that already passes
    writeFileSync(
      join(tempDir, "target.js"),
      `export function sanitize(input) { return "&lt;script&gt;"; }\n`,
      "utf8",
    );

    const testFile = join(tempDir, "repro.js");
    writeFileSync(
      testFile,
      `import assert from "node:assert";
import { sanitize } from "./target.js";
assert.strictEqual(sanitize("<script>"), "&lt;script&gt;");
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

  it("F5: negative phase distinguishes harness syntax errors from true exploit failure", async () => {
    const testFile = join(tempDir, "broken-syntax.js");
    writeFileSync(
      testFile,
      `// Syntax error
const broken = ;
`,
      "utf8",
    );

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: testFile,
      cwd: tempDir,
    });

    // In negative phase, harness errors must not be counted as exploit reproduction
    // Exit code is non-zero, but output contains SyntaxError
    expect(result.passed).toBe(false);
  });

  it("F5: positive phase succeeds when real Node process exits 0 on patched target", async () => {
    writeFileSync(
      join(tempDir, "target.js"),
      `export function sanitize(input) { return "&lt;script&gt;"; }\n`,
      "utf8",
    );

    const testFile = join(tempDir, "repro.js");
    writeFileSync(
      testFile,
      `import assert from "node:assert";
import { sanitize } from "./target.js";
assert.strictEqual(sanitize("<script>"), "&lt;script&gt;");
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

  it("F5: positive phase fails when patched target still triggers assertion error", async () => {
    writeFileSync(
      join(tempDir, "target.js"),
      `export function sanitize(input) { return input; }\n`,
      "utf8",
    );

    const testFile = join(tempDir, "repro.js");
    writeFileSync(
      testFile,
      `import assert from "node:assert";
import { sanitize } from "./target.js";
assert.strictEqual(sanitize("<script>"), "&lt;script&gt;");
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
    expect(result.error).toContain("failed on patched target");
  });

  it("F6 & F7: assembleProofOfFixVerification enforces strict dual-stage passing", () => {
    // Both pass -> verified
    const verified = assembleProofOfFixVerification({
      reproductionTestPath: "repro.js",
      negativePhase: { executed: true, passed: true, exitCode: 1, durationMs: 50 },
      positivePhase: { executed: true, passed: true, exitCode: 0, durationMs: 40 },
    });
    expect(verified.status).toBe("verified");
    expect(verified.failureReason).toBeUndefined();

    // Negative failed (did not reproduce) -> failed
    const failedNegative = assembleProofOfFixVerification({
      reproductionTestPath: "repro.js",
      negativePhase: {
        executed: true,
        passed: false,
        exitCode: 0,
        error: "failed-to-reproduce",
      },
      positivePhase: { executed: true, passed: true, exitCode: 0 },
    });
    expect(failedNegative.status).toBe("failed");
    expect(failedNegative.failureReason).toBe("failed-to-reproduce");

    // Positive failed (still vulnerable) -> failed
    const failedPositive = assembleProofOfFixVerification({
      reproductionTestPath: "repro.js",
      negativePhase: { executed: true, passed: true, exitCode: 1 },
      positivePhase: {
        executed: true,
        passed: false,
        exitCode: 1,
        error: "assertion-failed-on-patch",
      },
    });
    expect(failedPositive.status).toBe("failed");
    expect(failedPositive.failureReason).toBe("assertion-failed-on-patch");
  });
});
