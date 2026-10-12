import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateUnifiedDiff, validatePatchedCodeSyntax } from "./helpers.js";

describe("generate-patch helpers - Myers unified diff and syntax validation", () => {
  it("validates valid and invalid JavaScript/TypeScript code", () => {
    const validJs = "function hello() { return 'world'; }";
    const invalidJs = "function hello( { return 'world';";

    expect(validatePatchedCodeSyntax("index.js", validJs).valid).toBe(true);
    expect(validatePatchedCodeSyntax("index.ts", invalidJs).valid).toBe(false);
  });

  it("validates valid and invalid JSON files", () => {
    const validJson = JSON.stringify({ name: "test", version: "1.0.0" });
    const invalidJson = "{ name: 'test', }";

    expect(validatePatchedCodeSyntax("package.json", validJson).valid).toBe(true);
    expect(validatePatchedCodeSyntax("config.json", invalidJson).valid).toBe(false);
  });

  it("validates valid and invalid YAML files", () => {
    const validYaml = "name: test\nversion: 1.0.0\nitems:\n  - a\n  - b\n";
    const invalidYaml = "name: test\n  version: [unclosed\n";

    expect(validatePatchedCodeSyntax("action.yml", validYaml).valid).toBe(true);
    expect(validatePatchedCodeSyntax("workflow.yaml", invalidYaml).valid).toBe(false);
  });

  it("returns null when original and fixed contents are identical", () => {
    const content = "const x = 42;\nconsole.log(x);\n";
    expect(generateUnifiedDiff(content, content, "src/same.js")).toBeNull();
  });

  it("generates accurate single-hunk diff with correct context lines", () => {
    const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const fixed = "const a = 1;\nconst b = 42;\nconst c = 3;\n";

    const diff = generateUnifiedDiff(original, fixed, "src/index.js");
    expect(diff).not.toBeNull();
    expect(diff).toContain("--- a/src/index.js");
    expect(diff).toContain("+++ b/src/index.js");
    expect(diff).toContain("@@ -1,3 +1,3 @@");
    expect(diff).toContain(" const a = 1;");
    expect(diff).toContain("-const b = 2;");
    expect(diff).toContain("+const b = 42;");
    expect(diff).toContain(" const c = 3;");
  });

  it("generates multi-hunk diff when edits are separated by unchanged lines", () => {
    const originalLines: string[] = [];
    const fixedLines: string[] = [];

    for (let i = 1; i <= 30; i++) {
      originalLines.push(`line ${i}`);
      if (i === 3) {
        fixedLines.push("line 3 MODIFIED");
      } else if (i === 26) {
        fixedLines.push("line 26 MODIFIED");
      } else {
        fixedLines.push(`line ${i}`);
      }
    }

    const original = originalLines.join("\n") + "\n";
    const fixed = fixedLines.join("\n") + "\n";

    const diff = generateUnifiedDiff(original, fixed, "lib/large.txt");
    expect(diff).not.toBeNull();

    // Must contain at least two separate @@ hunk headers
    const hunkMatches = diff!.match(/@@ -/g);
    expect(hunkMatches?.length).toBeGreaterThanOrEqual(2);
    expect(diff).toContain("-line 3");
    expect(diff).toContain("+line 3 MODIFIED");
    expect(diff).toContain("-line 26");
    expect(diff).toContain("+line 26 MODIFIED");
  });

  it("preserves empty lines as context and addition/deletion", () => {
    const original = "header\n\nmiddle\n\nfooter\n";
    const fixed = "header\n\nmiddle changed\n\nfooter\n";

    const diff = generateUnifiedDiff(original, fixed, "doc.txt");
    expect(diff).not.toBeNull();
    // Context empty line must be prefixed with space " "
    expect(diff).toContain(" \n");
    expect(diff).toContain("-middle");
    expect(diff).toContain("+middle changed");
  });

  it("produces diffs cleanly applicable by git apply in a real repository", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "autoremediator-git-apply-test-"));
    try {
      execSync("git init", { cwd: tempDir, stdio: "pipe" });

      const originalLines = Array.from(
        { length: 40 },
        (_, i) => `function fn${i}() { return ${i}; }`,
      );
      const fixedLines = Array.from({ length: 40 }, (_, i) => {
        if (i === 4) return "function fn4() { return 'fixed_4'; }";
        if (i === 35) return "function fn35() { return 'fixed_35'; }";
        return `function fn${i}() { return ${i}; }`;
      });

      const originalCode = originalLines.join("\n") + "\n";
      const fixedCode = fixedLines.join("\n") + "\n";
      const testFilePath = join(tempDir, "service.js");

      writeFileSync(testFilePath, originalCode, "utf8");
      execSync("git add service.js && git commit -m 'Initial commit'", {
        cwd: tempDir,
        stdio: "pipe",
      });

      const diff = generateUnifiedDiff(originalCode, fixedCode, "service.js");
      expect(diff).not.toBeNull();

      const patchFile = join(tempDir, "patch.patch");
      writeFileSync(patchFile, diff!, "utf8");

      // Verify git apply applies cleanly without errors or corruption
      execSync("git apply patch.patch", { cwd: tempDir, stdio: "pipe" });

      const appliedContent = readFileSync(testFilePath, "utf8");
      expect(appliedContent).toBe(fixedCode);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
