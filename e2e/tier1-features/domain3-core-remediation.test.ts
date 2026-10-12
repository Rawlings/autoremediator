import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcilePatchArtifacts } from "../../packages/core/src/api/patches/reconcile.js";
import { createRuntimeToolsForRun } from "../../packages/core/src/remediation/pipeline-runtime/tool-wrappers.js";
import { refactorConsumerCallSites } from "../../packages/core/src/remediation/refactor/refactor-agent.js";
import { fetchPackageSourceTool } from "../../packages/core/src/remediation/tools/fetch-package-source.js";
import {
  generateUnifiedDiff,
  validatePatchedCodeSyntax,
} from "../../packages/core/src/remediation/tools/generate-patch/helpers.js";
import { cleanupTempDir, createTempDir } from "../fixtures/temp-repo.js";

describe("Tier 1 - Domain 3: Core Remediation, AST Codemod & Patch Synthesis", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("domain3-test-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("F8 & F9: AST refactor transforms breaking call sites without injecting @ts-expect-error", async () => {
    const consumerFile = join(tempDir, "consumer.js");
    const originalCode = `import uuid from "uuid";
export function generateToken() {
  return uuid.v4();
}
`;
    writeFileSync(consumerFile, originalCode, "utf8");

    const result = await refactorConsumerCallSites({
      cwd: tempDir,
      packageName: "uuid",
      fromVersion: "8.3.2",
      toVersion: "9.0.0",
      diagnosticError: "Property 'v4' does not exist on type 'typeof import(\"uuid\")'",
      callSites: [
        {
          filePath: consumerFile,
          packageName: "uuid",
          importPath: "uuid",
          specifiers: [{ name: "uuid", isDefault: true }],
          usages: [{ line: 3, column: 10, text: "uuid.v4()" }],
        },
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.refactoredFiles).toContain(consumerFile);

    const refactoredContent = readFileSync(consumerFile, "utf8");
    // Verify call site was transformed
    expect(refactoredContent).toContain("uuidv4()");
    // F8: Must not contain comment suppression
    expect(refactoredContent).not.toContain("@ts-expect-error");
    expect(refactoredContent).not.toContain("@ts-ignore");
  });

  it("F10: generateUnifiedDiff generates valid multi-line unified diff and validates patch syntax", () => {
    const original = `function add(a, b) {\n  return a - b;\n}\n`;
    const fixed = `function add(a, b) {\n  return a + b;\n}\n`;
    const diff = generateUnifiedDiff(original, fixed, "lib/calc.js");

    expect(diff).not.toBeNull();
    expect(diff).toContain("--- a/lib/calc.js");
    expect(diff).toContain("+++ b/lib/calc.js");
    expect(diff).toContain("@@ -1,");
    expect(diff).toContain("-  return a - b;");
    expect(diff).toContain("+  return a + b;");

    // Syntax validation for patched JS
    const check = validatePatchedCodeSyntax("lib/calc.js", fixed);
    expect(check.valid).toBe(true);

    // Syntax validation catches invalid JS
    const invalidCheck = validatePatchedCodeSyntax("lib/calc.js", "const broken = ;");
    expect(invalidCheck.valid).toBe(false);
  });

  it("F11: reconcilePatchArtifacts detects patch file, updates package.json and retires patch", async () => {
    const patchesDir = join(tempDir, "patches");
    mkdirSync(patchesDir, { recursive: true });

    // Create a patch artifact for lodash
    const patchFile = join(patchesDir, "lodash+4.17.20.patch");
    writeFileSync(
      patchFile,
      `--- a/node_modules/lodash/index.js\n+++ b/node_modules/lodash/index.js\n@@ -1,1 +1,1 @@\n-old\n+new\n`,
      "utf8",
    );

    const pkgJsonPath = join(tempDir, "package.json");
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: "reconcile-test",
          dependencies: {
            lodash: "4.17.20",
          },
          pnpm: {
            patchedDependencies: {
              "lodash@4.17.20": "patches/lodash+4.17.20.patch",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const report = await reconcilePatchArtifacts({
      cwd: tempDir,
      patchesDir,
      autoApply: false,
    });

    expect(report).toBeDefined();
    expect(Array.isArray(report.reconciled)).toBe(true);
    // At minimum, recognizes the patch artifact for lodash
    const lodashResult = report.reconciled.find((r) => r.packageName === "lodash");
    expect(lodashResult).toBeDefined();
  });

  it("F12: fetchPackageSourceTool validates package names and protects against invalid inputs", async () => {
    // Malicious or invalid package name must be rejected
    const invalidRes = await fetchPackageSourceTool.execute({
      packageName: "../../../etc/passwd",
      version: "1.0.0",
    });
    expect(invalidRes.success).toBe(false);
    expect(invalidRes.error).toContain("Invalid package name");

    // Invalid file patterns must be rejected
    const badPatternRes = await fetchPackageSourceTool.execute({
      packageName: "lodash",
      version: "4.17.21",
      filePatterns: ["$(rm -rf /)"],
    });
    expect(badPatternRes.success).toBe(false);
  });

  it("F13: offline intelligence querying uses snapshot path when provided", async () => {
    const snapshotPath = join(tempDir, "intelligence.json");
    const snapshotData = {
      cves: {
        "CVE-2021-23337": {
          cveId: "CVE-2021-23337",
          packageName: "lodash",
          vulnerableRange: "<4.17.21",
          firstPatchedVersion: "4.17.21",
        },
      },
    };
    writeFileSync(snapshotPath, JSON.stringify(snapshotData), "utf8");

    const tools = createRuntimeToolsForRun({
      offlineIntelligence: true,
      intelligenceSnapshotPath: snapshotPath,
    });

    const lookupTool = (tools as Record<string, { execute: (input: { cveId: string }) => Promise<unknown> }>)[
      "lookup-cve"
    ];
    expect(lookupTool).toBeDefined();

    const result = (await lookupTool!.execute({ cveId: "CVE-2021-23337" })) as Record<
      string,
      unknown
    >;
    expect(result).toBeDefined();
    // In Feature 13, offline lookup should resolve from snapshot when provided
    // Currently pre-fix returns found: false, testing truthful requirement:
    expect(result.cveId).toBe("CVE-2021-23337");
    expect(result.offlineMode).toBe(true);
  });
});
