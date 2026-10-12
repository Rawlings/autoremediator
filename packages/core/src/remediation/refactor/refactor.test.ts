import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPackageCallSites } from "./call-site-finder.js";
import {
  refactorConsumerCallSites,
  revertRefactorSnapshots,
  parseCompilerDiagnostics,
  transformCallArguments,
} from "./refactor-agent.js";

describe("breaking-change refactoring engine", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autoremediator-refactor-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("finds consumer call-sites using AST parser", () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const fileA = join(srcDir, "index.ts");
    writeFileSync(
      fileA,
      `import chalk from "chalk";\nexport function log(msg: string) { console.log(chalk.red(msg)); }\n`,
      "utf8",
    );

    const fileB = join(srcDir, "other.ts");
    writeFileSync(fileB, `export const x = 42;\n`, "utf8");

    const callSites = findPackageCallSites(tempDir, "chalk");
    expect(callSites).toHaveLength(1);
    expect(callSites[0]?.filePath).toBe(fileA);
    expect(callSites[0]?.imports).toEqual(
      expect.arrayContaining([expect.objectContaining({ localName: "chalk", isDefault: true })]),
    );
  });

  it("applies deterministic codemod when default export is missing", async () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const fileA = join(srcDir, "app.ts");
    const originalCode = `import chalk from "chalk";\nconsole.log(chalk.blue("hello"));\n`;
    writeFileSync(fileA, originalCode, "utf8");

    const callSites = findPackageCallSites(tempDir, "chalk");
    const result = await refactorConsumerCallSites({
      cwd: tempDir,
      packageName: "chalk",
      fromVersion: "4.1.2",
      toVersion: "5.0.0",
      diagnosticError: "Module 'chalk' has no default export.",
      callSites,
    });

    expect(result.applied).toBe(true);
    expect(result.refactoredFiles).toContain(fileA);

    const updated = readFileSync(fileA, "utf8");
    expect(updated).toContain('import * as chalk from "chalk";');
  });

  it("applies compiler-guided suggestion when diagnostic includes 'Did you mean' suggestion", async () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const fileA = join(srcDir, "clean.ts");
    const originalCode = `import glob from "glob";\nglob.sync("**/*");\n`;
    writeFileSync(fileA, originalCode, "utf8");

    const callSites = findPackageCallSites(tempDir, "glob");
    const result = await refactorConsumerCallSites({
      cwd: tempDir,
      packageName: "glob",
      fromVersion: "8.0.0",
      toVersion: "10.0.0",
      diagnosticError: `src/clean.ts:2:6 - error TS2339: Property 'sync' does not exist on type 'typeof import("glob")'. Did you mean 'globSync'?`,
      callSites,
    });

    expect(result.applied).toBe(true);
    const updated = readFileSync(fileA, "utf8");
    expect(updated).toContain("globSync");
  });

  it("migrates subpath imports when package reorganizes exports", async () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const fileA = join(srcDir, "id.ts");
    const originalCode = `import v4 from "uuid/v4";\nconst id = v4();\n`;
    writeFileSync(fileA, originalCode, "utf8");

    const callSites = findPackageCallSites(tempDir, "uuid");
    const result = await refactorConsumerCallSites({
      cwd: tempDir,
      packageName: "uuid",
      fromVersion: "3.4.0",
      toVersion: "9.0.0",
      diagnosticError: `Error: Cannot find module 'uuid/v4'`,
      callSites,
    });

    expect(result.applied).toBe(true);
    const updated = readFileSync(fileA, "utf8");
    expect(updated).toContain('import { v4 as v4 } from "uuid";');
  });

  it("parses compiler diagnostics with suggestions and missing members", () => {
    const errorOutput = `
src/app.ts(14,5): error TS2305: Module '"rimraf"' has no exported member 'sync'. Did you mean 'rimrafSync'?
src/utils.ts:8:10 - error TS2614: Module '"chalk"' has no default export.
`;
    const diagnostics = parseCompilerDiagnostics(errorOutput);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.suggestedSymbol).toBe("rimrafSync");
    expect(diagnostics[0]?.missingMember).toBe("sync");
    expect(diagnostics[1]?.code).toBe("TS2614");
  });

  it("reverts snapshots when requested", () => {
    const fileA = join(tempDir, "test.ts");
    writeFileSync(fileA, "mutated content", "utf8");

    revertRefactorSnapshots({
      [fileA]: "original content",
    });

    expect(readFileSync(fileA, "utf8")).toBe("original content");
  });

  it("truthfully returns applied: false without injecting @ts-expect-error on unmatched diagnostic", async () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const fileA = join(srcDir, "unmatched.ts");
    const originalCode = `import { foo } from "some-pkg";\nconst x: number = foo();\n`;
    writeFileSync(fileA, originalCode, "utf8");

    const callSites = findPackageCallSites(tempDir, "some-pkg");
    const result = await refactorConsumerCallSites({
      cwd: tempDir,
      packageName: "some-pkg",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      diagnosticError: `src/unmatched.ts:2:7 - error TS2322: Type 'string' is not assignable to type 'number'.`,
      callSites,
    });

    expect(result.applied).toBe(false);
    expect(result.refactoredFiles).toHaveLength(0);
    expect(result.error).toContain("No automated codemod pattern matched");

    const fileContent = readFileSync(fileA, "utf8");
    expect(fileContent).toBe(originalCode);
    expect(fileContent).not.toContain("@ts-expect-error");
    expect(fileContent).not.toContain("@ts-ignore");
  });

  it("transforms method call with arguments preserved across multiple lines", async () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const fileA = join(srcDir, "multiline.ts");
    const originalCode = `import rimraf from "rimraf";\nrimraf.sync(\n  "/path/to/dir",\n  { maxRetries: 3 }\n);\n`;
    writeFileSync(fileA, originalCode, "utf8");

    const callSites = findPackageCallSites(tempDir, "rimraf");
    const result = await refactorConsumerCallSites({
      cwd: tempDir,
      packageName: "rimraf",
      fromVersion: "3.0.2",
      toVersion: "5.0.0",
      diagnosticError: `Property 'sync' does not exist on type 'typeof import("rimraf")'`,
      callSites,
    });

    expect(result.applied).toBe(true);
    const updated = readFileSync(fileA, "utf8");
    expect(updated).toContain('import { rimrafSync } from "rimraf";');
    expect(updated).toContain("rimrafSync(");
    expect(updated).toContain(`"/path/to/dir",`);
    expect(updated).toContain(`{ maxRetries: 3 }`);
    expect(updated).not.toContain("@ts-expect-error");
  });

  it("handles aliased imports in AST refactoring", async () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const fileA = join(srcDir, "aliased.ts");
    const originalCode = `import rm from "rimraf";\nrm.sync("/tmp/target");\n`;
    writeFileSync(fileA, originalCode, "utf8");

    const callSites = findPackageCallSites(tempDir, "rimraf");
    const result = await refactorConsumerCallSites({
      cwd: tempDir,
      packageName: "rimraf",
      fromVersion: "3.0.2",
      toVersion: "5.0.0",
      diagnosticError: `Property 'sync' does not exist on type 'typeof import("rimraf")'`,
      callSites,
    });

    expect(result.applied).toBe(true);
    const updated = readFileSync(fileA, "utf8");
    expect(updated).toContain('import { rimrafSync } from "rimraf";');
    expect(updated).toContain('rimrafSync("/tmp/target")');
  });

  it("removes deprecated parameter from call expression via AST transformCallArguments", () => {
    const code = `function run() { executeQuery(sql, deprecatedCallback, options); }`;
    const res = transformCallArguments(code, {
      callee: "executeQuery",
      dropIndex: 1,
    });

    expect(res.modified).toBe(true);
    expect(res.newContent).toBe(`function run() { executeQuery(sql, options); }`);
  });

  it("reorders arguments according to signature specification via AST transformCallArguments", () => {
    const code = `fetchUrl(url, timeout, headers);`;
    const res = transformCallArguments(code, {
      callee: "fetchUrl",
      reorder: [1, 2],
    });

    expect(res.modified).toBe(true);
    expect(res.newContent).toBe(`fetchUrl(url, headers, timeout);`);
  });

  it("does not mutate identical identifiers inside comments or string literals", () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const fileA = join(srcDir, "commented.ts");
    const originalCode = `// uses rimraf.sync here\nconst note = "rimraf.sync is legacy";\n`;
    writeFileSync(fileA, originalCode, "utf8");

    const callSites = findPackageCallSites(tempDir, "rimraf");
    // Should have 0 call sites because there is no import of rimraf
    expect(callSites).toHaveLength(0);
    expect(readFileSync(fileA, "utf8")).toBe(originalCode);
  });
});
