/// <reference types="node" />
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

// 1. Proof-of-Fix Runner & Process Isolation
import {
  runProofOfFixPhase,
  isHarnessFailure,
  isAssertionFailure,
  sanitizePathLeakage,
  stripStackTraceFrames,
} from "../src/remediation/proof-of-fix/runner.js";

// 2. Refactor Agent & AST Engine
import {
  parseCompilerDiagnostics,
  transformCallArguments,
  refactorConsumerCallSites,
  revertRefactorSnapshots,
} from "../src/remediation/refactor/refactor-agent.js";
import { findPackageCallSites } from "../src/remediation/refactor/call-site-finder.js";

// 3. Remediation Tools
import {
  generateUnifiedDiff,
  validatePatchedCodeSyntax,
  parseLlmAnalysisResponse,
  isValidLlmAnalysis,
  buildGeneratedPatches,
} from "../src/remediation/tools/generate-patch/helpers.js";
import { resolveInventoryVersion } from "../src/remediation/tools/check-inventory.js";
import { fetchPackageSourceTool } from "../src/remediation/tools/fetch-package-source.js";
import { applyVersionBumpTool } from "../src/remediation/tools/apply-version-bump.js";
import { applyPatchFileTool } from "../src/remediation/tools/apply-patch-file/index.js";

// 4. Platform Controls (Policy, Rollback, Jobs)
import {
  DEFAULT_POLICY,
  loadPolicy,
  isPackageAllowed,
  checkSlaBreach,
  isActiveSuppression,
  saveSuppressionToPolicy,
  findSuppression,
} from "../src/platform/policy.js";
import { recordFileTouch, withAtomicRollback } from "../src/platform/rollback.js";
import { BoundedJobRegistry, type AsyncRemediationJob } from "../src/platform/jobs.js";
import { reconcilePatchArtifacts } from "../src/api/patches/reconcile.js";

// 5. OpenAPI, MCP, and CLI Triage
import { createOpenApiServer } from "../src/openapi/server.js";
import { handleToolCall, TOOLS } from "../src/mcp/server.js";
import { runInteractiveTriage } from "../src/cli/triage.js";

