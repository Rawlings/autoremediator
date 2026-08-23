import { parseSync } from "oxc-parser";
import YAML from "yaml";

/**
 * Represents a single generated patch file.
 */
export interface GeneratedPatch {
  filePath: string;
  unifiedDiff: string;
}

/**
 * LLM analysis response schema.
 */
export interface LlmAnalysis {
  analysis: string;
  fixedCode: Record<string, string>;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
}

export function parseLlmAnalysisResponse(
  text: string,
): { ok: true; analysis: LlmAnalysis } | { ok: false; error: string } {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { ok: false, error: "No JSON found in LLM response" };
    }
    return { ok: true, analysis: JSON.parse(jsonMatch[0]) as LlmAnalysis };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: message };
  }
}

export function isValidLlmAnalysis(analysis: LlmAnalysis): boolean {
  return Boolean(
    analysis.analysis &&
    analysis.fixedCode &&
    typeof analysis.confidence === "number" &&
    ["low", "medium", "high"].includes(analysis.riskLevel),
  );
}

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
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: `AST validation failed for ${filePath}: ${msg}` };
    }
  }

  // 2. JSON Validation
  if (lowerPath.endsWith(".json")) {
    try {
      JSON.parse(code);
      return { valid: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: `JSON parse error in generated patch for ${filePath}: ${msg}` };
    }
  }

  // 3. YAML Validation
  if (lowerPath.endsWith(".yml") || lowerPath.endsWith(".yaml")) {
    try {
      YAML.parse(code);
      return { valid: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: `YAML parse error in generated patch for ${filePath}: ${msg}` };
    }
  }

  return { valid: true };
}

export function buildGeneratedPatches(
  sourceFiles: Record<string, string>,
  fixedCodeByFile: Record<string, string>,
): GeneratedPatch[] {
  const patches: GeneratedPatch[] = [];

  for (const [filePath, fixedCode] of Object.entries(fixedCodeByFile)) {
    const sourceFile = sourceFiles[filePath];
    if (!sourceFile) {
      continue;
    }

    const syntaxCheck = validatePatchedCodeSyntax(filePath, fixedCode);
    if (!syntaxCheck.valid) {
      continue;
    }

    const unifiedDiff = generateUnifiedDiff(sourceFile, fixedCode, filePath);
    if (unifiedDiff) {
      patches.push({ filePath, unifiedDiff });
    }
  }

  return patches;
}

/**
 * Generate a unified diff between two strings.
 * Returns a unified diff format or null if there are no differences.
 */
export function generateUnifiedDiff(
  original: string,
  fixed: string,
  filePath: string,
): string | null {
  if (original === fixed) {
    return null;
  }

  const originalLines = original.split("\n");
  const fixedLines = fixed.split("\n");

  const diff: string[] = [];
  diff.push(`--- a/${filePath}`);
  diff.push(`+++ b/${filePath}`);
  diff.push(`@@ -1,${originalLines.length} +1,${fixedLines.length} @@`);

  const maxLen = Math.max(originalLines.length, fixedLines.length);

  for (let i = 0; i < maxLen; i++) {
    const origLine = originalLines[i] || "";
    const fixedLine = fixedLines[i] || "";

    if (origLine !== fixedLine) {
      if (origLine) {
        diff.push(`-${origLine}`);
      }
      if (fixedLine) {
        diff.push(`+${fixedLine}`);
      }
    } else if (origLine) {
      diff.push(` ${origLine}`);
    }
  }

  return diff.join("\n");
}
