import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleProofOfFixVerification,
  runProofOfFixPhase,
} from "../../packages/core/src/remediation/proof-of-fix/runner.js";
import {
  generateUnifiedDiff,
  validatePatchedCodeSyntax,
} from "../../packages/core/src/remediation/tools/generate-patch/helpers.js";
import { cleanupTempDir, createTempRepo } from "../fixtures/temp-repo.js";

describe("Tier 4 - Scenario 3: Patch Generation & Dual-Stage Proof-of-Fix", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo({
      initGit: true,
      name: "legacy-analytics-service",
      version: "1.0.0",
      files: {
        "src/query-parser.js": `export function parseQuery(queryStr) {
  const params = {};
  const pairs = queryStr.split("&");
  for (const pair of pairs) {
    const [key, val] = pair.split("=");
    if (key.includes(".")) {
      const [obj, prop] = key.split(".");
      (params[obj] || Object.prototype)[prop] = val;
    } else {
      params[key] = val;
    }
  }
  return params;
}
`,
        "test/exploit-repro.js": `import assert from "node:assert";
import { parseQuery } from "../src/query-parser.js";
parseQuery("__proto__.polluted=true");
assert.notStrictEqual(Object.prototype.polluted, "true", "EXPLOIT_REPRODUCED: prototype polluted");
console.log("Safe: no pollution");
`,
      },
    });
  });

  afterEach(() => {
    delete (Object.prototype as any).polluted;
    cleanupTempDir(repoDir);
  });

  it("synthesizes unified diff patch, validates AST syntax, and verifies with dual-stage proof-of-fix", async () => {
    const parserFile = join(repoDir, "src/query-parser.js");
    const originalCode = readFileSync(parserFile, "utf8");
    const reproFile = join(repoDir, "test/exploit-repro.js");

    // Phase 1: Dual-stage Negative Phase (Verify exploit reproduces)
    const negativeResult = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: reproFile,
      cwd: repoDir,
    });

    expect(negativeResult.executed).toBe(true);
    expect(negativeResult.passed).toBe(true);
    expect(negativeResult.exitCode).toBe(1);
    expect(negativeResult.output).toContain("EXPLOIT_REPRODUCED");

    // Phase 2: Synthesize patch and validate syntax
    const fixedCode = `export function parseQuery(queryStr) {
  const params = {};
  const pairs = queryStr.split("&");
  for (const pair of pairs) {
    const [key, val] = pair.split("=");
    if (key.includes("__proto__") || key.includes("constructor") || key.includes("prototype")) {
      continue;
    }
    if (key.includes(".")) {
      const [obj, prop] = key.split(".");
      params[obj] = params[obj] || {};
      params[obj][prop] = val;
    } else {
      params[key] = val;
    }
  }
  return params;
}
`;

    // AST syntax validation
    const syntax = validatePatchedCodeSyntax("src/query-parser.js", fixedCode);
    expect(syntax.valid).toBe(true);

    // Multi-line unified diff generation
    const unifiedDiff = generateUnifiedDiff(originalCode, fixedCode, "src/query-parser.js");
    expect(unifiedDiff).not.toBeNull();
    expect(unifiedDiff).toContain("--- a/src/query-parser.js");
    expect(unifiedDiff).toContain("+++ b/src/query-parser.js");
    expect(unifiedDiff).toContain("+    if (key.includes(\"__proto__\") || key.includes(\"constructor\") || key.includes(\"prototype\")) {");

    // Apply patch to file
    writeFileSync(parserFile, fixedCode, "utf8");

    // Phase 3: Dual-stage Positive Phase (Verify exploit is resolved by patch)
    const positiveResult = await runProofOfFixPhase({
      stage: "positive",
      testFilePath: reproFile,
      cwd: repoDir,
    });

    expect(positiveResult.executed).toBe(true);
    expect(positiveResult.passed).toBe(true);
    expect(positiveResult.exitCode).toBe(0);
    expect(positiveResult.output).toContain("Safe: no pollution");

    // Phase 4: Verification assembly
    const verification = assembleProofOfFixVerification({
      reproductionTestPath: reproFile,
      negativePhase: negativeResult,
      positivePhase: positiveResult,
    });

    expect(verification.status).toBe("verified");
  });
});