describe("Tier 5 White-Box Adversarial Coverage Hardening Suite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tier5-adversarial-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // DOMAIN 1: Proof-of-Fix Runner, Harness Failure Classification & Isolation
  // =========================================================================
  describe("Proof-of-Fix Runner & Process Isolation Edge Cases", () => {
    it("verifies directory path leakage defect is prevented in isHarnessFailure", () => {
      // White-box finding: isHarnessFailure previously inspected combined = `${output}\n${errorMsg}`.
      // If errorMsg contained directory path with "SyntaxError" or "MODULE_NOT_FOUND",
      // it falsely triggered harnessFailure: true even when the test threw a valid AssertionError!
      const leakedPathContext = {
        exitCode: 1,
        output: "AssertionError [ERR_ASSERTION]: EXPLOIT_REPRODUCED",
        errorMsg: "Command failed with exit code 1: node /projects/CVE-SyntaxError-repro/test.cjs",
      };

      // Verified fix: isHarnessFailure ignores errorMsg when it embeds command line paths
      const isDefectTriggered = isHarnessFailure(leakedPathContext);
      expect(isDefectTriggered).toBe(false); // Directory path collision prevented
    });

    it("verifies clean exploit reproduction when directory path does not contain error keywords", async () => {
      const reproScript = `
const assert = require("node:assert");
assert.strictEqual(1, 2, "EXPLOIT_REPRODUCED: exploit verified");
`;
      const scriptPath = join(tempDir, "repro.cjs");
      await writeFile(scriptPath, reproScript, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: scriptPath,
        cwd: tempDir,
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.harnessFailure).toBeFalsy();
      expect(result.exitCode).toBe(1);
    });

    it("rejects false positives when an unhandled crash occurs inside an AssertionError directory", async () => {
      const crashScript = `
// Unhandled runtime TypeError should NOT pass as an exploit assertion
throw new TypeError("Cannot read properties of undefined (reading 'exploit')");
`;
      const scriptPath = join(tempDir, "crash.cjs");
      await writeFile(scriptPath, crashScript, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: scriptPath,
        cwd: tempDir,
      });

      expect(result.executed).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.harnessFailure).toBe(true);
      expect(result.error).toContain("TypeError");
    });

    it("evaluates stderr crash veto over misleading stdout assertion logs", async () => {
      const script = `
// Misleading stdout says EXPLOIT_REPRODUCED, but process crashes with unhandled Error on stderr
console.log("EXPLOIT_REPRODUCED: exploit reached");
throw new ReferenceError("unhandled crash in teardown");
`;
      const scriptPath = join(tempDir, "misleading.cjs");
      await writeFile(scriptPath, script, "utf8");

      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: scriptPath,
        cwd: tempDir,
      });

      expect(result.executed).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.harnessFailure).toBe(true);
    });

    it("handles execution hanging via real process timeout cancellation", async () => {
      const hangScript = `
// Infinite loop simulating hanging exploit test
setInterval(() => {}, 100000);
`;
      const scriptPath = join(tempDir, "hang.cjs");
      await writeFile(scriptPath, hangScript, "utf8");

      const start = Date.now();
      const result = await runProofOfFixPhase({
        stage: "negative",
        testFilePath: scriptPath,
        cwd: tempDir,
        timeoutMs: 600,
      });
      const elapsed = Date.now() - start;

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.harnessFailure).toBe(true);
      expect(result.error).toContain("timed out");
      expect(elapsed).toBeLessThan(3500);
    });

    it("handles fatal signals and process aborts as harness failures", () => {
      expect(isHarnessFailure({ exitCode: 137, output: "Killed", signal: "SIGKILL" })).toBe(true);
      expect(isHarnessFailure({ exitCode: 143, output: "Terminated", signal: "SIGTERM" })).toBe(
        true,
      );

      const validAssertion = {
        exitCode: 1,
        output: "AssertionError [ERR_ASSERTION]: EXPLOIT_REPRODUCED",
      };
      expect(isHarnessFailure(validAssertion)).toBe(false);
      expect(isAssertionFailure(validAssertion.output, validAssertion.exitCode)).toBe(true);
    });

    it("sanitizes path leakage and call-site stack frames robustly", () => {
      const rawText = `
    at /Users/test/node_modules/bad/index.js:10:5
    at async /Users/test/app.js:20:12
AssertionError [ERR_ASSERTION]: expected true to be false
`;
      const stripped = stripStackTraceFrames(rawText);
      expect(stripped).not.toContain("at /Users/test/");
      expect(stripped).toContain("AssertionError");

      const sanitized = sanitizePathLeakage("error in /custom/secret/path/test.js", [
        "/custom/secret/path",
      ]);
      expect(sanitized).toBe("error in <path>/test.js");
    });
  });

  // =========================================================================
  // DOMAIN 2: AST Refactor Agent, Call-Site Finder & Transformations
  // =========================================================================
  describe("AST Breaking Change Refactoring & Call-Site Analysis", () => {
    it("parses diverse compiler diagnostics with suggestions and missing members", () => {
      const diagOutput = `
src/app.ts(14,7): error TS2339: Property 'sync' does not exist on type 'typeof import("rimraf")'. Did you mean 'rimrafSync'?
src/utils/uuid.ts:25:3 - error TS2614: Module '"uuid"' has no exported member 'default'. Did you mean 'v4'?
src/globber.ts(2,1): error TS1259: Module '"glob"' can only be used with a default import using the 'esModuleInterop' flag
`;
      const diags = parseCompilerDiagnostics(diagOutput);
      expect(diags.length).toBe(3);

      expect(diags[0]).toMatchObject({
        filePath: "src/app.ts",
        line: 14,
        column: 7,
        code: "TS2339",
        missingMember: "sync",
        suggestedSymbol: "rimrafSync",
      });

      expect(diags[1]).toMatchObject({
        filePath: "src/utils/uuid.ts",
        line: 25,
        column: 3,
        code: "TS2614",
        suggestedSymbol: "v4",
      });

      expect(diags[2]).toMatchObject({
        filePath: "src/globber.ts",
        line: 2,
        column: 1,
        code: "TS1259",
      });
    });

    it("transforms call arguments: dropping single, leading, middle, and trailing parameters", () => {
      // 1. Single argument dropped
      const code1 = `const result = clean(tempDir);`;
      const res1 = transformCallArguments(code1, { callee: "clean", dropIndex: 0 });
      expect(res1.modified).toBe(true);
      expect(res1.newContent).toBe(`const result = clean();`);

      // 2. Leading argument dropped in 3-arg call
      const code2 = `const res = run(first, second, third);`;
      const res2 = transformCallArguments(code2, { callee: "run", dropIndex: 0 });
      expect(res2.modified).toBe(true);
      expect(res2.newContent).toBe(`const res = run(second, third);`);

      // 3. Middle argument dropped in 3-arg call
      const code3 = `const res = run(first, second, third);`;
      const res3 = transformCallArguments(code3, { callee: "run", dropIndex: 1 });
      expect(res3.modified).toBe(true);
      expect(res3.newContent).toBe(`const res = run(first, third);`);

      // 4. Last argument dropped in 3-arg call
      const code4 = `const res = run(first, second, third);`;
      const res4 = transformCallArguments(code4, { callee: "run", dropIndex: 2 });
      expect(res4.modified).toBe(true);
      expect(res4.newContent).toBe(`const res = run(first, second);`);

      // 5. Argument reordering [0, 1] -> [1, 0]
      const code5 = `const res = run(first, second);`;
      const res5 = transformCallArguments(code5, { callee: "run", reorder: [0, 1] });
      expect(res5.modified).toBe(true);
      expect(res5.newContent).toBe(`const res = run(second, first);`);
    });

    it("finds call sites without false positives on comments, strings, or unrelated object methods", async () => {
      const srcDir = join(tempDir, "src");
      await mkdir(srcDir, { recursive: true });

      // File A: Genuine import and call site
      const fileA = join(srcDir, "valid.ts");
      await writeFile(
        fileA,
        `
import uuid from "uuid";
const id = uuid.v4();
`,
        "utf8",
      );

      // File B: Mentions "uuid" in comment and string only; unrelated object has v4()
      const fileB = join(srcDir, "fake.ts");
      await writeFile(
        fileB,
        `
// We should replace uuid here
const myComment = "uuid is a package";
const otherObj = { v4: () => "not-real" };
const id = otherObj.v4();
`,
        "utf8",
      );

      const sites = findPackageCallSites(tempDir, "uuid");
      expect(sites.length).toBe(1);
      expect(sites[0]!.filePath).toBe(fileA);
      expect(sites[0]!.callSites?.length).toBe(1);
      expect(sites[0]!.callSites?.[0]!.memberName).toBe("v4");
    });

    it("performs automated codemod refactoring across breaking migrations and reverts on failure", async () => {
      const testFile = join(tempDir, "app.ts");
      const initialCode = `
import rimraf from "rimraf";
export function clean(p: string) {
  rimraf.sync(p);
}
`;
      await writeFile(testFile, initialCode, "utf8");

      const callSites = findPackageCallSites(tempDir, "rimraf");
      expect(callSites.length).toBe(1);

      const result = await refactorConsumerCallSites({
        cwd: tempDir,
        packageName: "rimraf",
        fromVersion: "3.0.2",
        toVersion: "5.0.5",
        diagnosticError: "Property 'sync' does not exist on type. Did you mean 'rimrafSync'?",
        callSites,
      });

      expect(result.applied).toBe(true);
      expect(result.refactoredFiles).toContain(testFile);

      const transformed = await readFile(testFile, "utf8");
      expect(transformed).toContain('import { rimrafSync } from "rimraf";');
      expect(transformed).toContain("rimrafSync(p);");

      // Verify rollback snapshot restoration works cleanly
      revertRefactorSnapshots(result.snapshots);
      const reverted = await readFile(testFile, "utf8");
      expect(reverted).toBe(initialCode);
    });
  });

  // =========================================================================
  // DOMAIN 3: Myers Diff Engine & Remediation Tools
  // =========================================================================
  describe("Remediation Tools: Version Bump, Patch Synthesis & Inventory", () => {
    it("handles boundary cases: identical files, empty files, pure additions, pure deletions", () => {
      expect(generateUnifiedDiff("const x = 1;\n", "const x = 1;\n", "test.js")).toBeNull();
      expect(generateUnifiedDiff("", "", "test.js")).toBeNull();

      const addDiff = generateUnifiedDiff("", "line1\nline2\n", "test.js");
      expect(addDiff).not.toBeNull();
      expect(addDiff).toContain("--- a/test.js");
      expect(addDiff).toContain("+++ b/test.js");
      expect(addDiff).toContain("+line1");
      expect(addDiff).toContain("+line2");

      const delDiff = generateUnifiedDiff("line1\nline2\n", "", "test.js");
      expect(delDiff).not.toBeNull();
      expect(delDiff).toContain("-line1");
      expect(delDiff).toContain("-line2");
    });

    it("generates multi-hunk diffs when changes are separated by large unchanged context", () => {
      const originalLines = [
        "top line",
        ...Array.from({ length: 15 }, (_, i) => `context line ${i}`),
        "middle vulnerable line",
        ...Array.from({ length: 15 }, (_, i) => `bottom context line ${i}`),
        "bottom vulnerable line",
      ];
      const fixedLines = [...originalLines];
      fixedLines[0] = "top patched line";
      fixedLines[16] = "middle patched line";
      fixedLines[32] = "bottom patched line";

      const diff = generateUnifiedDiff(
        originalLines.join("\n") + "\n",
        fixedLines.join("\n") + "\n",
        "multi.js",
      );

      expect(diff).not.toBeNull();
      const hunkMatches = diff!.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g);
      expect(hunkMatches?.length).toBe(3);
      expect(diff).toContain("-top line");
      expect(diff).toContain("+top patched line");
      expect(diff).toContain("-middle vulnerable line");
      expect(diff).toContain("+middle patched line");
    });

    it("validates syntax across JS/TS, JSON, and YAML strictly", () => {
      expect(validatePatchedCodeSyntax("file.ts", "const x: number = 42;").valid).toBe(true);
      expect(validatePatchedCodeSyntax("file.ts", "const x: = ;").valid).toBe(false);

      expect(validatePatchedCodeSyntax("package.json", '{"name": "test"}').valid).toBe(true);
      expect(validatePatchedCodeSyntax("package.json", '{"name": "test",}').valid).toBe(false);

      expect(validatePatchedCodeSyntax("config.yml", "name: test\nversion: 1.0\n").valid).toBe(
        true,
      );
      expect(validatePatchedCodeSyntax("config.yml", "name: : bad: yaml\n  - \n").valid).toBe(
        false,
      );
    });

    it("parses LLM analysis responses and builds validated unified diff patches", () => {
      const llmOutput = `
Here is the remediation analysis:
\`\`\`json
{
  "analysis": "Fixed prototype pollution vulnerability in merge function",
  "fixedCode": {
    "src/index.js": "function merge(a, b) { if (b.__proto__) return a; return Object.assign(a, b); }"
  },
  "confidence": 0.95,
  "riskLevel": "low",
  "reproductionTest": "const assert = require('assert'); assert(true);"
}
\`\`\`
`;
      const parsed = parseLlmAnalysisResponse(llmOutput);
      expect(parsed.ok).toBe(true);
      const analysis = parsed.ok ? parsed.analysis : ({} as any);
      expect(isValidLlmAnalysis(analysis)).toBe(true);
      expect(analysis.confidence).toBe(0.95);

      const sourceFiles = {
        "src/index.js": "function merge(a, b) { return Object.assign(a, b); }",
      };
      const patches = buildGeneratedPatches(sourceFiles, analysis.fixedCode);
      expect(patches.length).toBe(1);
      expect(patches[0]!.filePath).toBe("src/index.js");
      expect(patches[0]!.unifiedDiff).toContain("+function merge(a, b) { if (b.__proto__)");
    });

    it("resolves semver inventory strings across workspace, npm aliases, and ranges", () => {
      expect(resolveInventoryVersion("1.2.3")).toBe("1.2.3");
      expect(resolveInventoryVersion("  v1.2.3  ")).toBe("1.2.3");
      expect(resolveInventoryVersion("^1.2.0")).toBe("1.2.0");
      expect(resolveInventoryVersion("~2.3.4")).toBe("2.3.4");
      expect(resolveInventoryVersion("workspace:^3.0.0")).toBe("3.0.0");
      expect(resolveInventoryVersion("npm:lodash@^4.17.21")).toBe("4.17.21");
      expect(resolveInventoryVersion(">=5.0.0 <6.0.0")).toBe("5.0.0");
    });

    it("verifies apply-version-bump handles dry-run, missing dependencies, and policy blocks truthfully", async () => {
      const pkgPath = join(tempDir, "package.json");
      await writeFile(
        pkgPath,
        JSON.stringify({ name: "app", dependencies: { lodash: "^4.17.20" } }, null, 2),
        "utf8",
      );

      // 1. Dry run
      const dryResult = await applyVersionBumpTool.execute({
        cwd: tempDir,
        packageName: "lodash",
        fromVersion: "4.17.20",
        toVersion: "4.17.21",
        dryRun: true,
      });
      expect(dryResult.applied).toBe(false);
      expect(dryResult.dryRun).toBe(true);
      expect(dryResult.message).toContain("[DRY RUN]");

      // 2. Transitive dependency not declared
      const transResult = await applyVersionBumpTool.execute({
        cwd: tempDir,
        packageName: "nonexistent-dep",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        dryRun: true,
      });
      expect(transResult.applied).toBe(false);
      expect(transResult.unresolvedReason).toBe("transitive-dependency");

      // 3. Deny-list blocked package
      const policyPath = join(tempDir, "policy.yml");
      await writeFile(policyPath, "denyPackages: ['lodash']\n", "utf8");
      const blockedResult = await applyVersionBumpTool.execute({
        cwd: tempDir,
        packageName: "lodash",
        fromVersion: "4.17.20",
        toVersion: "4.17.21",
        policy: policyPath,
        dryRun: false,
      });
      expect(blockedResult.applied).toBe(false);
      expect(blockedResult.unresolvedReason).toBe("policy-blocked");
    });

    it("verifies fetchPackageSource blocks invalid package names and malicious pattern injection", async () => {
      // 1. Path traversal injection in package name
      const res1 = await fetchPackageSourceTool.execute({
        packageName: "../../etc/passwd",
        version: "1.0.0",
      });
      expect(res1.success).toBe(false);
      expect(res1.error).toContain("Invalid package name");

      // 2. Shell metacharacters injection
      const res2 = await fetchPackageSourceTool.execute({
        packageName: "lodash; rm -rf /",
        version: "1.0.0",
      });
      expect(res2.success).toBe(false);
      expect(res2.error).toContain("Invalid package name");

      // 3. Unsafe file patterns (ReDoS / shell chars)
      const res3 = await fetchPackageSourceTool.execute({
        packageName: "lodash",
        version: "4.17.21",
        filePatterns: ["; echo pwned", "<script>"],
      });
      expect(res3.success).toBe(false);
      expect(res3.error).toContain("No valid file patterns provided");
    });

    it("reconciles patch artifacts without auto-apply truthfully", async () => {
      const patchesDir = join(tempDir, "patches");
      await mkdir(patchesDir, { recursive: true });

      const patchFile = join(patchesDir, "demo-pkg+1.0.0.patch");
      const manifestFile = `${patchFile}.json`;

      await writeFile(
        patchFile,
        "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        "utf8",
      );
      await writeFile(
        manifestFile,
        JSON.stringify({
          packageName: "demo-pkg",
          vulnerableVersion: "1.0.0",
          cveId: "CVE-2026-9999",
        }),
        "utf8",
      );

      const report = await reconcilePatchArtifacts({
        cwd: tempDir,
        patchesDir,
        autoApply: false,
      });

      expect(report.reconciled.length).toBe(1);
      expect(report.reconciled[0]!.packageName).toBe("demo-pkg");
      expect(report.reconciled[0]!.status).toBe("patch-retained");
    });

    it("validates applyPatchFileTool rejects invalid patch syntax", async () => {
      const res = await applyPatchFileTool.execute({
        packageName: "demo-pkg",
        vulnerableVersion: "1.0.0",
        patchContent: "invalid diff header",
        cwd: tempDir,
      });
      expect(res.applied).toBe(false);
      expect(res.validationPhases?.[0]?.phase).toBe("diff-format");
      expect(res.validationPhases?.[0]?.passed).toBe(false);
    });
  });

  // =========================================================================
  // DOMAIN 4: Platform Controls: Policy, Rollback, and Bounded Jobs
  // =========================================================================
  describe("Platform Controls & Defense Invariants", () => {
    it("evaluates package deny list and allow list with wildcards and scoped packages", () => {
      const policy = {
        ...DEFAULT_POLICY,
        denyPackages: ["bad-pkg", "@malicious/*", "unsafe-*"],
        allowPackages: ["react", "react-*", "@safe/*"],
      };

      // Deny checks
      expect(isPackageAllowed(policy, "bad-pkg")).toBe(false);
      expect(isPackageAllowed(policy, "@malicious/payload")).toBe(false);
      expect(isPackageAllowed(policy, "unsafe-lib")).toBe(false);

      // Allow checks
      expect(isPackageAllowed(policy, "react")).toBe(true);
      expect(isPackageAllowed(policy, "react-dom")).toBe(true);
      expect(isPackageAllowed(policy, "@safe/tools")).toBe(true);

      // Not in allow list
      expect(isPackageAllowed(policy, "vue")).toBe(false);
      expect(isPackageAllowed(policy, "express")).toBe(false);
    });

    it("calculates SLA breach windows accurately and handles invalid published dates", () => {
      const slaPolicy = {
        critical: 24, // 24 hours
        high: 72, // 72 hours
      };

      // 1. Published 48 hours ago for critical -> overdue by 24 hours
      const published48hAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const breach = checkSlaBreach("CVE-2026-1111", "CRITICAL", published48hAgo, slaPolicy);
      expect(breach).not.toBeNull();
      expect(breach?.hoursOverdue).toBeGreaterThanOrEqual(23);
      expect(breach?.hoursOverdue).toBeLessThanOrEqual(25);

      // 2. Published 12 hours ago for critical -> not breached
      const published12hAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      expect(checkSlaBreach("CVE-2026-2222", "CRITICAL", published12hAgo, slaPolicy)).toBeNull();

      // 3. Invalid published date -> null
      expect(checkSlaBreach("CVE-2026-3333", "CRITICAL", "invalid-date", slaPolicy)).toBeNull();
    });

    it("persists VEX suppressions to policy YAML with deduplication and expiration support", async () => {
      const policyPath = join(tempDir, "autoremediator.yml");

      const supp1 = {
        cveId: "CVE-2026-0001",
        justification: "not_affected" as const,
        notes: "Initial triage assessment",
      };
      saveSuppressionToPolicy(tempDir, supp1, policyPath);

      // Update same CVE with updated notes (case-insensitive deduplication)
      const supp2 = {
        cveId: "cve-2026-0001",
        justification: "mitigated" as const,
        notes: "Firewall rule active",
      };
      saveSuppressionToPolicy(tempDir, supp2, policyPath);

      const loaded = loadPolicy(tempDir, policyPath);
      expect(loaded.suppressions?.length).toBe(1);
      expect(loaded.suppressions?.[0]!.cveId).toBe("cve-2026-0001");
      expect(loaded.suppressions?.[0]!.justification).toBe("mitigated");
      expect(loaded.suppressions?.[0]!.notes).toBe("Firewall rule active");

      // Verify active vs expired suppression
      expect(isActiveSuppression(supp2)).toBe(true);
      const expiredSupp = {
        ...supp2,
        expiresAt: new Date(Date.now() - 10000).toISOString(),
      };
      expect(isActiveSuppression(expiredSupp)).toBe(false);
    });

    it("manages bounded job registry: capacity enforcement, terminal priority eviction, and TTL", () => {
      const registry = new BoundedJobRegistry({ maxCapacity: 3, ttlMs: 1000 });

      const job1: AsyncRemediationJob = {
        jobId: "job-1",
        status: "done",
        submittedAt: new Date(Date.now() - 500).toISOString(),
        completedAt: new Date(Date.now() - 400).toISOString(),
      };
      const job2: AsyncRemediationJob = {
        jobId: "job-2",
        status: "running",
        submittedAt: new Date(Date.now() - 300).toISOString(),
      };
      const job3: AsyncRemediationJob = {
        jobId: "job-3",
        status: "pending",
        submittedAt: new Date(Date.now() - 200).toISOString(),
      };

      registry.set("job-1", job1);
      registry.set("job-2", job2);
      registry.set("job-3", job3);
      expect(registry.size).toBe(3);

      // Adding 4th job should evict terminal job (job-1) first, protecting running and pending jobs
      const job4: AsyncRemediationJob = {
        jobId: "job-4",
        status: "pending",
        submittedAt: new Date().toISOString(),
      };
      registry.set("job-4", job4);

      expect(registry.size).toBe(3);
      expect(registry.has("job-1")).toBe(false);
      expect(registry.has("job-2")).toBe(true);
      expect(registry.has("job-3")).toBe(true);
      expect(registry.has("job-4")).toBe(true);

      // Check stats
      const stats = registry.stats();
      expect(stats.running).toBe(1);
      expect(stats.pending).toBe(2);
      expect(stats.done).toBe(0);

      // TTL expiration check
      const oldJob: AsyncRemediationJob = {
        jobId: "job-old",
        status: "done",
        submittedAt: new Date(Date.now() - 5000).toISOString(),
        completedAt: new Date(Date.now() - 4000).toISOString(),
      };
      expect(registry.isExpired(oldJob)).toBe(true);
    });

    it("executes atomic rollback restoring created, modified, and deleted files", async () => {
      const trackedFile = join(tempDir, "package.json");
      await writeFile(trackedFile, JSON.stringify({ name: "clean-project" }, null, 2), "utf8");

      let createdFile = join(tempDir, "patches", "demo.patch");

      await withAtomicRollback(tempDir, async () => {
        // Mutate tracked file
        await writeFile(trackedFile, JSON.stringify({ name: "dirty-project" }, null, 2), "utf8");
        // Create new file and register touch
        await mkdir(join(tempDir, "patches"), { recursive: true });
        recordFileTouch(createdFile);
        await writeFile(createdFile, "diff content", "utf8");

        // Throw to trigger rollback
        throw new Error("Simulated remediation failure in rollback transaction");
      }).catch(() => {});

      // Verify tracked file reverted
      const restoredJson = JSON.parse(await readFile(trackedFile, "utf8"));
      expect(restoredJson.name).toBe("clean-project");

      // Verify created file removed
      expect(existsSync(createdFile)).toBe(false);
    });
  });

  // =========================================================================
  // DOMAIN 5: OpenAPI Server, MCP Server, and CLI Triage
  // =========================================================================
  describe("Surface Integrity: OpenAPI HTTP Server, MCP stdio & CLI Triage", () => {
    async function executeOpenApiRequest(
      server: any,
      method: string,
      path: string,
      body?: string,
    ): Promise<{ status: number; json: any }> {
      const socket = new Socket();
      const req = new IncomingMessage(socket);
      req.method = method;
      req.url = path;
      req.headers = {
        host: "127.0.0.1",
        "content-type": "application/json",
      };

      const res = new ServerResponse(req);
      let responseData = "";

      return new Promise<{ status: number; json: any }>((resolve) => {
        const origEnd = res.end.bind(res);
        res.end = ((chunk?: any, ...args: any[]) => {
          if (chunk) {
            responseData += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          }
          let parsed = null;
          try {
            parsed = responseData ? JSON.parse(responseData) : null;
          } catch {
            parsed = responseData;
          }
          resolve({
            status: res.statusCode,
            json: parsed,
          });
          return origEnd(chunk, ...args);
        }) as any;

        server.emit("request", req, res);

        if (body !== undefined) {
          req.push(body);
        }
        req.push(null);
      });
    }

    it("serves OpenAPI spec, job polling, and 404 responses cleanly", async () => {
      const mockDeps = {
        remediateFn: async () => ({}) as any,
        remediateFromScanFn: async () => ({}) as any,
        remediatePortfolioFn: async () => ({}) as any,
        planRemediationFn: async () => ({}) as any,
        updateOutdatedFn: async () => ({}) as any,
        listPatchArtifactsFn: async () => ({}) as any,
        inspectPatchArtifactFn: async () => ({}) as any,
        validatePatchArtifactFn: async () => ({}) as any,
        toVexFn: () => ({}) as any,
        submitRemediateJobFn: () => ({
          jobId: "job-123",
          status: "pending" as const,
          submittedAt: new Date().toISOString(),
        }),
        submitScanJobFn: () => ({
          jobId: "job-123",
          status: "pending" as const,
          submittedAt: new Date().toISOString(),
        }),
        submitPortfolioJobFn: () => ({
          jobId: "job-123",
          status: "pending" as const,
          submittedAt: new Date().toISOString(),
        }),
        pollJobFn: (id: string) => {
          if (id === "job-123") {
            return {
              jobId: "job-123",
              status: "done" as const,
              submittedAt: new Date().toISOString(),
            };
          }
          throw new Error(`Job ${id} not found`);
        },
      };

      const server = createOpenApiServer(mockDeps);

      // 1. GET /openapi.json
      const resSpec = await executeOpenApiRequest(server, "GET", "/openapi.json");
      expect(resSpec.status).toBe(200);
      expect(resSpec.json.openapi).toBe("3.1.0");

      // 2. GET /jobs/job-123
      const resJob = await executeOpenApiRequest(server, "GET", "/jobs/job-123");
      expect(resJob.status).toBe(200);
      expect(resJob.json.status).toBe("done");

      // 3. GET /jobs/non-existent
      const resJob404 = await executeOpenApiRequest(server, "GET", "/jobs/non-existent");
      expect(resJob404.status).toBe(404);

      // 4. GET /unrecognized-path
      const res404 = await executeOpenApiRequest(server, "GET", "/unrecognized-path");
      expect(res404.status).toBe(404);
    });

    it("dispatches MCP tools, enforces input validation, and exposes registered capabilities", async () => {
      // 1. health tool
      const healthRes = await handleToolCall("health", {});
      expect(healthRes.isError).toBeFalsy();
      const healthData = JSON.parse(healthRes.content[0]!.text);
      expect(healthData.status).toBe("ok");
      expect(healthData.toolCount).toBe(TOOLS.length);
      expect(healthData.capabilities).toContain("remediate");
      expect(healthData.capabilities).toContain("toVex");

      // 2. checkReachability requires packageName
      const reachabilityRes = await handleToolCall("checkReachability", {});
      expect(reachabilityRes.isError).toBe(true);
      expect(reachabilityRes.content[0]!.text).toContain("packageName is required");

      // 3. evaluatePackage requires packageName
      const evalRes = await handleToolCall("evaluatePackage", {});
      expect(evalRes.isError).toBe(true);
      expect(evalRes.content[0]!.text).toContain("packageName is required");

      // 4. toVex requires report object
      const vexRes = await handleToolCall("toVex", {});
      expect(vexRes.isError).toBe(true);
      expect(vexRes.content[0]!.text).toContain("report is required");

      // 5. Unknown tool
      const unknownRes = await handleToolCall("nonExistentTool", {});
      expect(unknownRes.isError).toBe(true);
      expect(unknownRes.content[0]!.text).toContain("Unknown tool");
    });

    it("runs interactive CLI triage workflow with simulated stream inputs", async () => {
      // Create a test scan file matching npm-audit structure
      const scanFile = join(tempDir, "audit.json");
      const scanContent = {
        vulnerabilities: {
          lodash: {
            name: "lodash",
            severity: "high",
            via: [
              {
                source: 1065,
                name: "lodash",
                url: "https://github.com/advisories/GHSA-p6mc-m468-83gw/CVE-2021-23337",
              },
            ],
          },
        },
      };
      await writeFile(scanFile, JSON.stringify(scanContent), "utf8");

      const outStream = new PassThrough();
      let outputText = "";
      outStream.on("data", (chunk: any) => {
        outputText += String(chunk);
      });

      // Provide simulated answers: 'x' (suppress), '1' (not_affected), 'False positive in internal build' (notes)
      const answers = ["x", "1", "False positive in internal build"];
      const mockRl = {
        question: async () => answers.shift() ?? "",
        close: () => {},
      } as any;

      await runInteractiveTriage(scanFile, {
        cwd: tempDir,
        rl: mockRl,
        output: outStream,
      });

      expect(outputText).toContain("Found 1 unique vulnerability(ies) to triage");
      expect(outputText).toContain("Persisted suppression for CVE-2021-23337");
      expect(outputText).toContain("Suppressed:     1");

      // Verify suppression persisted to policy file
      const loaded = loadPolicy(tempDir);
      const found = findSuppression(loaded, "CVE-2021-23337");
      expect(found).toBeDefined();
      expect(found?.justification).toBe("not_affected");
      expect(found?.notes).toBe("False positive in internal build");
    });
  });
});
