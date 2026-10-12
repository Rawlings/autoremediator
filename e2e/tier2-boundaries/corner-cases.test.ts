import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, loadPolicy } from "../../packages/core/src/platform/policy.js";
import { withAtomicRollback } from "../../packages/core/src/platform/rollback.js";
import { runProofOfFixPhase } from "../../packages/core/src/remediation/proof-of-fix/runner.js";
import { parseCompilerDiagnostics } from "../../packages/core/src/remediation/refactor/refactor-agent.js";
import { fetchPackageSourceTool } from "../../packages/core/src/remediation/tools/fetch-package-source.js";
import { validatePatchedCodeSyntax } from "../../packages/core/src/remediation/tools/generate-patch/helpers.js";
import { cleanupTempDir, createTempDir, createTempRepo, writeRepoFile } from "../fixtures/temp-repo.js";

describe("Tier 2 - Corner Cases", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("corner-test-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("Corner 1: non-existent reproduction test file is correctly identified as harness error", async () => {
    const missingFile = join(tempDir, "does-not-exist.js");

    const result = await runProofOfFixPhase({
      stage: "negative",
      testFilePath: missingFile,
      cwd: tempDir,
    });

    expect(result.executed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("harness error");
  });

  it("Corner 2: syntax errors and invalid code are rejected by patch syntax validator", () => {
    // Malformed JS syntax
    const badJs = validatePatchedCodeSyntax("foo.js", "function ( { return;");
    expect(badJs.valid).toBe(false);
    expect(badJs.error).toBeDefined();

    // Malformed JSON syntax
    const badJson = validatePatchedCodeSyntax("data.json", "{ 'unquotedKey': 123, }");
    expect(badJson.valid).toBe(false);
    expect(badJson.error).toContain("JSON parse error");

    // Malformed YAML syntax
    const badYaml = validatePatchedCodeSyntax("config.yaml", "key: : invalid:\n\t tab-character");
    expect(badYaml.valid).toBe(false);
  });

  it("Corner 3: package fetcher rejects non-existent or invalid package names cleanly", async () => {
    const result = await fetchPackageSourceTool.execute({
      packageName: "this-package-definitely-does-not-exist-xyz1234567890",
      version: "99.99.99",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("Corner 4: containment rollback cleans up newly introduced untracked files", async () => {
    const repoDir = await createTempRepo({ initGit: true });
    const untrackedFile = join(repoDir, "new-temporary-mutation.ts");

    try {
      await withAtomicRollback(
        repoDir,
        async () => {
          // Action creates an untracked file
          writeFileSync(untrackedFile, "console.log('temporary');\n", "utf8");
          expect(existsSync(untrackedFile)).toBe(true);
          return { rollbackNeeded: true };
        },
        {
          shouldRollback: (res) => res.rollbackNeeded,
        },
      );

      // Rollback should remove the newly created file in git repository
      expect(existsSync(untrackedFile)).toBe(false);
    } finally {
      cleanupTempDir(repoDir);
    }
  });

  it("Corner 5: corrupted policy YAML recovers gracefully to default policy without crashing", () => {
    const corruptYaml = join(tempDir, "corrupt.yml");
    writeFileSync(corruptYaml, "!@#$%^&*() invalid yaml : : : content\n", "utf8");

    const policy = loadPolicy(tempDir, corruptYaml);
    expect(policy).toBeDefined();
    expect(policy.denyPackages).toEqual(DEFAULT_POLICY.denyPackages);
    expect(policy.allowMajorBumps).toBe(DEFAULT_POLICY.allowMajorBumps);
  });

  it("Corner 6: diagnostic parser extracts symbols from various compiler error message shapes", () => {
    const diag1 = `src/index.ts:15:5 - error TS2339: Property 'oldMethod' does not exist on type 'Service'. Did you mean 'newMethod'?`;
    const parsed1 = parseCompilerDiagnostics(diag1);
    expect(parsed1.length).toBe(1);
    expect(parsed1[0]?.missingMember).toBe("oldMethod");
    expect(parsed1[0]?.suggestedSymbol).toBe("newMethod");

    const diag2 = `lib/app.ts(42,10): error TS2614: Module '"lib"' has no exported member 'helper'.`;
    const parsed2 = parseCompilerDiagnostics(diag2);
    expect(parsed2.length).toBe(1);
    expect(parsed2[0]?.missingMember).toBe("helper");
  });
});
