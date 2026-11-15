import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildHistory,
  makeRepo,
  SECRET_VALUES,
  type TestRepo,
} from "../../features/incident/testing/repo.js";
import { createProgram } from "./program.js";

let repo: TestRepo;
let out: string;
let stdout: string;

beforeEach(() => {
  repo = makeRepo("incident-cli");
  buildHistory(repo);
  out = mkdtempSync(join(tmpdir(), "incident-cli-out-"));
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  repo.cleanup();
  rmSync(out, { recursive: true, force: true });
});

const run = (...args: string[]) => createProgram().parseAsync(["node", "autoremediator", ...args]);

describe("autoremediator incident", () => {
  it("prints the report as markdown and exits 4 while an affected version is locked", async () => {
    await run("incident", "evil-lib@>=1.0.2", "--cwd", repo.dir, "--offline");
    expect(stdout).toContain("## 1. Exposure now");
    expect(stdout).toContain("`evil-lib@1.0.3`");
    expect(stdout).toContain("## 4. Rotation checklist");
    expect(process.exitCode).toBe(4);
  });

  it("prints JSON, writes the files and records a plan on request", async () => {
    const outputDir = join(out, "r");
    await run(
      "incident",
      "evil-lib@>=1.0.2",
      "--cwd",
      repo.dir,
      "--offline",
      "--plan",
      "--output-dir",
      outputDir,
      "--output-format",
      "json",
    );
    const report = JSON.parse(stdout) as {
      rollback: { plan: { runId: string } };
      files: { markdown: string };
    };
    expect(report.rollback.plan.runId).toMatch(/^run_/);
    expect(readFileSync(report.files.markdown, "utf8")).toContain("Recorded as plan");

    stdout = "";
    await run("runs", "show", report.rollback.plan.runId, "--cwd", repo.dir);
    expect(stdout).toContain("evil-lib 1.0.3 -> 1.0.1 (override, rollback)");
  });

  it("exits 0 for a package that was never here, and honours --no-history", async () => {
    await run(
      "incident",
      "never-used@1.0.0",
      "--cwd",
      repo.dir,
      "--offline",
      "--no-history",
      "--output-format",
      "json",
    );
    expect(JSON.parse(stdout)).not.toHaveProperty("history");
    expect(process.exitCode).toBe(0);
  });

  it("rejects an unsupported output format", async () => {
    await expect(
      run("incident", "evil-lib@1", "--cwd", repo.dir, "--output-format", "sarif"),
    ).rejects.toThrow();
  });
});

describe("autoremediator premortem", () => {
  it("reads a portfolio-style targets file, ignoring its scan fields, and writes playbooks", async () => {
    const targetsFile = join(out, "targets.json");
    writeFileSync(
      targetsFile,
      JSON.stringify([{ cwd: repo.dir, label: "app", cveId: "CVE-2021-23337" }]),
    );
    const outputDir = join(out, "ops");
    await run(
      "premortem",
      "--targets-file",
      targetsFile,
      "--packages",
      "evil-lib,mid",
      "--output-dir",
      outputDir,
    );
    expect(stdout).toContain("Assessed 2 package(s) across 1 repository.");
    expect(stdout).toContain("evil-lib: 1 repo(s)");
    const playbook = readFileSync(join(outputDir, "premortem.md"), "utf8");
    expect(playbook).toContain("Compromise pre-mortem");
    for (const value of SECRET_VALUES) expect(stdout + playbook).not.toContain(value);
  });

  it("fails loudly without somewhere to look or with a bad file", async () => {
    await expect(run("premortem")).rejects.toThrow(/--targets-file <json> or --root/);
    const bad = join(out, "bad.json");
    writeFileSync(bad, '{"cwd": "x"}');
    await expect(run("premortem", "--targets-file", bad)).rejects.toThrow(/must be a JSON array/);
    writeFileSync(bad, "[{}]");
    await expect(run("premortem", "--targets-file", bad)).rejects.toThrow(/cwd is required/);
    await expect(
      run("premortem", "--targets-file", bad, "--rank-by", "popularity"),
    ).rejects.toThrow();
  });
});
