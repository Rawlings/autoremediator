import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkInventoryTool, resolveInventoryVersion } from "./check-inventory.js";
import { resolveDenoInventory } from "../../platform/package-manager/list-parser.js";
import {
  generateUnifiedDiff,
  validatePatchedCodeSyntax,
  buildGeneratedPatches,
} from "./generate-patch/helpers.js";
import { applyPatchFileTool } from "./apply-patch-file/index.js";
import { applyVersionBumpTool } from "./apply-version-bump.js";

describe("Remediation Tools Adversarial White-Box Challenges", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "tools-challenge-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("check-inventory & semver inventory resolution", () => {
    it("adversarially parses exotic and complex version range specs", () => {
      expect(resolveInventoryVersion("1.2.3")).toBe("1.2.3");
      expect(resolveInventoryVersion("  v1.2.3  ")).toBe("1.2.3");
      expect(resolveInventoryVersion("^1.2.3")).toBe("1.2.3");
      expect(resolveInventoryVersion("~2.0.1")).toBe("2.0.1");
      expect(resolveInventoryVersion(">=1.5.0 <2.0.0")).toBe("1.5.0");
      expect(resolveInventoryVersion("1.x")).toBe("1.0.0");
      expect(resolveInventoryVersion("npm:lodash@^4.17.21")).toBe("4.17.21");
      expect(resolveInventoryVersion("workspace:^3.1.0")).toBe("3.1.0");
      expect(resolveInventoryVersion("workspace:2.0.0")).toBe("2.0.0");
      expect(resolveInventoryVersion("catalog:")).toBe("catalog:");
      expect(resolveInventoryVersion("invalid-unparseable-spec")).toBe("invalid-unparseable-spec");
    });

    it("parses Deno lockfile v3 and v4 formats including scoped npm packages", async () => {
      const v3Lock = {
        version: "3",
        packages: {
          npm: {
            "express@4.18.2": { integrity: "sha512-..." },
            "@types/node@20.11.0": { integrity: "sha512-..." },
          },
        },
      };
      await writeFile(join(testDir, "deno.lock"), JSON.stringify(v3Lock, null, 2), "utf8");

      const v3Inventory = resolveDenoInventory(testDir);
      expect(v3Inventory.get("express")).toBe("4.18.2");
      expect(v3Inventory.get("@types/node")).toBe("20.11.0");

      const v4Lock = {
        version: "4",
        packages: {
          "npm:chalk@5.3.0": {},
          "npm:@fastify/cors@9.0.1": {},
        },
      };
      await writeFile(join(testDir, "deno.lock"), JSON.stringify(v4Lock, null, 2), "utf8");

      const v4Inventory = resolveDenoInventory(testDir);
      expect(v4Inventory.get("chalk")).toBe("5.3.0");
      expect(v4Inventory.get("@fastify/cors")).toBe("9.0.1");
    });

    it("handles missing package.json gracefully without throwing", async () => {
      const result = await checkInventoryTool.execute({
        cwd: testDir,
      });

      expect(result.packages).toEqual([]);
      expect(result.error).toContain("Could not read package.json");
    });

    it("falls back to package.json dependencies when no lockfile or package manager list works", async () => {
      const pkgJson = {
        dependencies: {
          lodash: "^4.17.21",
          "@scope/util": "~1.0.4",
        },
        devDependencies: {
          typescript: "5.3.3",
        },
        peerDependencies: {
          react: ">=18.0.0",
        },
      };
      await writeFile(join(testDir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

      const result = await checkInventoryTool.execute({
        cwd: testDir,
      });

      expect(result.error).toBeUndefined();
      const pkgMap = new Map(result.packages.map((p) => [p.name, p]));
      expect(pkgMap.get("lodash")?.version).toBe("4.17.21");
      expect(pkgMap.get("@scope/util")?.version).toBe("1.0.4");
      expect(pkgMap.get("typescript")?.version).toBe("5.3.3");
      expect(pkgMap.get("react")?.version).toBe("18.0.0");
      expect(pkgMap.get("lodash")?.type).toBe("direct");
    });
  });

  describe("generate-patch LCS Myers diff & syntax validation", () => {
    it("returns null when original and fixed contents are identical", () => {
      const content = "function foo() {\n  return 42;\n}\n";
      expect(generateUnifiedDiff(content, content, "src/foo.js")).toBeNull();
    });

    it("generates correct unified diff format for single-line modification", () => {
      const orig = "function foo() {\n  return 41;\n}\n";
      const fixed = "function foo() {\n  return 42;\n}\n";
      const diff = generateUnifiedDiff(orig, fixed, "src/foo.js");

      expect(diff).not.toBeNull();
      expect(diff).toContain("--- a/src/foo.js");
      expect(diff).toContain("+++ b/src/foo.js");
      expect(diff).toContain("-  return 41;");
      expect(diff).toContain("+  return 42;");
      expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    });

    it("generates separate hunks for distant changes (> 2 * context lines apart)", () => {
      const linesOrig: string[] = [];
      const linesFixed: string[] = [];

      linesOrig.push("change_top_orig");
      linesFixed.push("change_top_fixed");

      for (let i = 0; i < 20; i++) {
        linesOrig.push(`unchanged_line_${i}`);
        linesFixed.push(`unchanged_line_${i}`);
      }

      linesOrig.push("change_bottom_orig");
      linesFixed.push("change_bottom_fixed");

      const orig = linesOrig.join("\n") + "\n";
      const fixed = linesFixed.join("\n") + "\n";

      const diff = generateUnifiedDiff(orig, fixed, "src/multi.js", 3);
      expect(diff).not.toBeNull();
      const hunkHeaders = diff!.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g);
      expect(hunkHeaders).not.toBeNull();
      expect(hunkHeaders!.length).toBeGreaterThanOrEqual(2);
      expect(diff).toContain("-change_top_orig");
      expect(diff).toContain("+change_top_fixed");
      expect(diff).toContain("-change_bottom_orig");
      expect(diff).toContain("+change_bottom_fixed");
    });

    it("generates valid diff for pure insertion (empty to non-empty)", () => {
      const orig = "";
      const fixed = "console.log('hello');\nconsole.log('world');\n";
      const diff = generateUnifiedDiff(orig, fixed, "src/new.js");

      expect(diff).not.toBeNull();
      expect(diff).toContain("--- a/src/new.js");
      expect(diff).toContain("+++ b/src/new.js");
      expect(diff).toContain("+console.log('hello');");
      expect(diff).toContain("+console.log('world');");
    });

    it("generates valid diff for pure deletion (non-empty to empty)", () => {
      const orig = "console.log('deprecated');\n";
      const fixed = "";
      const diff = generateUnifiedDiff(orig, fixed, "src/old.js");

      expect(diff).not.toBeNull();
      expect(diff).toContain("-console.log('deprecated');");
    });

    it("handles Windows CRLF line endings cleanly", () => {
      const orig = "line1\r\nline2_orig\r\nline3\r\n";
      const fixed = "line1\r\nline2_fixed\r\nline3\r\n";
      const diff = generateUnifiedDiff(orig, fixed, "src/win.js");

      expect(diff).not.toBeNull();
      expect(diff).toContain("-line2_orig");
      expect(diff).toContain("+line2_fixed");
    });

    it("validates syntax across JS, TS, JSON, and YAML and rejects malformed code", () => {
      expect(validatePatchedCodeSyntax("file.js", "const x = 1;").valid).toBe(true);
      expect(validatePatchedCodeSyntax("file.ts", "const x: number = 1;").valid).toBe(true);
      expect(validatePatchedCodeSyntax("file.jsx", "const x = <div>hello</div>;").valid).toBe(true);
      expect(
        validatePatchedCodeSyntax("file.tsx", "const x: JSX.Element = <div>hello</div>;").valid,
      ).toBe(true);

      const invalidJs = validatePatchedCodeSyntax("file.js", "const x = { unclosed;");
      expect(invalidJs.valid).toBe(false);
      expect(invalidJs.error).toContain("Syntax error in generated patch");

      expect(validatePatchedCodeSyntax("config.json", '{"key": "value"}').valid).toBe(true);
      const invalidJson = validatePatchedCodeSyntax("config.json", "{ key: 'bad json' }");
      expect(invalidJson.valid).toBe(false);
      expect(invalidJson.error).toContain("JSON parse error");

      expect(validatePatchedCodeSyntax("config.yml", "key: value\nlist:\n  - 1").valid).toBe(true);
      const invalidYaml = validatePatchedCodeSyntax("config.yml", "key: [unclosed");
      expect(invalidYaml.valid).toBe(false);
      expect(invalidYaml.error).toContain("YAML parse error");
    });

    it("buildGeneratedPatches filters out syntactically invalid patches", () => {
      const sourceFiles = {
        "good.ts": "export const a = 1;\n",
        "bad.ts": "export const b = 2;\n",
      };
      const fixedCode = {
        "good.ts": "export const a = 42;\n",
        "bad.ts": "export const b = { syntax error!;\n",
      };

      const patches = buildGeneratedPatches(sourceFiles, fixedCode);
      expect(patches.length).toBe(1);
      expect(patches[0]?.filePath).toBe("good.ts");
      expect(patches[0]?.unifiedDiff).toContain("+export const a = 42;");
    });
  });

  describe("apply-patch-file adversarial validations & rollback", () => {
    it("rejects non-unified diff patch content with diff-format validation error", async () => {
      const result = await applyPatchFileTool.execute({
        cwd: testDir,
        packageName: "demo-pkg",
        vulnerableVersion: "1.0.0",
        patchContent: "This is completely invalid diff text without headers",
      });

      expect(result.success).toBe(false);
      expect(result.applied).toBe(false);
      expect(result.validationPhases?.[0]?.phase).toBe("diff-format");
      expect(result.validationPhases?.[0]?.passed).toBe(false);
    });

    it("blocks patch application when package is denied by policy", async () => {
      const policyContent = `
denyPackages:
  - "blocked-*"
  - "malicious-pkg"
`;
      await mkdir(join(testDir, ".github"), { recursive: true });
      await writeFile(join(testDir, ".github", "autoremediator.yml"), policyContent, "utf8");

      const diff = generateUnifiedDiff("const x = 1;\n", "const x = 2;\n", "index.js")!;
      const result = await applyPatchFileTool.execute({
        cwd: testDir,
        packageName: "blocked-lib",
        vulnerableVersion: "1.0.0",
        patchContent: diff,
      });

      expect(result.success).toBe(false);
      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");
      expect(result.message).toContain("denyPackages blocked");
    });

    it("dry-run reports intended patch file without writing to disk when patchesDir is provided", async () => {
      const diff = generateUnifiedDiff("const x = 1;\n", "const x = 2;\n", "index.js")!;
      const result = await applyPatchFileTool.execute({
        cwd: testDir,
        packageName: "sample-pkg",
        vulnerableVersion: "1.0.0",
        patchContent: diff,
        patchesDir: "./patches",
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.dryRun).toBe(true);
      expect(result.patchArtifact?.patchFileName).toBe("sample-pkg+1.0.0.patch");
      expect(result.patchArtifact?.integrity).toMatch(/^sha256:/);
    });

    it("reveals defect: omitting patchesDir causes path.join TypeError because zod default is not destructured in execute", async () => {
      const diff = generateUnifiedDiff("const x = 1;\n", "const x = 2;\n", "index.js")!;
      const result = await applyPatchFileTool.execute({
        cwd: testDir,
        packageName: "sample-pkg",
        vulnerableVersion: "1.0.0",
        patchContent: diff,
        // patchesDir omitted
        dryRun: true,
      });

      // Empirically documents the defect:
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'The "path" argument must be of type string. Received undefined',
      );
    });
  });

  describe("apply-version-bump edge cases & safety controls", () => {
    it("handles corrupt package.json gracefully without crashing", async () => {
      await writeFile(join(testDir, "package.json"), "NOT VALID JSON {{{{", "utf8");

      const result = await applyVersionBumpTool.execute({
        cwd: testDir,
        packageName: "lodash",
        fromVersion: "4.17.20",
        toVersion: "4.17.21",
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("package-json-not-found");
      expect(result.message).toContain("Could not read package.json");
    });

    it("blocks major bump when policy forbids it", async () => {
      const pkgJson = {
        dependencies: {
          semver: "^6.3.0",
        },
      };
      await writeFile(join(testDir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

      const result = await applyVersionBumpTool.execute({
        cwd: testDir,
        packageName: "semver",
        fromVersion: "6.3.0",
        toVersion: "7.5.4",
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("major-bump-required");
      expect(result.message).toContain("Policy blocked major bump");
    });

    it("identifies transitive dependencies not present in package.json", async () => {
      const pkgJson = {
        dependencies: {
          express: "^4.18.2",
        },
      };
      await writeFile(join(testDir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

      const result = await applyVersionBumpTool.execute({
        cwd: testDir,
        packageName: "body-parser",
        fromVersion: "1.19.0",
        toVersion: "1.20.0",
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("transitive-dependency");
      expect(result.message).toContain("transitive dependency");
    });

    it("supports peerDependencies updating cleanly in dry-run mode", async () => {
      const pkgJson = {
        peerDependencies: {
          react: "^17.0.0",
        },
      };
      await writeFile(join(testDir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

      const result = await applyVersionBumpTool.execute({
        cwd: testDir,
        packageName: "react",
        fromVersion: "17.0.0",
        toVersion: "17.0.2",
        dryRun: true,
      });

      expect(result.applied).toBe(false);
      expect(result.dryRun).toBe(true);
      expect(result.message).toContain("peerDependencies.react");
      expect(result.message).toContain('"^17.0.0" -> "^17.0.2"');
    });

    it("blocks version bump when package matches denyPackages in policy", async () => {
      const policyContent = `
denyPackages:
  - "untrusted-*"
`;
      await mkdir(join(testDir, ".github"), { recursive: true });
      await writeFile(join(testDir, ".github", "autoremediator.yml"), policyContent, "utf8");

      const pkgJson = {
        dependencies: {
          "untrusted-lib": "^1.0.0",
        },
      };
      await writeFile(join(testDir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

      const result = await applyVersionBumpTool.execute({
        cwd: testDir,
        packageName: "untrusted-lib",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
      });

      expect(result.applied).toBe(false);
      expect(result.unresolvedReason).toBe("policy-blocked");
      expect(result.message).toContain("Policy blocked changes for package");
    });
  });
});
