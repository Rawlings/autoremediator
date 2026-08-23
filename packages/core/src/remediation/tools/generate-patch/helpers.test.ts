import { describe, expect, it } from "vitest";
import { generateUnifiedDiff, validatePatchedCodeSyntax } from "./helpers.js";

describe("generate-patch helpers - syntax pre-validation", () => {
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

  it("generates unified diff accurately", () => {
    const original = "const a = 1;\nconst b = 2;\n";
    const fixed = "const a = 1;\nconst b = 3;\n";

    const diff = generateUnifiedDiff(original, fixed, "src/index.js");
    expect(diff).toContain("--- a/src/index.js");
    expect(diff).toContain("+++ b/src/index.js");
    expect(diff).toContain("-const b = 2;");
    expect(diff).toContain("+const b = 3;");
  });
});
