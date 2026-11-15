import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FreshnessReport } from "../../../api/index.js";
import { FreshnessRegistry } from "../../../features/freshness/testing/registry.js";
import { addMemory } from "../../../features/memory/index.js";
import { createProgram } from "../program.js";
import { renderFreshnessReport } from "./freshness.js";

// Real npm installs against a local registry: allow for a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const registry = new FreshnessRegistry();
let scratch: string;
let cwd: string;
let stdout: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "freshness-cli-"));
  await registry.start();
  for (const version of ["1.0.0", "1.3.0", "2.0.0"])
    await registry.publish({ name: "lib", version });
});
afterAll(async () => {
  await registry.stop();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  cwd = mkdtempSync(join(scratch, "app-"));
  writeFileSync(join(cwd, ".npmrc"), `registry=${registry.url}/\n`);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      private: true,
      dependencies: { lib: "1.0.0" },
    }),
  );
  await execa("npm", ["install", "--no-audit", "--no-fund"], { cwd });
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
});

const run = (...args: string[]) =>
  createProgram().parseAsync(["node", "autoremediator", "freshness", ...args]);
const policy = (yaml: string): void => {
  writeFileSync(join(cwd, "policy.yml"), yaml);
};

describe("autoremediator freshness", () => {
  it("prints a report: score, distances and the climb", async () => {
    policy("freshness:\n  maxMajorsBehind: 0\n");
    await run("--cwd", cwd, "--policy", join(cwd, "policy.yml"));
    expect(stdout).toContain("Freshness 60/100: 1 direct dependency, 0 current, 1 behind.");
    expect(stdout).toContain("Policy: maxMajorsBehind 0.");
    expect(stdout).toContain("lib 1.0.0 -> 2.0.0: 1 major (2 releases,");
    expect(stdout).toContain("PAST POLICY: 1 major behind (limit 0)");
    expect(stdout).toContain("lib: 1.0.0 -> 1.3.0 -> 2.0.0");
  }, 60_000);

  it("prints JSON that is the SDK report", async () => {
    policy("freshness:\n  maxMajorsBehind: 0\n");
    await run(
      "--cwd",
      cwd,
      "--policy",
      join(cwd, "policy.yml"),
      "--output-format",
      "json",
      "--assess",
    );
    const report = JSON.parse(stdout) as FreshnessReport;
    expect(report.schemaVersion).toBe("1.0");
    expect(report.climbs[0]?.steps.map((step) => step.toVersion)).toEqual(["1.3.0", "2.0.0"]);
    // --assess rated the first step with the real analysis against the local registry.
    expect(report.climbs[0]?.assessment?.breakability).toMatch(/^(Low|Medium|High|Unknown)$/);
  }, 60_000);

  it("--plan records the next step and prints how to apply it, changing nothing", async () => {
    policy("allowMajorBumps: true\nfreshness:\n  maxMajorsBehind: 0\n");
    await run("--cwd", cwd, "--policy", join(cwd, "policy.yml"), "--plan", "--no-assess");
    expect(stdout).toMatch(/Planned step 1 of 2: lib 1\.0\.0 -> 1\.3\.0 \(minor\)\./);
    expect(stdout).toMatch(/autoremediator runs apply run_/);
    expect(
      (
        JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
          dependencies: Record<string, string>;
        }
      ).dependencies.lib,
    ).toBe("1.0.0");
  }, 60_000);

  it("--apply takes one step and exits 0", async () => {
    policy("allowMajorBumps: true\nfreshness:\n  maxMajorsBehind: 0\n");
    await run("--cwd", cwd, "--policy", join(cwd, "policy.yml"), "--apply", "--allow-high");
    expect(stdout).toMatch(
      /1 step\(s\) applied, 0 failed and rolled back; 1 package\(s\) still have steps to take\./,
    );
    expect(stdout).toContain("applied lib 1.0.0 -> 1.3.0");
    expect(process.exitCode).toBe(0);
  }, 120_000);

  it("leaves a package pinned in memory alone, and --ignore-memory plans it anyway", async () => {
    policy("freshness:\n  maxMajorsBehind: 0\n");
    await addMemory(cwd, { kind: "pinned-package", package: "lib", reason: "stay on 1.x" });
    await run("--cwd", cwd, "--policy", join(cwd, "policy.yml"));
    expect(stdout).toContain('Not planned: lib: Memory pins "lib": stay on 1.x');
    expect(stdout).not.toContain("Climb, safest first");

    stdout = "";
    await run("--cwd", cwd, "--policy", join(cwd, "policy.yml"), "--ignore-memory");
    expect(stdout).toContain("lib: 1.0.0 -> 1.3.0 -> 2.0.0");
  }, 60_000);

  it("explains that there is no limit to climb towards when the policy has no freshness key", async () => {
    await run("--cwd", cwd, "--apply");
    expect(stdout).toContain("no `freshness` key");
  }, 60_000);

  it("rejects flags that do not fit together before doing anything", async () => {
    await expect(run("--cwd", cwd, "--apply", "--plan")).rejects.toThrow(/not both/);
    await expect(run("--cwd", cwd, "--max-steps", "2")).rejects.toThrow(
      /--max-steps only apply with --plan or --apply/,
    );
    await expect(run("--cwd", cwd, "--apply", "--max-steps", "0")).rejects.toThrow(
      /whole number of at least 1/,
    );
    await expect(run("--cwd", cwd, "--apply", "--no-assess")).rejects.toThrow(
      /--no-assess only applies with --plan/,
    );
    await expect(
      run("--cwd", cwd, "--apply", "--change-request-provider", "gitlab"),
    ).rejects.toThrow(/require --create-change-request/);
    await expect(
      run("--cwd", cwd, "--apply", "--create-change-request", "--change-request-provider", "nope"),
    ).rejects.toThrow(/--change-request-provider must be one of/);
    await expect(run("--cwd", cwd, "--output-format", "yaml")).rejects.toThrow();
  });
});

