/**
 * The planner and what the repository remembers: real memory files in real temp directories, with
 * only the network and package-manager stages replaced.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMemory } from "../../platform/memory/index.js";
import type { CveDetails } from "../../platform/types.js";
import { buildPlan } from "../../runs/plan.js";

const { mockOsv, mockInventory, mockPrimaryResult, mockFindVulnerable } = vi.hoisted(() => ({
  mockOsv: vi.fn(),
  mockInventory: vi.fn(),
  mockPrimaryResult: vi.fn(),
  mockFindVulnerable: vi.fn(),
}));

vi.mock("../../intelligence/sources/osv.js", () => ({ lookupCveOsv: mockOsv }));
vi.mock("../../intelligence/sources/github-advisory.js", () => ({
  lookupCveGitHub: vi.fn(async () => []),
  mergeGhDataIntoCveDetails: (base: CveDetails) => base,
}));
vi.mock("../../intelligence/sources/nvd.js", () => ({ enrichWithNvd: async (d: CveDetails) => d }));
vi.mock("../../intelligence/sources/cisa-kev.js", () => ({
  enrichWithCisaKev: async (d: CveDetails) => d,
}));
vi.mock("../../intelligence/sources/epss.js", () => ({
  enrichWithEpss: async (d: CveDetails) => d,
}));
vi.mock("../tools/check-inventory.js", () => ({ checkInventoryTool: { execute: mockInventory } }));
vi.mock("./primary-strategy.js", () => ({ resolvePrimaryResult: mockPrimaryResult }));
vi.mock("./vulnerability-match.js", () => ({ findVulnerablePackages: mockFindVulnerable }));

import { runLocalRemediationPipeline } from "./run.js";

const details: CveDetails = {
  id: "CVE-2024-0001",
  summary: "Test vulnerability",
  severity: "HIGH",
  references: [],
  affectedPackages: [
    {
      name: "vuln-pkg",
      ecosystem: "npm",
      vulnerableRange: "<2.0.0",
      firstPatchedVersion: "2.0.0",
      source: "osv",
    },
  ],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-memory-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app" }));
  vi.clearAllMocks();
  mockOsv.mockResolvedValue(details);
  mockInventory.mockResolvedValue({
    packages: [{ name: "vuln-pkg", version: "1.0.0", type: "direct" }],
  });
  mockFindVulnerable.mockReturnValue([
    {
      installed: { name: "vuln-pkg", version: "1.0.0", type: "direct" },
      affected: details.affectedPackages[0],
    },
  ]);
  mockPrimaryResult.mockResolvedValue({
    result: {
      packageName: "vuln-pkg",
      strategy: "version-bump",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      applied: false,
      dryRun: true,
      message: "planned",
    },
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (options: Record<string, unknown> = {}) =>
  runLocalRemediationPipeline("CVE-2024-0001", { cwd: dir, dryRun: true, ...options } as never);

describe("a pinned package", () => {
  beforeEach(async () => {
    await addMemory(dir, {
      kind: "pinned-package",
      package: "vuln-pkg",
      reason: "v2 drops the callback API we use",
      source: "human:ana",
    });
  });

  it("is not touched, and the result says which entry and why", async () => {
    const report = await run();
    expect(mockPrimaryResult).not.toHaveBeenCalled();
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      packageName: "vuln-pkg",
      applied: false,
      strategy: "none",
      unresolvedReason: "constraint-blocked",
    });
    expect(report.results[0]?.message).toMatch(
      /Memory pins "vuln-pkg": v2 drops the callback API we use \(mem_[0-9a-f]{10}, human:ana\)/,
    );
    expect(report.results[0]?.message).toContain("--ignore-memory");
  });

  it("shows up in the plan as a finding the plan cannot act on, with the reason", async () => {
    const report = await run();
    const plan = buildPlan({
      runId: "run_abcdefghij0123456789",
      cwd: dir,
      report,
      base: {} as never,
      options: {},
    });
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({
      packageName: "vuln-pkg",
      unresolvedReason: "constraint-blocked",
    });
    expect(plan.skipped[0]?.reason).toContain("v2 drops the callback API we use");
  });

  it("is planned as usual with ignoreMemory", async () => {
    const report = await run({ ignoreMemory: true });
    expect(mockPrimaryResult).toHaveBeenCalledOnce();
    expect(report.results[0]?.strategy).toBe("version-bump");
  });

  it("does not count when it is only proposed, or has expired", async () => {
    rmSync(join(dir, ".autoremediator"), { recursive: true });
    await addMemory(dir, {
      kind: "pinned-package",
      package: "vuln-pkg",
      reason: "an agent thinks so",
      status: "proposed",
      source: "agent",
    });
    await run();
    expect(mockPrimaryResult).toHaveBeenCalledOnce();

    mockPrimaryResult.mockClear();
    rmSync(join(dir, ".autoremediator"), { recursive: true });
    mkdirSync(join(dir, ".autoremediator"));
    writeFileSync(
      join(dir, ".autoremediator", "memory.md"),
      '```autoremediator-memory\n{"kind":"pinned-package","status":"active","package":"vuln-pkg","reason":"was true once","source":"human","createdAt":"2025-01-01T00:00:00.000Z","expiresAt":"2025-06-01T00:00:00.000Z"}\n```\n',
    );
    await run();
    expect(mockPrimaryResult).toHaveBeenCalledOnce();
  });
});

describe("rejected upgrades", () => {
  it("are handed to the strategy as versions not to propose, keyed to the package", async () => {
    await addMemory(dir, {
      kind: "rejected-upgrade",
      package: "vuln-pkg",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      reason: "tests broke",
      source: "human:ana",
    });
    await addMemory(dir, {
      kind: "rejected-upgrade",
      package: "other-pkg",
      toVersion: "9.0.0",
      reason: "not this package",
    });

    await run();
    const params = mockPrimaryResult.mock.calls[0]?.[0] as {
      rejectedVersions: Map<string, string>;
    };
    expect([...params.rejectedVersions.keys()]).toEqual(["2.0.0"]);
    expect(params.rejectedVersions.get("2.0.0")).toMatch(
      /vuln-pkg@2\.0\.0 was rejected earlier: tests broke \(mem_[0-9a-f]{10}, human:ana, \d{4}-\d{2}-\d{2}\)/,
    );

    mockPrimaryResult.mockClear();
    await run({ ignoreMemory: true });
    const ignored = mockPrimaryResult.mock.calls[0]?.[0] as {
      rejectedVersions: Map<string, string>;
    };
    expect(ignored.rejectedVersions.size).toBe(0);
  });
});

describe("with no memory", () => {
  it("changes nothing and creates no file", async () => {
    await run();
    expect(mockPrimaryResult).toHaveBeenCalledOnce();
    await expect(
      import("node:fs").then((fs) => fs.existsSync(join(dir, ".autoremediator"))),
    ).resolves.toBe(false);
  });
});
