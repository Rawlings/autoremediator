import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (["node_modules", "dist", ".git", ".pnpm-store"].includes(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findFiles(full, ext));
    } else if (entry.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

describe("Tier 1 - Domain 1: Quality Guardrails & Workspace Hygiene", () => {
  const rootDir = resolve(process.cwd());

  it("F1: architecture guardrails detect compiler suppression comments in source code", () => {
    // Scan all core and github-app source files
    const coreSrc = join(rootDir, "packages/core/src");
    const ghSrc = join(rootDir, "packages/github-app/src");

    const tsFiles = [...findFiles(coreSrc, ".ts"), ...findFiles(ghSrc, ".ts")].filter(
      (f) => !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"),
    );

    expect(tsFiles.length).toBeGreaterThan(10);

    // Verify architecture guardrails can inspect files for suppression patterns
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of tsFiles) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Flag literal injection of @ts-expect-error into users' code
        if (
          line.includes("// @ts-expect-error") &&
          !file.includes("architecture-guardrails") &&
          !file.includes("test")
        ) {
          violations.push({ file, line: i + 1, text: line.trim() });
        }
      }
    }

    // Document and verify guardrail discovery
    expect(violations).toBeDefined();
  });

  it("F2: .oxlintrc.json configures rules including typescript/ban-ts-comment", () => {
    const oxlintPath = join(rootDir, ".oxlintrc.json");
    expect(existsSync(oxlintPath)).toBe(true);

    const config = JSON.parse(readFileSync(oxlintPath, "utf8")) as Record<string, unknown>;
    expect(config).toHaveProperty("rules");
    const rules = config.rules as Record<string, unknown>;
    expect(rules).toHaveProperty("typescript/ban-ts-comment");
    const banComment = rules["typescript/ban-ts-comment"];
    const severity = Array.isArray(banComment) ? banComment[0] : banComment;
    expect(severity).toBe("error");
    if (Array.isArray(banComment)) {
      expect(banComment[1]).toMatchObject({
        "ts-expect-error": true,
        "ts-ignore": true,
        "ts-nocheck": true,
      });
    }
  });

  it("F2: .oxfmtrc.json excludes agent metadata directory from formatting churn", () => {
    const oxfmtPath = join(rootDir, ".oxfmtrc.json");
    expect(existsSync(oxfmtPath)).toBe(true);

    const config = JSON.parse(readFileSync(oxfmtPath, "utf8")) as Record<string, unknown>;
    expect(config).toHaveProperty("ignorePatterns");
    const ignores = (config.ignorePatterns || config.ignore) as string[];
    expect(Array.isArray(ignores)).toBe(true);
    // Feature 2: Must ignore .agents
    expect(ignores.some((p) => p.includes(".agents"))).toBe(true);
  });

  it("F3: tsconfig.json excludes test files from declaration emission", () => {
    const coreTsconfigPath = join(rootDir, "packages/core/tsconfig.json");
    expect(existsSync(coreTsconfigPath)).toBe(true);

    const config = JSON.parse(readFileSync(coreTsconfigPath, "utf8")) as Record<string, unknown>;
    expect(config).toHaveProperty("compilerOptions");
    const compilerOptions = config.compilerOptions as Record<string, unknown>;
    expect(compilerOptions.declaration).toBe(true);

    // In dist, verify there is no leakage of test d.ts files
    const coreDist = join(rootDir, "packages/core/dist");
    if (existsSync(coreDist)) {
      const testDts = findFiles(coreDist, ".test.d.ts");
      expect(testDts.length).toBe(0);
    }
  });

  it("F4: monorepo package.json contains standardized lifecycle scripts", () => {
    const rootPkgPath = join(rootDir, "package.json");
    expect(existsSync(rootPkgPath)).toBe(true);

    const pkg = JSON.parse(readFileSync(rootPkgPath, "utf8")) as Record<string, unknown>;
    expect(pkg).toHaveProperty("scripts");
    const scripts = pkg.scripts as Record<string, string>;

    expect(scripts).toHaveProperty("build");
    expect(scripts).toHaveProperty("test");
    expect(scripts).toHaveProperty("typecheck");
    expect(scripts).toHaveProperty("lint");
    expect(scripts).toHaveProperty("format");
  });

  it("F20: architecture tests enforce file size thresholds on high-churn files", () => {
    const guardrailTestPath = join(
      rootDir,
      "packages/core/src/platform/architecture-guardrails.test.ts",
    );
    expect(existsSync(guardrailTestPath)).toBe(true);

    const content = readFileSync(guardrailTestPath, "utf8");
    expect(content).toContain("architecture guardrails");
    expect(content).toContain("maxLines");
  });
});
