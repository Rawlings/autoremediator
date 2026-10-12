import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSlaBreach } from "../../packages/core/src/platform/policy.js";
import { runProofOfFixPhase } from "../../packages/core/src/remediation/proof-of-fix/runner.js";
import { generateUnifiedDiff } from "../../packages/core/src/remediation/tools/generate-patch/helpers.js";
import { cleanupTempDir, createTempDir } from "../fixtures/temp-repo.js";

describe("Tier 2 - Boundary Cases", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("boundary-test-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("Boundary 1: proof-of-fix execution times out when script exceeds timeout limit", async () => {
    const hangScript = join(tempDir, "hang.js");
    // Long running script that never exits on its own
    writeFileSync(hangScript, `setInterval(() => {}, 60000);\n`, "utf8");

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: hangScript,
      cwd: tempDir,
      timeoutMs: 300, // Short timeout to verify boundary termination
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("Boundary 2: generateUnifiedDiff returns null for identical files and handles empty files", () => {
    // Identical files -> null diff
    expect(generateUnifiedDiff("const a = 1;\n", "const a = 1;\n", "test.js")).toBeNull();

    // Empty to non-empty -> valid diff
    const diffFromEmpty = generateUnifiedDiff("", "console.log('hello');\n", "test.js");
    expect(diffFromEmpty).not.toBeNull();
    expect(diffFromEmpty).toContain("+console.log('hello');");

    // Non-empty to empty -> valid diff
    const diffToEmpty = generateUnifiedDiff("console.log('remove');\n", "", "test.js");
    expect(diffToEmpty).not.toBeNull();
    expect(diffToEmpty).toContain("-console.log('remove');");
  });

  it("Boundary 3: SLA breach calculations at threshold boundaries", () => {
    const slaPolicy = {
      critical: 24, // 24 hours
      high: 72,
      medium: 168,
      low: 720,
    };

    // Case A: Published 1 hour ago -> NO breach
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const breachRecent = checkSlaBreach("CVE-2026-0001", "CRITICAL", recentDate, slaPolicy);
    expect(breachRecent).toBeNull();

    // Case B: Published 25 hours ago -> breached by ~1 hour
    const overdueDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const breachOverdue = checkSlaBreach("CVE-2026-0002", "CRITICAL", overdueDate, slaPolicy);
    expect(breachOverdue).not.toBeNull();
    expect(breachOverdue?.cveId).toBe("CVE-2026-0002");
    expect(breachOverdue?.severity).toBe("CRITICAL");
    expect(breachOverdue?.hoursOverdue).toBeGreaterThanOrEqual(1);
  });

  it("Boundary 4: Proof-of-fix positive phase timeout terminates hanging verification", async () => {
    const hangScript = join(tempDir, "hang-positive.js");
    writeFileSync(hangScript, `setInterval(() => {}, 60000);\n`, "utf8");

    const result = await runProofOfFixPhase({
      stage: "positive",
      testFilePath: hangScript,
      cwd: tempDir,
      timeoutMs: 300,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("failed on patched target");
  });
});
