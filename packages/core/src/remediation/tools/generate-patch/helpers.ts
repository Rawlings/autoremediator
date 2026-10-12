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
  reproductionTest?: string;
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

interface DiffEdit {
  type: "common" | "insert" | "delete";
  text: string;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function myersDiff(aLines: string[], bLines: string[]): DiffEdit[] {
  const N = aLines.length;
  const M = bLines.length;
  const max = N + M;
  if (max === 0) return [];

  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const history: Int32Array[] = [];

  v[offset + 1] = 0;

  let dFound = -1;
  for (let d = 0; d <= max; d++) {
    const vCopy = new Int32Array(v);
    history.push(vCopy);

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;

      while (x < N && y < M && aLines[x] === bLines[y]) {
        x++;
        y++;
      }

      v[offset + k] = x;

      if (x >= N && y >= M) {
        dFound = d;
        break;
      }
    }
    if (dFound !== -1) break;
  }

  let x = N;
  let y = M;
  const edits: DiffEdit[] = [];

  for (let d = dFound; d > 0; d--) {
    const k = x - y;
    const vPrev = history[d]!;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[offset + k - 1]! < vPrev[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = vPrev[offset + prevK]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      edits.push({ type: "common", text: aLines[x - 1]! });
      x--;
      y--;
    }

    if (x === prevX) {
      edits.push({ type: "insert", text: bLines[y - 1]! });
      y--;
    } else {
      edits.push({ type: "delete", text: aLines[x - 1]! });
      x--;
    }
  }

  while (x > 0 && y > 0) {
    edits.push({ type: "common", text: aLines[x - 1]! });
    x--;
    y--;
  }

  edits.reverse();
  return edits;
}

/**
 * Generate a standard Myers unified diff between two strings.
 * Returns unified diff format or null if there are no differences.
 */
export function generateUnifiedDiff(
  original: string,
  fixed: string,
  filePath: string,
  context: number = 3,
): string | null {
  if (original === fixed) {
    return null;
  }

  const aLines = splitLines(original);
  const bLines = splitLines(fixed);

  // Fast-path: trim common prefix and suffix for performance
  let prefixCount = 0;
  while (
    prefixCount < aLines.length &&
    prefixCount < bLines.length &&
    aLines[prefixCount] === bLines[prefixCount]
  ) {
    prefixCount++;
  }

  let suffixCount = 0;
  while (
    suffixCount < aLines.length - prefixCount &&
    suffixCount < bLines.length - prefixCount &&
    aLines[aLines.length - 1 - suffixCount] === bLines[bLines.length - 1 - suffixCount]
  ) {
    suffixCount++;
  }

  const prefixEdits: DiffEdit[] = [];
  for (let i = 0; i < prefixCount; i++) {
    prefixEdits.push({ type: "common", text: aLines[i]! });
  }

  const suffixEdits: DiffEdit[] = [];
  for (let i = aLines.length - suffixCount; i < aLines.length; i++) {
    suffixEdits.push({ type: "common", text: aLines[i]! });
  }

  const aMiddle = aLines.slice(prefixCount, aLines.length - suffixCount);
  const bMiddle = bLines.slice(prefixCount, bLines.length - suffixCount);

  const middleEdits = myersDiff(aMiddle, bMiddle);
  const edits = [...prefixEdits, ...middleEdits, ...suffixEdits];

  // Find edit indices
  const changeIndices: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i]!.type !== "common") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) {
    return null;
  }

  // Group into hunks separated by > 2 * context unchanged lines
  const groups: number[][] = [];
  let currentGroup: number[] = [changeIndices[0]!];

  for (let i = 1; i < changeIndices.length; i++) {
    const prev = changeIndices[i - 1]!;
    const curr = changeIndices[i]!;
    if (curr - prev - 1 <= 2 * context) {
      currentGroup.push(curr);
    } else {
      groups.push(currentGroup);
      currentGroup = [curr];
    }
  }
  groups.push(currentGroup);

  const hunkStrings: string[] = [];

  for (const group of groups) {
    const firstChange = group[0]!;
    const lastChange = group[group.length - 1]!;

    const startIndex = Math.max(0, firstChange - context);
    const endIndex = Math.min(edits.length, lastChange + context + 1);
    const hunkEdits = edits.slice(startIndex, endIndex);

    // Track original and fixed 1-based start line
    let curOrig = 1;
    let curFixed = 1;
    for (let i = 0; i < startIndex; i++) {
      if (edits[i]!.type === "common") {
        curOrig++;
        curFixed++;
      } else if (edits[i]!.type === "delete") {
        curOrig++;
      } else if (edits[i]!.type === "insert") {
        curFixed++;
      }
    }

    let origStart = curOrig;
    let fixedStart = curFixed;
    let origCount = 0;
    let fixedCount = 0;

    for (const edit of hunkEdits) {
      if (edit.type === "common") {
        origCount++;
        fixedCount++;
      } else if (edit.type === "delete") {
        origCount++;
      } else if (edit.type === "insert") {
        fixedCount++;
      }
    }

    if (origCount === 0) origStart = Math.max(0, origStart - 1);
    if (fixedCount === 0) fixedStart = Math.max(0, fixedStart - 1);

    const lines: string[] = [];
    lines.push(`@@ -${origStart},${origCount} +${fixedStart},${fixedCount} @@`);

    for (const edit of hunkEdits) {
      if (edit.type === "common") {
        lines.push(` ${edit.text}`);
      } else if (edit.type === "delete") {
        lines.push(`-${edit.text}`);
      } else if (edit.type === "insert") {
        lines.push(`+${edit.text}`);
      }
    }

    hunkStrings.push(lines.join("\n"));
  }

  return [`--- a/${filePath}`, `+++ b/${filePath}`, ...hunkStrings].join("\n") + "\n";
}
