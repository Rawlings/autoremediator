/**
 * Runs teach the repository's memory, from what the verifier established: real git repositories in
 * temp directories, the real verifier, only the package-manager calls replaced.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PatchResult, RemediationReport } from "../../platform/types.js";
import { verify } from "../../remediation/verify/verifier.js";
import { listMemory } from "../memory/index.js";
import { applyPlan, persistPlan, rollbackRun, type RunDeps, verifyRun } from "./index.js";

vi.mock("../../remediation/tools/check-inventory.js", () => ({
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
const setLodash = (version: string) =>
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", dependencies: { lodash: version } }, null, 2),
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-recording-"));
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  setLodash("4.17.20");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
  // Run state is ignored, but the memory file is meant to be committed: it shows in `git status`.
  writeFileSync(join(dir, ".gitignore"), ".autoremediator/*\n!.autoremediator/memory.md\n");
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

const entries = () => listMemory({ cwd: dir }).entries;

describe("what a rolled-back upgrade teaches memory", () => {
  it("records the rejected upgrade with the run and the check that failed", async () => {
    const { runId } = await persistPlan(preview, {}, dir);

    // The apply step claims success but lodash stays in the vulnerable range: the verifier rejects it.
    const outcome = await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("4.17.5")),
    );
    expect(outcome.items[0]?.verification?.failedCheck).toBe("vuln-gone");

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      kind: "rejected-upgrade",
      package: "lodash",
      fromVersion: "4.17.20",
      toVersion: "4.17.21",
      check: "vuln-gone",
      reason: "the verifier's vuln-gone check failed after the upgrade",
      source: runId,
      status: "active",
      state: "active",
    });
    const [entry] = entries();
    const days = (Date.parse(entry!.expiresAt!) - Date.parse(entry!.createdAt)) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });

  it("records the same rejection once, however often the run is retried", async () => {
    const { runId } = await persistPlan(preview, {}, dir);
    await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("4.17.5")),
    );
    await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("4.17.5")),
    );
    expect(entries()).toHaveLength(1);
  });

  it("does not remember rejections that are about rules rather than the upgrade", async () => {
    const { runId } = await persistPlan(preview, {}, dir);
    // The upgrade is fine but the change also writes a file a dependency change must not touch.
    const outcome = await applyPlan(
      { cwd: dir, runId },
      depsThat(() => {
        setLodash("4.17.21");
        writeFileSync(join(dir, "notes.txt"), "stray");
      }),
    );
    expect(outcome.items[0]?.verification?.failedCheck).toBe("scope");
    expect(entries()).toEqual([]);
  });

  it("does not remember an upgrade that stands", async () => {
    const { runId } = await persistPlan(preview, {}, dir);
    await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("4.17.21")),
    );
    expect(entries()).toEqual([]);
    expect(existsSync(join(dir, ".autoremediator", "memory.md"))).toBe(false);
  });
});

describe("what a passing test run teaches memory", () => {
  it("records the test command an applied item passed, with the run as its source", async () => {
    const { runId } = await persistPlan(preview, { runTests: true }, dir);
    await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("4.17.21")),
    );
    expect(entries()).toMatchObject([
      { kind: "test-command", command: "npm test", source: runId, status: "active" },
    ]);
  });

  it("records nothing about tests when tests were not part of the run", async () => {
    const { runId } = await persistPlan(preview, {}, dir);
    await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("4.17.21")),
    );
    expect(entries()).toEqual([]);
  });
});

describe("the memory file and the run machinery", () => {
  it("a file a run wrote is not a scope violation for the next verification, and a rollback keeps it", async () => {
    const { runId } = await persistPlan(preview, { runTests: true }, dir);
    await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("4.17.21")),
    );

    // It shows in git status, because the file is meant to be committed.
    expect(
      execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir }).toString(),
    ).toContain(".autoremediator/memory.md");
    const memoryBefore = readFileSync(join(dir, ".autoremediator", "memory.md"), "utf8");

    const verification = await verifyRun({ cwd: dir, runId, checks: ["scope"] });
    expect(verification.checks.find((check) => check.name === "scope")?.status).toBe("passed");

    await rollbackRun(
      { cwd: dir, runId, reinstall: false },
      depsThat(() => undefined),
    );
    expect(readFileSync(join(dir, ".autoremediator", "memory.md"), "utf8")).toBe(memoryBefore);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain("4.17.20");
  });

  it("leaves a person's prose and entries in the file untouched when a run adds to it", async () => {
    const prose = "# Our notes\n\nWe pin things on purpose.\n\n";
    const human = `{"kind":"pinned-package","status":"active","package":"left-pad","reason":"hand written","source":"human:ana","createdAt":"2026-01-01T00:00:00.000Z"}`;
    mkdirSync(join(dir, ".autoremediator"), { recursive: true });
    const file = join(dir, ".autoremediator", "memory.md");
    writeFileSync(
      file,
      `${prose}\`\`\`autoremediator-memory\n# keep this comment\n${human}\n\`\`\`\nClosing words.\n`,
    );

    const { runId } = await persistPlan(preview, {}, dir);
    await applyPlan(
      { cwd: dir, runId },
      depsThat(() => setLodash("4.17.5")),
    );

    const text = readFileSync(file, "utf8");
    expect(
      text.startsWith(`${prose}\`\`\`autoremediator-memory\n# keep this comment\n${human}\n{`),
    ).toBe(true);
    expect(text.endsWith("\n```\nClosing words.\n")).toBe(true);
    expect(entries().map((entry) => entry.kind)).toEqual(["pinned-package", "rejected-upgrade"]);
  });
});
