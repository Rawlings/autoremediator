/**
 * Maintainer VEX in the remediation pipeline: shown as evidence by default, a suppression only
 * when the policy sets trustMaintainerVex.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CveDetails } from "../../platform/types.js";
import { installFake, vexDocument } from "../../platform/maintainer-vex/__tests__/fixtures.js";

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
vi.mock("../../intelligence/sources/epss.js", () => ({ enrichWithEpss: async (d: CveDetails) => d }));
vi.mock("../tools/check-inventory.js", () => ({ checkInventoryTool: { execute: mockInventory } }));
vi.mock("./primary-strategy.js", () => ({ resolvePrimaryResult: mockPrimaryResult }));
vi.mock("./fallback.js", () => ({ shouldAttemptPatchFallback: () => false, tryPatchFallback: vi.fn() }));
vi.mock("./vulnerability-match.js", () => ({ findVulnerablePackages: mockFindVulnerable }));

import { runLocalRemediationPipeline } from "./run.js";
import { toCycloneDxVex } from "../../api/vex/index.js";

const CVE = "CVE-2026-1111";
const details: CveDetails = {
  id: CVE,
  summary: "Test vulnerability",
  severity: "HIGH",
  affectedPackages: [
    { name: "bad-dep", ecosystem: "npm", vulnerableRange: "<2.0.0", firstPatchedVersion: "2.0.0", source: "osv" },
  ],
  references: [],
};

let cwd: string;
beforeEach(() => {
  vi.clearAllMocks();
  cwd = mkdtempSync(join(tmpdir(), "run-maintainer-vex-"));
  installFake(cwd, { name: "bad-dep", version: "1.0.0" });
  installFake(cwd, {
    name: "lib",
    version: "2.0.0",
    dependencies: { "bad-dep": "^1.0.0" },
    vex: true,
    files: {
      "vex.openvex.json": vexDocument({ name: "lib", version: "2.0.0" }, [
        { vulnerability: CVE, subcomponents: ["pkg:npm/bad-dep"], impact: "Never calls the parser." },
      ]),
    },
  });
  mockOsv.mockResolvedValue(details);
  mockInventory.mockResolvedValue({
    packages: [
      { name: "lib", version: "2.0.0", type: "direct" },
      { name: "bad-dep", version: "1.0.0", type: "transitive" },
    ],
  });
  mockFindVulnerable.mockReturnValue([
    { installed: { name: "bad-dep", version: "1.0.0", type: "transitive" }, affected: details.affectedPackages[0] },
  ]);
  mockPrimaryResult.mockResolvedValue({
    result: {
      packageName: "bad-dep",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      strategy: "override",
      applied: true,
      dryRun: false,
      message: "overridden",
    },
  });
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writePolicy(text: string): void {
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "autoremediator.yml"), text);
}

describe("maintainer VEX in remediation", () => {
  it("by default shows the verdict as evidence and still remediates", async () => {
    const report = await runLocalRemediationPipeline(CVE, { cwd });

    expect(mockPrimaryResult).toHaveBeenCalledTimes(1);
    const [result] = report.results;
    expect(result).toMatchObject({ strategy: "override", applied: true });
    expect(result?.suppressedBy).toBeUndefined();
    expect(result?.maintainerVex).toEqual([
      expect.objectContaining({
        maintainer: { name: "lib", version: "2.0.0" },
        status: "not_affected",
        justification: "vulnerable_code_not_in_execute_path",
        subcomponent: true,
      }),
    ]);
    expect(report.sbom?.find((entry) => entry.name === "bad-dep")?.status).toBe("patched");
  });

  it("with trustMaintainerVex: false in the policy behaves exactly as by default", async () => {
    writePolicy("trustMaintainerVex: false\n");
    const report = await runLocalRemediationPipeline(CVE, { cwd });
    expect(mockPrimaryResult).toHaveBeenCalledTimes(1);
    expect(report.results[0]?.suppressedBy).toBeUndefined();
  });

  it("with trustMaintainerVex: true suppresses like a policy suppression, naming the maintainer", async () => {
    writePolicy("trustMaintainerVex: true\n");
    const report = await runLocalRemediationPipeline(CVE, { cwd });

    expect(mockPrimaryResult).not.toHaveBeenCalled();
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      packageName: "bad-dep",
      fromVersion: "1.0.0",
      strategy: "none",
      applied: false,
      suppressedBy: {
        justification: "not_affected",
        source: "maintainer-vex",
        notes: expect.stringContaining("lib@2.0.0"),
      },
      maintainerVex: [expect.objectContaining({ maintainer: { name: "lib", version: "2.0.0" } })],
    });
    expect(report.sbom?.find((entry) => entry.name === "bad-dep")?.status).toBe("suppressed");

    const vex = toCycloneDxVex(report).vulnerabilities[0]!;
    expect(vex.analysis.state).toBe("not_affected");
    expect(vex.analysis.justification).toBe("code_not_reachable");
    expect(vex.analysis.detail).toContain("Maintainer VEX, trusted by policy");
  });

  it("lists the maintainer's verdict in the CycloneDX output even when it is not trusted", async () => {
    const report = await runLocalRemediationPipeline(CVE, { cwd });
    const vex = toCycloneDxVex(report).vulnerabilities[0]!;
    expect(vex.analysis.state).toBe("resolved");
    expect(vex.properties).toEqual([
      {
        name: "autoremediator:maintainer-vex",
        value: "lib@2.0.0: not_affected (vulnerable_code_not_in_execute_path) for bad-dep@1.0.0",
      },
    ]);
  });

  it("never trusts a package's claim about itself, even with trustMaintainerVex", async () => {
    rmSync(join(cwd, "node_modules"), { recursive: true, force: true });
    installFake(cwd, {
      name: "bad-dep",
      version: "1.0.0",
      vex: true,
      files: {
        "vex.openvex.json": vexDocument({ name: "bad-dep", version: "1.0.0" }, [{ vulnerability: CVE }]),
      },
    });
    writePolicy("trustMaintainerVex: true\n");
    const report = await runLocalRemediationPipeline(CVE, { cwd });

    expect(mockPrimaryResult).toHaveBeenCalledTimes(1);
    expect(report.results[0]?.suppressedBy).toBeUndefined();
    expect(report.results[0]?.maintainerVex).toBeUndefined();
    expect(report.results[0]?.maintainerVexIgnored?.[0]?.reason).toContain("never accepted");
  });

  it("is not used when nothing installed ships a document", async () => {
    rmSync(join(cwd, "node_modules", "lib"), { recursive: true, force: true });
    writePolicy("trustMaintainerVex: true\n");
    const report = await runLocalRemediationPipeline(CVE, { cwd });
    expect(mockPrimaryResult).toHaveBeenCalledTimes(1);
    expect(report.results[0]?.maintainerVex).toBeUndefined();
  });

  it("rejects a non-boolean trustMaintainerVex in the policy", async () => {
    writePolicy("trustMaintainerVex: sometimes\n");
    await expect(runLocalRemediationPipeline(CVE, { cwd })).rejects.toThrow(/trustMaintainerVex/);
  });
});
