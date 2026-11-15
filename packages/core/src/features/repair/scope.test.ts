import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commandCheck from "../verify/command-check.js";
import { DEFAULT_REPAIR_BUDGET } from "./repair-agent.js";
import { ScopeGuard, ScopeViolation } from "./scope-guard.js";
import { createRepairTools, type RepairState } from "./tools.js";

vi.mock("../verify/command-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../verify/command-check.js")>()),
  runCommandCheck: vi.fn(async () => ({ passed: true, output: "" })),
}));

let root: string;
let outside: string;
const write = (file: string, content: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), content);
};
const read = (file: string) => readFileSync(join(root, file), "utf8");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scope-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "scope-out-")));
  write("package.json", '{"name":"app"}');
  write("package-lock.json", "{}");
  write("src/a.ts", "export const a = 1;\nexport const b = 2;\n");
  write(".env", "TOKEN=abc");
  write(".npmrc", "//registry/:_authToken=abc");
  write(".github/workflows/ci.yml", "name: ci\n");
  write("node_modules/dep/package.json", '{"name":"dep","version":"2.0.0","types":"index.d.ts"}');
  write("node_modules/dep/index.d.ts", "export declare function f(): void;\n");
  write("node_modules/dep/CHANGELOG.md", "## 2.0.0\n- f no longer takes arguments\n");
  writeFileSync(join(outside, "secret.txt"), "outside");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("ScopeGuard", () => {
  it("keeps every path inside the checkout, including through symlinks", () => {
    const guard = new ScopeGuard(root);
    expect(guard.resolveInside("src/a.ts")).toBe(join(root, "src/a.ts"));
    for (const bad of ["../x", "src/../../x", outside, join(outside, "secret.txt")]) {
      expect(() => guard.resolveInside(bad)).toThrow(ScopeViolation);
    }
    symlinkSync(outside, join(root, "src", "link"));
    expect(() => guard.resolveInside("src/link/secret.txt")).toThrow(
      /outside the project checkout/,
    );
    expect(() => guard.assertWritable("src/link/new.ts")).toThrow(ScopeViolation);
  });

  it("does not let an agent read credentials or git internals", () => {
    const guard = new ScopeGuard(root);
    for (const secret of [
      ".env",
      ".npmrc",
      ".git/config",
      "keys/server.pem",
      "id_rsa",
      ".autoremediator/runs/x",
      ".netrc",
      ".git-credentials",
      ".envrc",
      ".yarnrc",
      "infra/prod.tfvars",
      "config/serviceAccount-prod.json",
      "credentials",
    ]) {
      expect(() => guard.assertReadable(secret)).toThrow(ScopeViolation);
    }
    expect(guard.assertReadable("src/a.ts")).toBe(join(root, "src/a.ts"));
    expect(guard.assertReadable("node_modules/dep/index.d.ts")).toContain("index.d.ts");
  });

  it("does not let an agent plant code that something else runs", () => {
    const guard = new ScopeGuard(root);
    // Build and test configuration, git hooks, package manager hooks and CI actions all run code.
    for (const path of [
      "vitest.config.ts",
      "eslint.config.mjs",
      ".pnpmfile.cjs",
      ".husky/pre-commit",
      ".github/actions/setup/index.js",
    ]) {
      expect(() => guard.assertWritable(path)).toThrow(ScopeViolation);
    }
    // A new test file runs with the project's privileges; an existing one may still be repaired.
    expect(() => guard.assertWritable("src/new.test.ts")).toThrow(/new test file/);
    write("src/a.test.ts", "export {};\n");
    expect(guard.assertWritable("src/a.test.ts")).toBe(join(root, "src/a.test.ts"));
  });

  it("lets an agent write project source, and nothing else", () => {
    const guard = new ScopeGuard(root);
    for (const ok of ["src/a.ts", "src/new/file.ts", "lib/x.mjs", "src/c.tsx"]) {
      expect(() => guard.assertWritable(ok)).not.toThrow();
    }
    for (const bad of [
      "package.json",
      "package-lock.json",
      ".github/workflows/ci.yml",
      ".github/autoremediator.yml",
      "README.md",
      "node_modules/dep/index.js",
      "src/../package.json",
      ".git/hooks/pre-commit",
      "src/data.json",
      ".",
    ]) {
      expect(() => guard.assertWritable(bad)).toThrow(ScopeViolation);
    }
  });
});

