import { describe, expect, it } from "vitest";
import { parseCheckRunLogs, stripAnsi } from "./log-parser.js";

describe("CI check run log parser", () => {
  it("strips ANSI color escapes", () => {
    const colored = "\x1b[31mError:\x1b[0m Failed to compile";
    expect(stripAnsi(colored)).toBe("Error: Failed to compile");
  });

  it("extracts TypeScript compiler errors", () => {
    const raw = `
src/index.ts:15:3 - error TS2305: Module '"chalk"' has no exported member 'default'.
15 import chalk from "chalk";
          ~~~~~
Found 1 error in src/index.ts:15
    `;

    const parsed = parseCheckRunLogs(raw);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.category).toBe("typescript");
    expect(parsed.findings[0]?.ruleId).toBe("TS2305");
    expect(parsed.findings[0]?.filePath).toBe("src/index.ts");
    expect(parsed.findings[0]?.line).toBe(15);
    expect(parsed.findings[0]?.column).toBe(3);
    expect(parsed.findings[0]?.message).toContain("has no exported member 'default'");
  });

  it("extracts Linter errors", () => {
    const raw = `
src/app.ts:4:10: @typescript-eslint/no-unused-vars: 'unused' is defined but never used.
    `;

    const parsed = parseCheckRunLogs(raw);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.category).toBe("lint");
    expect(parsed.findings[0]?.ruleId).toBe("@typescript-eslint/no-unused-vars");
    expect(parsed.findings[0]?.filePath).toBe("src/app.ts");
    expect(parsed.findings[0]?.line).toBe(4);
  });

  it("extracts test runner failure lines", () => {
    const raw = `
FAIL src/math.test.ts > add > adds numbers correctly
AssertionError: expected 4 to equal 5
    `;

    const parsed = parseCheckRunLogs(raw);
    expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
    expect(parsed.findings.some((f) => f.category === "test")).toBe(true);
  });
});