describe("renderFreshnessReport", () => {
  const report: FreshnessReport = {
    schemaVersion: "1.0",
    generatedAt: "2026-06-01T00:00:00.000Z",
    cwd: "/x",
    packageManager: "npm",
    policy: { maxMajorsBehind: 1, ignore: ["a"] },
    score: 90,
    counts: {
      direct: 2,
      current: 1,
      behind: 1,
      ignored: 0,
      notInstalled: 0,
      unreadable: 0,
      exceeding: 0,
      unknownAge: 0,
    },
    packages: [
      {
        name: "b",
        field: "dependencies",
        range: "^1.0.0",
        installed: "1.0.0",
        latest: "1.2.0",
        status: "behind",
        majorsBehind: 0,
        minorsBehind: 2,
        patchesBehind: 0,
        exceeds: [],
      },
    ],
    climbs: [],
    unplanned: [{ packageName: "z", reason: "not on the registry" }],
    notes: ["a note"],
  };

  it("shows a package whose age limit could not be checked", () => {
    const text = renderFreshnessReport({
      ...report,
      packages: [
        { ...report.packages[0]!, unknownAge: "the registry lists no publish time for b 1.0.0" },
      ],
    });
    expect(text).toContain("AGE UNKNOWN: the registry lists no publish time for b 1.0.0");
  });

  it("lists the limits, the distances, what could not be planned and the notes", () => {
    const text = renderFreshnessReport(report);
    expect(text).toContain("Policy: maxMajorsBehind 1; ignoring a.");
    expect(text).toContain("b 1.0.0 -> 1.2.0: 2 minors");
    expect(text).toContain("Not planned: z: not on the registry");
    expect(text).toContain("Note: a note");
    expect(text).not.toContain("Climb");
  });
});