describe("repair tools", () => {
  const state = (): RepairState => ({ commandRuns: 0, filesChanged: new Set() });
  const tools = (
    s: RepairState,
    commands = { typecheck: ["tsc"], tests: ["npm", "test"] },
  ): ToolSet =>
    createRepairTools({
      guard: new ScopeGuard(root),
      commands,
      budget: { ...DEFAULT_REPAIR_BUDGET, maxCommandRuns: 2 },
      state: s,
    });
  const call = async (set: ToolSet, name: string, input: unknown): Promise<string> => {
    const run = set[name]!.execute as (input: unknown, options: unknown) => Promise<string>;
    return run(input, { toolCallId: "t", messages: [] });
  };

  it("reads numbered line ranges and refuses credentials", async () => {
    const set = tools(state());
    await expect(call(set, "readFile", { path: "src/a.ts" })).resolves.toContain(
      "1\texport const a = 1;",
    );
    await expect(
      call(set, "readFile", { path: "src/a.ts", startLine: 2, endLine: 2 }),
    ).resolves.toContain("2\texport const b = 2;");
    await expect(call(set, "readFile", { path: ".env" })).resolves.toMatch(/^Refused/);
    await expect(call(set, "readFile", { path: "../outside" })).resolves.toMatch(/^Refused/);
    await expect(call(set, "readFile", { path: "src" })).resolves.toMatch(/not a file/);
  });

  it("lists and searches project files but not node_modules", async () => {
    const set = tools(state());
    const listing = await call(set, "listFiles", {});
    expect(listing).toContain("src/a.ts");
    expect(listing).not.toContain("node_modules");
    expect(listing).not.toContain(".env");

    await expect(call(set, "searchCode", { pattern: "export const (a|b)" })).resolves.toBe(
      "src/a.ts:1: export const a = 1;\nsrc/a.ts:2: export const b = 2;",
    );
    await expect(call(set, "searchCode", { pattern: "declare function" })).resolves.toBe(
      "(no matches)",
    );
    await expect(call(set, "searchCode", { pattern: "TOKEN" })).resolves.toBe("(no matches)");
    await expect(call(set, "searchCode", { pattern: "(" })).resolves.toMatch(
      /not a valid regular expression/,
    );
  });

  it("refuses search patterns that can backtrack catastrophically", async () => {
    write("src/evil.ts", `${"a".repeat(30)}!`);
    const set = tools(state());
    for (const pattern of [
      "(a+)+$",
      "(.*)*x",
      String.raw`(\w+\s?)*$`,
      "((a+)b)*",
      "(a{2,})+$",
      "(?:a*)+b",
    ]) {
      await expect(call(set, "searchCode", { pattern })).resolves.toMatch(/nested quantifier/);
    }
    await expect(call(set, "searchCode", { pattern: "a".repeat(201) })).resolves.toMatch(
      /too long/,
    );
  });

  it("still runs ordinary patterns, including groups, classes and escaped parentheses", async () => {
    write("src/evil.ts", "foo(a+)+ bar [x+]+");
    const set = tools(state());
    await expect(call(set, "searchCode", { pattern: String.raw`foo\(a\+\)\+` })).resolves.toContain(
      "src/evil.ts:1:",
    );
    await expect(call(set, "searchCode", { pattern: "(foo|bar)+ " })).resolves.toContain(
      "src/evil.ts:1:",
    );
    await expect(call(set, "searchCode", { pattern: "[x+]+" })).resolves.toContain(
      "src/evil.ts:1:",
    );
    await expect(call(set, "searchCode", { pattern: String.raw`(\w+)\(` })).resolves.toContain(
      "src/evil.ts:1:",
    );
  });

  it("caps the length of each searched line", async () => {
    write("src/long.ts", `${"x".repeat(100_000)}NEEDLE\nshort NEEDLE`);
    const set = tools(state());
    const started = performance.now();
    const result = await call(set, "searchCode", { pattern: "NEEDLE", dir: "src" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).not.toContain("long.ts:1:");
    expect(result).toContain("long.ts:2: short NEEDLE");
  });

  it("edits one exact occurrence in source files only", async () => {
    const s = state();
    const set = tools(s);
    await expect(
      call(set, "editFile", { path: "src/a.ts", oldText: "a = 1", newText: "a = 10" }),
    ).resolves.toBe("Edited src/a.ts");
    expect(read("src/a.ts")).toBe("export const a = 10;\nexport const b = 2;\n");
    expect([...s.filesChanged]).toEqual(["src/a.ts"]);

    await expect(
      call(set, "editFile", { path: "src/a.ts", oldText: "nope", newText: "x" }),
    ).resolves.toMatch(/not found/);
    await expect(
      call(set, "editFile", { path: "src/a.ts", oldText: "export const", newText: "x" }),
    ).resolves.toMatch(/more than once/);
    await expect(
      call(set, "editFile", { path: "package.json", oldText: "app", newText: "evil" }),
    ).resolves.toMatch(/^Refused/);
    await expect(
      call(set, "editFile", { path: "src/missing.ts", oldText: "a", newText: "b" }),
    ).resolves.toMatch(/does not exist/);
    expect(read("package.json")).toBe('{"name":"app"}');
  });

  it("creates new source files and nothing outside the allowed kinds", async () => {
    const s = state();
    const set = tools(s);
    await expect(
      call(set, "writeFile", { path: "src/deep/new.ts", content: "export {};\n" }),
    ).resolves.toBe("Wrote src/deep/new.ts");
    expect(read("src/deep/new.ts")).toBe("export {};\n");
    for (const path of [
      "package-lock.json",
      ".github/workflows/ci.yml",
      "notes.md",
      "../escape.ts",
    ]) {
      await expect(call(set, "writeFile", { path, content: "x" })).resolves.toMatch(/^Refused/);
    }
    expect(read("package-lock.json")).toBe("{}");
  });

  it("runs only the project's own checks, within the command budget", async () => {
    const run = vi.mocked(commandCheck.runCommandCheck);
    run.mockResolvedValueOnce({
      passed: false,
      output: "src/a.ts(1,1): error TS2554: Expected 0 arguments",
    });
    const s = state();
    const set = tools(s);

    await expect(call(set, "runCheck", { name: "typecheck" })).resolves.toContain(
      "FAILED\nsrc/a.ts(1,1): error TS2554",
    );
    expect(run.mock.calls[0]?.[0]).toEqual(["tsc"]);
    await expect(call(set, "runCheck", { name: "tests" })).resolves.toBe("tests: passed");
    await expect(call(set, "runCheck", { name: "tests" })).resolves.toMatch(
      /Command limit reached/,
    );
    expect(s.commandRuns).toBe(2);
    await expect(call(tools(state()), "runCheck", { name: "build" })).resolves.toMatch(
      /No build command/,
    );
  });

  it("shows a dependency's upgrade notes and refuses names that are not packages", async () => {
    const set = tools(state());
    const docs = await call(set, "readPackageDocs", { packageName: "dep" });
    expect(docs).toContain('dep@"2.0.0" types: index.d.ts');
    expect(docs).toContain("f no longer takes arguments");
    await expect(call(set, "readPackageDocs", { packageName: "../../etc" })).resolves.toMatch(
      /not a package name/,
    );
    await expect(call(set, "readPackageDocs", { packageName: "absent" })).resolves.toMatch(
      /not installed/,
    );
  });

  it("records the end of the conversation", async () => {
    const s = state();
    const set = tools(s);
    await call(set, "submit", { summary: "done" });
    await call(set, "giveUp", { reason: "hopeless" });
    expect(s).toMatchObject({ submitted: "done", gaveUp: "hopeless" });
  });
});
