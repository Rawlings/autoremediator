import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Relative imports in `file` that resolve into one of the named top-level source directories. */
function importsOf(file: string, directories: string[]): string[] {
  const forbidden = new RegExp(`from "(?:\\.\\./)+(?:${directories.join("|")})/`, "g");
  return [...readFileSync(file, "utf8").matchAll(forbidden)].map(() => relative(SRC, file));
}

function violations(layer: string, directories: string[]): string[] {
  return sourceFiles(join(SRC, layer)).flatMap((file) => importsOf(file, directories));
}

describe("module boundaries (see docs/contributing/architecture.md)", () => {
  it("platform is a leaf: it imports from no other layer", () => {
    expect(
      violations("platform", [
        "remediation",
        "api",
        "cli",
        "mcp",
        "openapi",
        "intelligence",
        "scanner",
      ]),
    ).toEqual([]);
  });

  it("CLI, MCP and HTTP surfaces go through api/, never into remediation or intelligence", () => {
    expect([
      ...violations("cli", ["remediation", "intelligence"]),
      ...violations("mcp", ["remediation", "intelligence"]),
      ...violations("openapi", ["remediation", "intelligence"]),
    ]).toEqual([]);
  });
});
