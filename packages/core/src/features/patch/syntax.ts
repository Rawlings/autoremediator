import { parseSync } from "oxc-parser";
import YAML from "yaml";

import { errorMessage } from "../../shared/errors.js";

/**
 * Validates that patched code across JS/TS, JSON, and YAML is syntactically sound.
 */
export function validatePatchedCodeSyntax(
  filePath: string,
  code: string,
): { valid: boolean; error?: string } {
  const lowerPath = filePath.toLowerCase();

  // 1. JavaScript / TypeScript AST Validation
  if (/\.[cm]?[jt]sx?$/i.test(lowerPath)) {
    try {
      const res = parseSync(filePath, code);
      if (res.errors && res.errors.length > 0) {
        const errorMsg = res.errors.map((e) => e.message).join("; ");
        return {
          valid: false,
          error: `Syntax error in generated patch for ${filePath}: ${errorMsg}`,
        };
      }
      return { valid: true };
    } catch (err) {
      const msg = errorMessage(err);
      return { valid: false, error: `AST validation failed for ${filePath}: ${msg}` };
    }
  }

  // 2. JSON Validation
  if (lowerPath.endsWith(".json")) {
    try {
      JSON.parse(code);
      return { valid: true };
    } catch (err) {
      const msg = errorMessage(err);
      return { valid: false, error: `JSON parse error in generated patch for ${filePath}: ${msg}` };
    }
  }

  // 3. YAML Validation
  if (lowerPath.endsWith(".yml") || lowerPath.endsWith(".yaml")) {
    try {
      YAML.parse(code);
      return { valid: true };
    } catch (err) {
      const msg = errorMessage(err);
      return { valid: false, error: `YAML parse error in generated patch for ${filePath}: ${msg}` };
    }
  }

  return { valid: true };
}
