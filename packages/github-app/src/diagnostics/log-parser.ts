/**
 * CI Diagnostic Log Parser
 *
 * Extracts structured diagnostics (TypeScript compiler errors, linter violations,
 * and test runner failures) from raw CI logs and check run annotations.
 */

export interface DiagnosticFinding {
  filePath?: string;
  line?: number;
  column?: number;
  ruleId?: string;
  message: string;
  category: "typescript" | "lint" | "test" | "general";
}

export interface ParsedDiagnostic {
  findings: DiagnosticFinding[];
  summary: string;
  rawSnippet: string;
}

const ESC = String.fromCharCode(27);
const ANSI_REGEX = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function parseCheckRunLogs(rawLogs: string): ParsedDiagnostic {
  const clean = stripAnsi(rawLogs);
  const findings: DiagnosticFinding[] = [];
  const lines = clean.split("\n");

  // Regex patterns
  // TypeScript: src/app.ts(12,5): error TS2305: ... OR src/app.ts:12:5 - error TS2305: ...
  const tsRegex =
    /([a-zA-Z0-9_\-./\\]+\.(?:ts|tsx|js|jsx))[:(](\d+)[:,](\d+)\)?:?(?:\s*-\s*error|\s+error)\s+(TS\d+):\s*(.+)/;

  // Linter (oxlint / eslint): src/app.ts:12:5: @typescript-eslint/no-unused-vars: ...
  const lintRegex =
    /([a-zA-Z0-9_\-./\\]+\.(?:ts|tsx|js|jsx|json))[:(](\d+)[:,](\d+)\)?:?(?:\s*-\s*error|\s+error)?\s+([a-zA-Z0-9_\-/@]+):\s*(.+)/;

  // Test Failure: FAIL src/app.test.ts or AssertionError: ...
  const testFailRegex = /(?:FAIL|AssertionError:|Expected:|Received:)\s*(.+)/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const tsMatch = trimmed.match(tsRegex);
    if (tsMatch) {
      findings.push({
        filePath: tsMatch[1],
        line: parseInt(tsMatch[2]!, 10),
        column: parseInt(tsMatch[3]!, 10),
        ruleId: tsMatch[4],
        message: tsMatch[5]!.trim(),
        category: "typescript",
      });
      continue;
    }

    const lintMatch = trimmed.match(lintRegex);
    if (lintMatch && !trimmed.includes("TS")) {
      findings.push({
        filePath: lintMatch[1],
        line: parseInt(lintMatch[2]!, 10),
        column: parseInt(lintMatch[3]!, 10),
        ruleId: lintMatch[4],
        message: lintMatch[5]!.trim(),
        category: "lint",
      });
      continue;
    }

    const testMatch = trimmed.match(testFailRegex);
    if (testMatch) {
      findings.push({
        message: trimmed,
        category: "test",
      });
    }
  }

  const summary =
    findings.length > 0
      ? `Found ${findings.length} diagnostic failure(s) (${findings.map((f) => f.ruleId || f.category).join(", ")})`
      : "Unstructured CI check failure detected.";

  // Keep max 20 lines of snippet to preserve token budget
  const rawSnippet = lines.slice(0, 25).join("\n");

  return {
    findings,
    summary,
    rawSnippet,
  };
}
