import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runProofOfFixPhase,
} from "../../packages/core/src/remediation/proof-of-fix/runner.js";
import { applyPatchFileTool } from "../../packages/core/src/remediation/tools/apply-patch-file/index.js";
import { applyVersionBumpTool } from "../../packages/core/src/remediation/tools/apply-version-bump.js";
import { applyPackageOverrideTool } from "../../packages/core/src/remediation/tools/apply-package-override/index.js";
import { cleanupTempDir, createTempDir, createTempRepo } from "../fixtures/temp-repo.js";

describe("Milestone 2 Iteration 2 Adversarial Stress Suite", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("m2-adversarial-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // Helper to create a fully isolated offline repo configured for patch-package
  function setupOfflinePatchRepo(files: Record<string, string> = {}): string {
    const dir = createTempDir("m2-patch-offline-");
    const dummyPkgDir = join(dir, "dummy-patch-pkg");
    mkdirSync(dummyPkgDir, { recursive: true });
    writeFileSync(
      join(dummyPkgDir, "package.json"),
      JSON.stringify({
        name: "patch-package",
        version: "8.0.0",
        bin: "./bin.js",
      }),
      "utf8",
    );
    writeFileSync(join(dummyPkgDir, "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    try {
      chmodSync(join(dummyPkgDir, "bin.js"), 0o755);
    } catch {}

    const pkgJson = {
      name: "patch-offline-test",
      version: "1.0.0",
      private: true,
      type: "module",
      devDependencies: {
        "patch-package": "file:./dummy-patch-pkg",
      },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(dir, relPath);
      const lastSlash = relPath.lastIndexOf("/");
      if (lastSlash > 0) {
        mkdirSync(join(dir, relPath.slice(0, lastSlash)), { recursive: true });
      }
      writeFileSync(fullPath, content, "utf8");
    }

    return dir;
  }

  // =========================================================================
  // SUITE 1: Dual-Stage Proof-of-Fix Runner Under Hostile Process Execution
  // =========================================================================
  describe("Proof-of-Fix Runner Adversarial Process Execution", () => {
    it("rejects unhandled TypeError as harness error rather than exploit reproduction", async () => {
      const repro = join(tempDir, "repro-typeerror.js");
      writeFileSync(repro, "const x = null; x.someProperty();\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
      expect(res.error).toContain("TypeError");
    });

    it("rejects unhandled ReferenceError as harness error", async () => {
      const repro = join(tempDir, "repro-referror.js");
      writeFileSync(repro, "console.log(nonExistentVariableNotDefined);\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
    });

    it("rejects unhandled RangeError as harness error", async () => {
      const repro = join(tempDir, "repro-rangeerror.js");
      writeFileSync(repro, "new Array(-10);\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
    });

    it("rejects unhandled SyntaxError as harness error", async () => {
      const repro = join(tempDir, "repro-syntaxerror.js");
      writeFileSync(repro, "const a = ;\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
    });

    it("rejects unhandled URIError as harness error", async () => {
      const repro = join(tempDir, "repro-urierror.js");
      writeFileSync(repro, "decodeURIComponent('%');\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
    });

    it("rejects unhandled EvalError as harness error", async () => {
      const repro = join(tempDir, "repro-evalerror.js");
      writeFileSync(repro, "throw new EvalError('eval failed');\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
    });

    it("rejects generic unhandled Error with message not matching assertion formats", async () => {
      const repro = join(tempDir, "repro-genericerror.js");
      writeFileSync(repro, "throw new Error('Database connection failed');\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
    });

    it("rejects raw process.exit(1) without assertion output", async () => {
      const repro = join(tempDir, "repro-exit1.js");
      writeFileSync(repro, "process.exit(1);\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
    });

    it("rejects false negative when reproduction test exits 0 on unpatched target", async () => {
      const repro = join(tempDir, "repro-exit0.js");
      writeFileSync(repro, "console.log('all good'); process.exit(0);\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(true);
      expect(res.passed).toBe(false);
      expect(res.exitCode).toBe(0);
      expect(res.error).toContain("failed to reproduce vulnerability");
    });

    it("rejects deceptive stdout log preceding an unhandled runtime error", async () => {
      const repro = join(tempDir, "repro-deceptive-stdout.js");
      writeFileSync(
        repro,
        `console.log("AssertionError [ERR_ASSERTION]: fake");
throw new TypeError("Real uncaught failure");
`,
        "utf8",
      );

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
    });

    it("rejects deceptive stderr log preceding an unhandled runtime error", async () => {
      const repro = join(tempDir, "repro-deceptive-stderr.js");
      writeFileSync(
        repro,
        `console.error("AssertionError: fake message");
throw new TypeError("Real uncaught failure");
`,
        "utf8",
      );

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
    });

    it("aborts hanging test scripts when timeout is reached", async () => {
      const repro = join(tempDir, "repro-hang.js");
      writeFileSync(repro, "while(true) {}\n", "utf8");

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
        timeoutMs: 800,
      });

      expect(res.passed).toBe(false);
      expect(res.harnessFailure).toBe(true);
      expect(res.error).toContain("timed out");
    });

    it("accepts genuine node:assert strict assertion failure", async () => {
      const repro = join(tempDir, "repro-genuine-assert.js");
      writeFileSync(
        repro,
        `import assert from "node:assert/strict";
assert.equal(1, 2, "numbers not equal");
`,
        "utf8",
      );

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(true);
      expect(res.passed).toBe(true);
      expect(res.exitCode).toBe(1);
    });

    it("accepts genuine EXPLOIT_REPRODUCED token in error output", async () => {
      const repro = join(tempDir, "repro-exploit-token.js");
      writeFileSync(
        repro,
        `console.error("EXPLOIT_REPRODUCED: prototype pollution verified");
process.exit(1);
`,
        "utf8",
      );

      const res = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: repro,
        cwd: tempDir,
      });

      expect(res.executed).toBe(true);
      expect(res.passed).toBe(true);
      expect(res.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // SUITE 2: apply-patch-file Real On-Disk Execution & Rollbacks
  // =========================================================================
  describe("apply-patch-file Real On-Disk Execution & Rollbacks", () => {
    it("aborts and removes patch artifacts when negative phase fails to reproduce exploit", async () => {
      const repo = setupOfflinePatchRepo({
        "src/app.js": "export const val = 1;\n",
        "test/repro.js": "console.log('clean pass'); process.exit(0);\n",
      });

      const patchContent = `--- a/src/app.js
+++ b/src/app.js
@@ -1,1 +1,1 @@
-export const val = 1;
+export const val = 2;
`;

      const result = await applyPatchFileTool.execute({
        cwd: repo,
        packageName: "demo-pkg",
        vulnerableVersion: "1.0.0",
        patchContent,
        patchesDir: "./patches",
        reproductionTest: join(repo, "test/repro.js"),
        proofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.success).toBe(false);
      expect(result.unresolvedReason).toBe("proof-of-fix-failed");

      // Verify disk cleanup: patch file and manifest must NOT exist on disk
      const patchFilePath = join(repo, "patches/demo-pkg+1.0.0.patch");
      const manifestFilePath = join(repo, "patches/demo-pkg+1.0.0.json");
      expect(existsSync(patchFilePath)).toBe(false);
      expect(existsSync(manifestFilePath)).toBe(false);

      cleanupTempDir(repo);
    });

    it("returns policy-blocked and cleans up when negative phase fails under requireProofOfFix", async () => {
      const repo = setupOfflinePatchRepo({
        "src/app.js": "export const val = 1;\n",
        "test/repro.js": "console.log('clean pass'); process.exit(0);\n",
      });

      const patchContent = `--- a/src/app.js
+++ b/src/app.js
@@ -1,1 +1,1 @@
-export const val = 1;
+export const val = 2;
`;

      const result = await applyPatchFileTool.execute({
        cwd: repo,
        packageName: "demo-pkg",
        vulnerableVersion: "1.0.0",
        patchContent,
        patchesDir: "./patches",
        reproductionTest: join(repo, "test/repro.js"),
        requireProofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.success).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");

      const patchFilePath = join(repo, "patches/demo-pkg+1.0.0.patch");
      const manifestFilePath = join(repo, "patches/demo-pkg+1.0.0.json");
      expect(existsSync(patchFilePath)).toBe(false);
      expect(existsSync(manifestFilePath)).toBe(false);

      cleanupTempDir(repo);
    });

    it("returns policy-blocked when reproduction script is missing under requireProofOfFix", async () => {
      const repo = setupOfflinePatchRepo({
        "src/app.js": "export const val = 1;\n",
      });

      const patchContent = `--- a/src/app.js
+++ b/src/app.js
@@ -1,1 +1,1 @@
-export const val = 1;
+export const val = 2;
`;

      const result = await applyPatchFileTool.execute({
        cwd: repo,
        packageName: "demo-pkg",
        vulnerableVersion: "1.0.0",
        patchContent,
        patchesDir: "./patches",
        requireProofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.success).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");
      expect(result.message).toContain("Proof-of-fix verification required");

      const patchFilePath = join(repo, "patches/demo-pkg+1.0.0.patch");
      expect(existsSync(patchFilePath)).toBe(false);

      cleanupTempDir(repo);
    });

    it("cleans up disk artifacts when negative phase fails with unhandled runtime crash", async () => {
      const repo = setupOfflinePatchRepo({
        "src/app.js": "export const val = 1;\n",
        "test/crash.js": "const n = undefined; n.crashMethod();\n",
      });

      const patchContent = `--- a/src/app.js
+++ b/src/app.js
@@ -1,1 +1,1 @@
-export const val = 1;
+export const val = 2;
`;

      const result = await applyPatchFileTool.execute({
        cwd: repo,
        packageName: "demo-pkg",
        vulnerableVersion: "1.0.0",
        patchContent,
        patchesDir: "./patches",
        reproductionTest: join(repo, "test/crash.js"),
        proofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("proof-of-fix-failed");

      const patchFilePath = join(repo, "patches/demo-pkg+1.0.0.patch");
      const manifestFilePath = join(repo, "patches/demo-pkg+1.0.0.json");
      expect(existsSync(patchFilePath)).toBe(false);
      expect(existsSync(manifestFilePath)).toBe(false);

      cleanupTempDir(repo);
    });

    it("rolls back patch file and manifest when positive phase fails post-patch application", async () => {
      const repo = setupOfflinePatchRepo({
        "src/app.js": "export const val = 1;\n",
        // Test asserts val === 2 (fails in negative phase on val = 1 -> reproduced)
        // Patch will set val = 99 -> in positive phase, val === 2 still fails!
        "test/repro.js": `import assert from "node:assert";
import { val } from "../src/app.js";
assert.strictEqual(val, 2, "EXPLOIT_REPRODUCED: val is not 2");
`,
      });

      const patchContent = `--- a/src/app.js
+++ b/src/app.js
@@ -1,1 +1,1 @@
-export const val = 1;
+export const val = 99;
`;

      const result = await applyPatchFileTool.execute({
        cwd: repo,
        packageName: "demo-pkg",
        vulnerableVersion: "1.0.0",
        patchContent,
        patchesDir: "./patches",
        installMode: "prefer-offline",
        reproductionTest: join(repo, "test/repro.js"),
        proofOfFix: true,
        dryRun: false,
      });

      console.log("PATCH RESULT:", result);
      expect(result.applied).toBe(false);
      expect(result.success).toBe(false);
      expect(result.unresolvedReason).toBe("proof-of-fix-failed");

      // Verify that after positive failure, the patch file and manifest were DELETED from disk
      const patchFilePath = join(repo, "patches/demo-pkg+1.0.0.patch");
      const manifestFilePath = join(repo, "patches/demo-pkg+1.0.0.json");
      expect(existsSync(patchFilePath)).toBe(false);
      expect(existsSync(manifestFilePath)).toBe(false);

      cleanupTempDir(repo);
    });

    it("returns policy-blocked on positive phase failure under requireProofOfFix", async () => {
      const repo = setupOfflinePatchRepo({
        "src/app.js": "export const val = 1;\n",
        "test/repro.js": `import assert from "node:assert";
import { val } from "../src/app.js";
assert.strictEqual(val, 2, "EXPLOIT_REPRODUCED: val is not 2");
`,
      });

      const patchContent = `--- a/src/app.js
+++ b/src/app.js
@@ -1,1 +1,1 @@
-export const val = 1;
+export const val = 99;
`;

      const result = await applyPatchFileTool.execute({
        cwd: repo,
        packageName: "demo-pkg",
        vulnerableVersion: "1.0.0",
        patchContent,
        patchesDir: "./patches",
        installMode: "prefer-offline",
        reproductionTest: join(repo, "test/repro.js"),
        requireProofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.success).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");

      const patchFilePath = join(repo, "patches/demo-pkg+1.0.0.patch");
      expect(existsSync(patchFilePath)).toBe(false);

      cleanupTempDir(repo);
    });
  });

  // =========================================================================
  // SUITE 3: apply-version-bump Real On-Disk Execution & Rollbacks
  // =========================================================================
  describe("apply-version-bump Real On-Disk Execution & Rollbacks", () => {
    it("aborts before modifying package.json when negative phase fails to reproduce exploit", async () => {
      const repo = await createTempRepo({
        name: "bump-test-app",
        dependencies: {
          minimist: "^1.0.0",
        },
        files: {
          "test/repro.js": "console.log('clean exit'); process.exit(0);\n",
        },
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyVersionBumpTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        reproductionTest: join(repo, "test/repro.js"),
        proofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("proof-of-fix-failed");

      // Verify disk state: package.json must NOT have been changed
      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(currentPkgContent).toBe(originalPkgContent);

      cleanupTempDir(repo);
    });

    it("aborts before modifying package.json when negative phase suffers runtime crash", async () => {
      const repo = await createTempRepo({
        name: "bump-test-app",
        dependencies: {
          minimist: "^1.0.0",
        },
        files: {
          "test/repro.js": "throw new TypeError('Failed to load harness');\n",
        },
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyVersionBumpTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        reproductionTest: join(repo, "test/repro.js"),
        proofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("proof-of-fix-failed");

      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(currentPkgContent).toBe(originalPkgContent);

      cleanupTempDir(repo);
    });

    it("returns policy-blocked and leaves package.json untouched when negative phase fails under requireProofOfFix", async () => {
      const repo = await createTempRepo({
        name: "bump-test-app",
        dependencies: {
          minimist: "^1.0.0",
        },
        files: {
          "test/repro.js": "console.log('exit 0'); process.exit(0);\n",
        },
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyVersionBumpTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        reproductionTest: join(repo, "test/repro.js"),
        requireProofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");

      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(currentPkgContent).toBe(originalPkgContent);

      cleanupTempDir(repo);
    });

    it("returns policy-blocked and leaves package.json untouched when reproduction test is missing under requireProofOfFix", async () => {
      const repo = await createTempRepo({
        name: "bump-test-app",
        dependencies: {
          minimist: "^1.0.0",
        },
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyVersionBumpTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        requireProofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");
      expect(result.message).toContain("Proof-of-fix verification required");

      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(currentPkgContent).toBe(originalPkgContent);

      cleanupTempDir(repo);
    });
  });

  // =========================================================================
  // SUITE 4: apply-package-override Real On-Disk Execution & Rollbacks
  // =========================================================================
  describe("apply-package-override Real On-Disk Execution & Rollbacks", () => {
    it("aborts before modifying package.json when negative phase fails to reproduce exploit", async () => {
      const repo = await createTempRepo({
        name: "override-test-app",
        files: {
          "test/repro.js": "console.log('clean pass'); process.exit(0);\n",
        },
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyPackageOverrideTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        reproductionTest: join(repo, "test/repro.js"),
        proofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("proof-of-fix-failed");

      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(currentPkgContent).toBe(originalPkgContent);
      expect(currentPkgContent).not.toContain("overrides");

      cleanupTempDir(repo);
    });

    it("aborts before modifying package.json when negative phase suffers runtime crash", async () => {
      const repo = await createTempRepo({
        name: "override-test-app",
        files: {
          "test/repro.js": "throw new RangeError('Stack overflow');\n",
        },
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyPackageOverrideTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        reproductionTest: join(repo, "test/repro.js"),
        proofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("proof-of-fix-failed");

      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(currentPkgContent).toBe(originalPkgContent);

      cleanupTempDir(repo);
    });

    it("returns policy-blocked and leaves package.json untouched when negative phase fails under requireProofOfFix", async () => {
      const repo = await createTempRepo({
        name: "override-test-app",
        files: {
          "test/repro.js": "process.exit(0);\n",
        },
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyPackageOverrideTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        reproductionTest: join(repo, "test/repro.js"),
        requireProofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");

      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(currentPkgContent).toBe(originalPkgContent);

      cleanupTempDir(repo);
    });

    it("returns policy-blocked and leaves package.json untouched when reproduction test is missing under requireProofOfFix", async () => {
      const repo = await createTempRepo({
        name: "override-test-app",
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyPackageOverrideTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        requireProofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");
      expect(result.message).toContain("Proof-of-fix verification required");

      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(currentPkgContent).toBe(originalPkgContent);

      cleanupTempDir(repo);
    });

    it("rolls back package.json overrides on disk when positive phase fails post-override", async () => {
      const repo = await createTempRepo({
        name: "override-test-app",
        files: {
          // Negative phase: overrides?.minimist is undefined !== "9.9.9" -> fails assertion (reproduced!)
          // Override sets overrides.minimist = "1.0.1"
          // Positive phase: overrides?.minimist is "1.0.1" !== "9.9.9" -> STILL fails!
          "test/repro.js": `import assert from "node:assert";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.strictEqual(pkg.overrides?.minimist, "9.9.9", "EXPLOIT_REPRODUCED: not override 9.9.9");
`,
        },
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyPackageOverrideTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        installMode: "prefer-offline",
        reproductionTest: join(repo, "test/repro.js"),
        proofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("proof-of-fix-failed");

      // Verify package.json was reverted and does NOT contain overrides
      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(JSON.parse(currentPkgContent)).toEqual(JSON.parse(originalPkgContent));
      expect(currentPkgContent).not.toContain("overrides");

      cleanupTempDir(repo);
    });

    it("returns policy-blocked and rolls back package.json overrides on disk when positive phase fails under requireProofOfFix", async () => {
      const repo = await createTempRepo({
        name: "override-test-app",
        files: {
          "test/repro.js": `import assert from "node:assert";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.strictEqual(pkg.overrides?.minimist, "9.9.9", "EXPLOIT_REPRODUCED: not override 9.9.9");
`,
        },
      });

      const originalPkgContent = readFileSync(join(repo, "package.json"), "utf8");

      const result = await applyPackageOverrideTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        installMode: "prefer-offline",
        reproductionTest: join(repo, "test/repro.js"),
        requireProofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");

      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(JSON.parse(currentPkgContent)).toEqual(JSON.parse(originalPkgContent));
      expect(currentPkgContent).not.toContain("overrides");

      cleanupTempDir(repo);
    });

    it("successfully applies package override on disk when dual-stage verification passes", async () => {
      const repo = await createTempRepo({
        name: "override-test-app",
        files: {
          // Negative phase: overrides?.minimist is undefined !== "1.0.1" -> fails assertion (reproduced!)
          // Override sets overrides.minimist = "1.0.1"
          // Positive phase: overrides?.minimist is "1.0.1" === "1.0.1" -> passes cleanly!
          "test/repro.js": `import assert from "node:assert";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.strictEqual(pkg.overrides?.minimist, "1.0.1", "EXPLOIT_REPRODUCED: not overridden yet");
`,
        },
      });

      const result = await applyPackageOverrideTool.execute({
        cwd: repo,
        packageName: "minimist",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        installMode: "prefer-offline",
        reproductionTest: join(repo, "test/repro.js"),
        proofOfFix: true,
        dryRun: false,
      });

      expect(result.applied).toBe(true);
      expect(result.proofOfFix?.status).toBe("verified");

      const currentPkgContent = readFileSync(join(repo, "package.json"), "utf8");
      expect(JSON.parse(currentPkgContent).overrides.minimist).toBe("1.0.1");

      cleanupTempDir(repo);
    });
  });
});
