import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installed, makeProject, removeProjects } from "../../../features/diet/testing/project.js";
import { createProgram } from "../program.js";

let output = "";
let exitCode: typeof process.exitCode;

beforeEach(() => {
  output = "";
  exitCode = process.exitCode;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCode;
  removeProjects();
});

const run = (...args: string[]) =>
  createProgram().parseAsync(["node", "autoremediator", "diet", ...args]);

function project(): string {
  const dir = makeProject({
    "package.json": {
      name: "app",
      engines: { node: ">=20" },
      dependencies: { used: "^1.0.0", orphan: "^1.0.0", rimraf: "^6.0.0" },
    },
    "index.js": 'require("used"); require("rimraf");\n',
  });
  installed(dir, { used: true, orphan: true, rimraf: true });
  return dir;
}

describe("autoremediator diet", () => {
  it("prints the score with its breakdown, unused and replaceable dependencies", async () => {
    await run("--cwd", project());
    expect(output).toMatch(/Attack-surface score: \d+\/100/);
    expect(output).toMatch(/Installed packages: 0 {2}\[30 \* min\(1, ln\(1 \+ packages\)/);
    expect(output).toContain("certainly-unused");
    expect(output).toMatch(/orphan \(dependencies\)/);
    expect(output).toContain(
      "no import, require, string reference, script, config or workflow names it",
    );
    expect(output).toMatch(/replaceable\s+rimraf -> fs\.rm \[check-usage\]/);
    expect(output).toContain("Node >=20 from engines.node");
    expect(output).toContain("Duplicates: not analysed. no lockfile found");
  });

  it("prints the whole report as JSON", async () => {
    await run("--cwd", project(), "--output-format", "json");
    const report = JSON.parse(output) as {
      schemaVersion: string;
      summary: { certainlyUnused: number; replaceable: number };
      attackSurface: { formulaVersion: number };
    };
    expect(report.schemaVersion).toBe("1");
    expect(report.summary).toMatchObject({ certainlyUnused: 1, replaceable: 1 });
    expect(report.attackSurface.formulaVersion).toBe(1);
  });

  it("writes nothing without --apply", async () => {
    const dir = project();
    const before = execFileSync(
      "node",
      ["-e", "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"],
      { cwd: dir, encoding: "utf8" },
    );
    await run("--cwd", dir);
    const after = execFileSync(
      "node",
      ["-e", "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(after).toBe(before);
  });

  it("rejects apply-only flags without --apply", async () => {
    await expect(run("--run-tests")).rejects.toThrow(/only apply with --apply/);
    await expect(run("--no-typecheck")).rejects.toThrow(/only apply with --apply/);
    await expect(run("--package-manager", "npm")).rejects.toThrow(/only apply with --apply/);
  });

  it("rejects an unknown output format", async () => {
    await expect(run("--output-format", "sarif")).rejects.toThrow(
      /diet supports --output-format text\|json/,
    );
  });

  it("with --apply and nothing certainly unused, says so and exits 0", async () => {
    const dir = makeProject({
      "package.json": { name: "app", dependencies: { used: "1" } },
      "index.js": 'require("used");\n',
    });
    installed(dir, { used: true });
    await run("--cwd", dir, "--apply");
    expect(output).toContain("No dependency is certainly unused, so nothing was removed.");
    expect(process.exitCode).toBe(exitCode);
  });

  it("with --apply, exits 1 and restores the project when verification fails", async () => {
    const dir = makeProject({
      "package.json": {
        name: "app",
        version: "1.0.0",
        private: true,
        scripts: { test: "node check.js" },
        dependencies: { used: "file:vendor/used", orphan: "file:vendor/orphan" },
      },
      "index.js": 'console.log(require("used"));\n',
      "check.js": "process.exit(require('node:fs').existsSync('node_modules/orphan') ? 0 : 1);\n",
      "vendor/used/package.json": { name: "used", version: "1.0.0", main: "i.js" },
      "vendor/used/i.js": "module.exports = 1;\n",
      "vendor/orphan/package.json": { name: "orphan", version: "1.0.0", main: "i.js" },
      "vendor/orphan/i.js": "module.exports = 2;\n",
      ".gitignore": "node_modules\n.autoremediator\n",
    });
    execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts"], {
      cwd: dir,
      stdio: "ignore",
    });
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "t@example.test"],
      ["config", "user.name", "t"],
      ["add", "-A"],
      ["commit", "-q", "-m", "init"],
    ]) {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    }

    await run("--cwd", dir, "--apply", "--run-tests", "--no-typecheck");

    expect(output).toMatch(/Verification failed \(tests\)/);
    expect(output).toMatch(/would remove orphan/);
    expect(process.exitCode).toBe(1);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  }, 120_000);
});
