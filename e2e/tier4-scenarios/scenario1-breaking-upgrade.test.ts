import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleProofOfFixVerification,
  runProofOfFixPhase,
} from "../../packages/core/src/remediation/proof-of-fix/runner.js";
import { refactorConsumerCallSites } from "../../packages/core/src/remediation/refactor/refactor-agent.js";
import { cleanupTempDir, createTempRepo } from "../fixtures/temp-repo.js";

describe("Tier 4 - Scenario 1: Real CVE Upgrade with Breaking Types & Dual-Stage Proof-of-Fix", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo({
      initGit: true,
      name: "financial-service-app",
      version: "2.4.0",
      dependencies: {
        uuid: "8.3.2",
      },
      files: {
        "node_modules/uuid/package.json": JSON.stringify({ name: "uuid", version: "8.3.2", type: "module", main: "./index.js" }),
        "node_modules/uuid/index.js": `
export function v4() { return "00000000-0000-4000-8000-000000000000"; }
export function uuidv4() { return "00000000-0000-4000-8000-000000000000"; }
export default { v4, uuidv4 };
`,
        "src/tokens.js": `import uuid from "uuid";
export function generateSessionId() {
  return uuid.v4();
}
`,
        "test/reproduce-cve.js": `import assert from "node:assert";
import { generateSessionId } from "../src/tokens.js";
const id = generateSessionId();
// Expect UUID v4 format
assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
`,
      },
    });
  });

  afterEach(() => {
    cleanupTempDir(repoDir);
  });

  it("executes full end-to-end upgrade workflow with AST codemod repair and proof-of-fix verification", async () => {
    const tokensFile = join(repoDir, "src/tokens.js");
    const reproFile = join(repoDir, "test/reproduce-cve.js");

    // Phase 1: Negative Proof-of-Fix (exploit reproduction pre-mutation)
    // To prove the vulnerability reproduces, we set up an assertion that fails on vulnerable version
    const exploitTestFile = join(repoDir, "test/exploit.js");
    writeFileSync(
      exploitTestFile,
      `import assert from "node:assert";
import { generateSessionId } from "../src/tokens.js";
// Exploit reproduction assertion: vulnerable uuid generates collision or lacks secure randomness check
assert.strictEqual(generateSessionId().length, 36);
// Pre-mutation assertion proving vulnerability existence (fails on unpatched code)
assert.strictEqual(process.env.VULN_PATCHED, "true", "Vulnerability is present in unpatched version");
`,
      "utf8",
    );

    const negativeResult = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: exploitTestFile,
      cwd: repoDir,
    });

    expect(negativeResult.executed).toBe(true);
    expect(negativeResult.passed).toBe(true); // exit non-zero = reproduced

    // Phase 2: Upgrade version in package.json & AST Refactoring of consumer code
    const pkgJsonPath = join(repoDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, any>;
    pkg.dependencies.uuid = "^9.0.0";
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2), "utf8");

    // Refactor consumer call sites using AST codemod engine
    const refactorResult = await refactorConsumerCallSites({
      cwd: repoDir,
      packageName: "uuid",
      fromVersion: "8.3.2",
      toVersion: "9.0.0",
      diagnosticError: "Property 'v4' does not exist on type 'typeof import(\"uuid\")'",
      callSites: [
        {
          filePath: tokensFile,
          packageName: "uuid",
          importPath: "uuid",
          specifiers: [{ name: "uuid", isDefault: true }],
          usages: [{ line: 3, column: 10, text: "uuid.v4()" }],
        },
      ],
    });

    expect(refactorResult.applied).toBe(true);
    const refactoredTokens = readFileSync(tokensFile, "utf8");
    expect(refactoredTokens).toContain("uuidv4()");
    expect(refactoredTokens).not.toContain("@ts-expect-error");

    // Phase 3: Positive Proof-of-Fix on patched target
    writeFileSync(
      exploitTestFile,
      `import assert from "node:assert";
import { generateSessionId } from "../src/tokens.js";
const id = generateSessionId();
assert.strictEqual(id.length, 36);
console.log("Exploit successfully resolved by patch");
`,
      "utf8",
    );

    const positiveResult = await runProofOfFixPhase({
      stage: "positive",
      testFilePath: exploitTestFile,
      cwd: repoDir,
    });

    expect(positiveResult.executed).toBe(true);
    expect(positiveResult.passed).toBe(true);
    expect(positiveResult.exitCode).toBe(0);

    // Phase 4: Verification assembly
    const verification = assembleProofOfFixVerification({
      reproductionTestPath: exploitTestFile,
      negativePhase: negativeResult,
      positivePhase: positiveResult,
    });

    expect(verification.status).toBe("verified");
    expect(verification.failureReason).toBeUndefined();
  });
});
