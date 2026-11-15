import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CveDetails, InventoryPackage } from "../../platform/types.js";
import {
  changedFilesSince,
  classifyPath,
  diffDeclarations,
  overrideTarget,
  readDeclarations,
} from "./changes.js";
import { CHECKS } from "./checks.js";
import * as commandCheck from "./command-check.js";
import { CHECK_NAMES, type VerifyRequest } from "./types.js";
import { verify } from "./verifier.js";

const mocks = vi.hoisted(() => ({ inventory: vi.fn() }));
vi.mock("../tools/check-inventory.js", () => ({
  checkInventoryTool: { execute: mocks.inventory },
}));
vi.mock("./command-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./command-check.js")>()),
  runCommandCheck: vi.fn(async () => ({ passed: true, output: "" })),
}));

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
const manifest = (dependencies: Record<string, string>, extra: object = {}) =>
  JSON.stringify({ name: "app", dependencies, ...extra }, null, 2);
const write = (file: string, content: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-"));
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  write("package.json", manifest({ lodash: "4.17.20" }));
  write("package-lock.json", "{}");
  write("src/index.js", "module.exports = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mocks.inventory.mockReset();
  vi.mocked(commandCheck.runCommandCheck).mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const advisory = (range = "<4.17.21"): CveDetails => ({
  id: "CVE-2021-23337",
  summary: "",
  severity: "HIGH",
  references: [],
  affectedPackages: [
    {
      name: "lodash",
      ecosystem: "npm",
      vulnerableRange: range,
      firstPatchedVersion: "4.17.21",
      source: "osv",
    },
  ],
});

const request = (over: Partial<VerifyRequest> = {}): VerifyRequest => ({
  cwd: dir,
  packageManager: "npm",
  baseFiles: new Map([["package.json", manifest({ lodash: "4.17.20" })]]),
  statusBefore: [],
  advisories: [advisory()],
  ...over,
});

const installed = (...packages: Array<[string, string]>) =>
  mocks.inventory.mockResolvedValue({
    packages: packages.map(([name, version]): InventoryPackage => ({
      name,
      version,
      type: "direct",
    })),
  });

describe("path and declaration helpers", () => {
  it("classifies the files a change may or may not touch", () => {
    expect(classifyPath("package.json")).toBe("manifest");
    expect(classifyPath("packages/a/package.json")).toBe("manifest");
    expect(classifyPath("pnpm-lock.yaml")).toBe("lockfile");
    expect(classifyPath("patches/lodash+4.17.20.patch")).toBe("patch");
    expect(classifyPath(".yarn/cache/x.zip")).toBe("install-state");
    expect(classifyPath("src/a.ts")).toBe("source");
    expect(classifyPath("README.md")).toBe("other");
    for (const forbidden of [
      ".github/workflows/ci.yml",
      ".github/autoremediator.yml",
      "node_modules/x/index.js",
      ".git/config",
      ".autoremediator/runs/x",
      // Run by CI, git, the shell or the package manager, not by the project's own code.
      ".github/actions/setup/index.js",
      ".husky/pre-commit",
      ".pnpmfile.cjs",
      "packages/a/.pnpmfile.cjs",
      ".yarnrc.yml",
      ".npmrc",
      ".envrc",
      ".gitattributes",
      "lefthook.yml",
    ]) {
      expect(classifyPath(forbidden)).toBe("forbidden");
    }
  });

  it("separates build and test configuration, which runs code, from source", () => {
    for (const tooling of [
      "vitest.config.ts",
      "jest.config.js",
      "eslint.config.mjs",
      "packages/a/webpack.config.cjs",
      ".eslintrc.js",
      "test/setup.setup.ts",
      "jest.setup.ts",
    ]) {
      expect(classifyPath(tooling)).toBe("tooling");
    }
    expect(classifyPath("src/config.ts")).toBe("source");
    expect(classifyPath("src/a.test.ts")).toBe("source");
  });

  it("reads declarations, including nested and aliased overrides", () => {
    expect(overrideTarget("parent>child")).toBe("child");
    expect(overrideTarget("child@<2.0.0")).toBe("child");
    expect(overrideTarget("@scope/child@1")).toBe("@scope/child");
    expect(overrideTarget("@scope/child")).toBe("@scope/child");

    const declared = readDeclarations(
      manifest(
        { a: "^1.0.0" },
        { overrides: { b: "2.0.0", c: { d: "3.0.0" } }, pnpm: { overrides: { e: "4.0.0" } } },
      ),
    );
    expect(declared.map((declaration) => [declaration.kind, declaration.name])).toEqual([
      ["dependency", "a"],
      ["override", "b"],
      ["override", "d"],
      ["override", "e"],
    ]);
    expect(readDeclarations("not json")).toEqual([]);
    expect(readDeclarations(null)).toEqual([]);
  });

  it("diffs declarations: changed, added and removed", () => {
    const before = manifest({ a: "1.0.0", gone: "1.0.0" }, { overrides: { o: "1.0.0" } });
    const after = manifest({ a: "1.0.1", fresh: "2.0.0" }, { overrides: { o: "1.0.5" } });
    expect(diffDeclarations("package.json", before, after)).toEqual([
      { kind: "dependency", name: "a", from: "1.0.0", to: "1.0.1", file: "package.json" },
      { kind: "dependency", name: "fresh", to: "2.0.0", file: "package.json" },
      { kind: "override", name: "o", from: "1.0.0", to: "1.0.5", file: "package.json" },
      { kind: "dependency", name: "gone", from: "1.0.0", file: "package.json" },
    ]);
    expect(diffDeclarations("package.json", before, before)).toEqual([]);
  });

  it("lists only what changed since a recorded status, and nothing outside git", async () => {
    write("package.json", manifest({ lodash: "4.17.21" }));
    await expect(changedFilesSince(dir, [])).resolves.toEqual(["package.json"]);
    // Already dirty before the change: not attributed to it.
    await expect(changedFilesSince(dir, [" M package.json"])).resolves.toEqual([]);
    await expect(changedFilesSince(dir, undefined)).resolves.toBeUndefined();
  });
});

describe("scope check", () => {
  it("accepts dependency files and rejects anything else", async () => {
    write("package.json", manifest({ lodash: "4.17.21" }));
    write("package-lock.json", '{"changed":true}');
    const ok = await verify(request({ checks: ["scope"] }));
    expect(ok.passed).toBe(true);
    expect(ok.changedFiles).toEqual(["package-lock.json", "package.json"]);

    write("src/index.js", "process.exit(1);\n");
    write(".github/workflows/ci.yml", "name: x\n");
    write("notes.txt", "hi");
    const bad = await verify(request({ checks: ["scope"] }));
    expect(bad).toMatchObject({ passed: false, failedCheck: "scope" });
    expect(bad.checks[0]?.details?.join("\n")).toMatch(/src\/index.js: project source/);
    expect(bad.checks[0]?.details?.join("\n")).toMatch(/ci.yml: never changed/);
    expect(bad.checks[0]?.details?.join("\n")).toMatch(/notes.txt: not a dependency file/);
  });

  it("allows source edits only when the change is allowed to make them", async () => {
    write("src/index.js", "module.exports = 2;\n");
    expect((await verify(request({ checks: ["scope"] }))).passed).toBe(false);
    expect(
      (await verify(request({ checks: ["scope"], options: { allowSourceEdits: true } }))).passed,
    ).toBe(true);
  });

  it("is skipped, not passed, outside a git repository", async () => {
    const result = await verify(request({ checks: ["scope"], statusBefore: undefined }));
    expect(result.passed).toBe(true);
    expect(result.checks[0]).toMatchObject({ status: "skipped" });
  });
});

describe("policy check", () => {
  const withPolicy = (yaml: string) => {
    write(".github/autoremediator.yml", yaml);
    git("add", "-A");
    git("commit", "-q", "-m", "policy");
  };

  it("passes changes the policy allows", async () => {
    write("package.json", manifest({ lodash: "4.17.21" }));
    const result = await verify(request({ checks: ["policy"] }));
    expect(result.checks[0]).toMatchObject({ status: "passed" });
  });

  it("rejects denied packages", async () => {
    withPolicy("denyPackages:\n  - lodash\n");
    write("package.json", manifest({ lodash: "4.17.21" }));
    const result = await verify(request({ checks: ["policy"] }));
    expect(result.failedCheck).toBe("policy");
    expect(result.checks[0]?.details?.[0]).toMatch(/lodash.*denyPackages/);
  });

  it("rejects a major bump unless allowed", async () => {
    write("package.json", manifest({ lodash: "5.0.0" }));
    expect((await verify(request({ checks: ["policy"] }))).checks[0]?.details?.[0]).toMatch(
      /major bump/,
    );

    withPolicy("allowMajorBumps: true\n");
    expect((await verify(request({ checks: ["policy"] }))).passed).toBe(true);
  });

  it("rejects overrides when the constraints forbid them", async () => {
    write("package.json", manifest({ lodash: "4.17.20" }, { overrides: { minimist: "1.2.6" } }));
    const direct = await verify(
      request({ checks: ["policy"], options: { constraints: { directDependenciesOnly: true } } }),
    );
    expect(direct.checks[0]?.details?.[0]).toMatch(/directDependenciesOnly/);
    const prefer = await verify(
      request({ checks: ["policy"], options: { constraints: { preferVersionBump: true } } }),
    );
    expect(prefer.checks[0]?.details?.[0]).toMatch(/preferVersionBump/);
  });

  it("fails, rather than guessing, when the policy cannot be loaded", async () => {
    write(".github/autoremediator.yml", "allowMajorBumps: maybe\nbogus: 1\n");
    const result = await verify(request({ checks: ["policy"] }));
    expect(result).toMatchObject({ passed: false, failedCheck: "policy" });
    expect(result.checks[0]?.message).toMatch(/could not be loaded/);
  });
});

describe("vuln-gone check", () => {
  it("passes when no installed copy is still in the vulnerable range", async () => {
    installed(["lodash", "4.17.21"]);
    const result = await verify(request({ checks: ["vuln-gone"] }));
    expect(result.checks[0]).toMatchObject({ status: "passed" });
  });

  it("fails and names every copy that is still vulnerable", async () => {
    installed(["lodash", "4.17.21"], ["lodash", "4.17.10"]);
    const result = await verify(request({ checks: ["vuln-gone"] }));
    expect(result.failedCheck).toBe("vuln-gone");
    expect(result.checks[0]?.details).toEqual([
      "lodash@4.17.10 is still in <4.17.21 (CVE-2021-23337)",
    ]);
  });

  it("ignores packages the plan knowingly leaves alone", async () => {
    installed(["lodash", "4.17.10"]);
    const result = await verify(request({ checks: ["vuln-gone"], expectedRemaining: ["lodash"] }));
    expect(result.passed).toBe(true);
  });

  it("fails when the installed packages cannot be listed, and skips with no advisory", async () => {
    mocks.inventory.mockResolvedValue({ packages: [], error: "npm ls exploded" });
    expect((await verify(request({ checks: ["vuln-gone"] }))).checks[0]).toMatchObject({
      status: "failed",
      details: ["npm ls exploded"],
    });
    expect(
      (await verify(request({ checks: ["vuln-gone"], advisories: [] }))).checks[0]?.status,
    ).toBe("skipped");
  });
});

describe("command checks", () => {
  const run = vi.mocked(commandCheck.runCommandCheck);

  it("runs a frozen install and reports its output tail on failure", async () => {
    run.mockResolvedValueOnce({ passed: false, output: "a\nb\nnpm ERR! lock out of sync" });
    const result = await verify(request({ checks: ["install"] }));
    expect(run.mock.calls[0]?.[0]).toEqual(["npm", "ci", "--prefer-offline", "--ignore-scripts"]);
    expect(result).toMatchObject({ failedCheck: "install" });
    expect(result.checks[0]?.details?.at(-1)).toBe("npm ERR! lock out of sync");
  });

  it("runs tests and the type checker only when asked", async () => {
    const untouched = await verify(request({ checks: ["tests", "typecheck"] }));
    expect(untouched.checks.map((check) => check.status)).toEqual(["skipped", "skipped"]);
    expect(run).not.toHaveBeenCalled();

    write("tsconfig.json", "{}");
    await verify(
      request({ checks: ["tests", "typecheck"], options: { runTests: true, typecheck: true } }),
    );
    expect(run.mock.calls.map((call) => call[0])).toEqual([
      ["npx", "tsc", "--noEmit"],
      ["npm", "test"],
    ]);
  });

  it("fails on a failing test run", async () => {
    run.mockResolvedValueOnce({ passed: false, output: "1 failing" });
    const result = await verify(request({ checks: ["tests"], options: { runTests: true } }));
    expect(result).toMatchObject({ passed: false, failedCheck: "tests" });
  });
});

describe("proof-of-fix check", () => {
  it("is skipped without a test, and a failure when one is required", async () => {
    expect((await verify(request({ checks: ["proof-of-fix"] }))).checks[0]?.status).toBe("skipped");
    const required = await verify(
      request({ checks: ["proof-of-fix"], options: { requireProofOfFix: true } }),
    );
    expect(required).toMatchObject({ passed: false, failedCheck: "proof-of-fix" });
  });

  it("passes a reproduction test that passes now and fails one that does not", async () => {
    write("repro-ok.cjs", "process.exit(0);\n");
    write("repro-bad.cjs", "throw new Error('still exploitable');\n");
    const ok = await verify(
      request({ checks: ["proof-of-fix"], options: { reproductionTest: "repro-ok.cjs" } }),
    );
    expect(ok.checks[0]?.status).toBe("passed");
    const bad = await verify(
      request({ checks: ["proof-of-fix"], options: { reproductionTest: "repro-bad.cjs" } }),
    );
    expect(bad).toMatchObject({ passed: false, failedCheck: "proof-of-fix" });
  });
});

describe("verify orchestration", () => {
  it("lists every check in canonical order and stops at the first failure", async () => {
    installed(["lodash", "4.17.21"]);
    write("package.json", manifest({ lodash: "4.17.21" }));
    write("src/index.js", "changed\n"); // out of scope

    const result = await verify(request());

    expect(result.checks.map((check) => check.name)).toEqual([...CHECK_NAMES]);
    expect(result).toMatchObject({ passed: false, failedCheck: "scope" });
    for (const later of result.checks.slice(1)) {
      expect(later).toMatchObject({ status: "skipped", message: "not run: scope failed" });
    }
  });

  it("passes when every check that ran passed", async () => {
    installed(["lodash", "4.17.21"]);
    write("package.json", manifest({ lodash: "4.17.21" }));
    const result = await verify(request({ checks: ["scope", "policy", "vuln-gone"] }));
    expect(result).toMatchObject({ passed: true });
    expect(result.checks.map((check) => check.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("honours a subset of checks and treats a throwing check as a failure", async () => {
    const result = await verify(request({ checks: ["policy", "tests"] }), {
      policy: async () => {
        throw new Error("kaboom");
      },
    });
    expect(result.checks.map((check) => check.name)).toEqual(["policy", "tests"]);
    expect(result).toMatchObject({ passed: false, failedCheck: "policy" });
    expect(result.checks[0]?.details).toEqual(["kaboom"]);
  });

  it("exposes one implementation per check name", () => {
    expect(Object.keys(CHECKS).toSorted()).toEqual([...CHECK_NAMES].toSorted());
  });
});
