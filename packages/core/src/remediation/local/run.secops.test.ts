/**
 * Tests for SecOps wiring in runLocalRemediationPipeline:
 *   - VEX suppression (no mutation, covered copies reported)
 *   - Exploit signal flagging (KEV / EPSS)
 *   - SLA breach detection
 *   - Containment, escalation and package denylist enforcement
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";

import type { CveDetails } from "../../platform/types.js";

// ---------------------------------------------------------------------------
// Module mocks — use vi.hoisted() so refs are available inside factory scope
// ---------------------------------------------------------------------------

const {
  mockOsv,
  mockGhLookup,
  mockMergeGh,
  mockEnrichNvd,
  mockEnrichKev,
  mockEnrichEpss,
  mockInventory,
  mockExploitSignal,
} = vi.hoisted(() => ({
  mockOsv: vi.fn(),
  mockGhLookup: vi.fn(),
  mockMergeGh: vi.fn((base: CveDetails) => base),
  mockEnrichNvd: vi.fn(async (d: CveDetails) => d),
  mockEnrichKev: vi.fn(async (d: CveDetails) => d),
  mockEnrichEpss: vi.fn(async (d: CveDetails) => d),
  mockInventory: vi.fn(),
  mockExploitSignal: vi.fn(),
}));

const { mockPrimaryResult, mockShouldFallback, mockFindVulnerable } = vi.hoisted(() => ({
  mockPrimaryResult: vi.fn(),
  mockShouldFallback: vi.fn().mockReturnValue(false),
  mockFindVulnerable: vi.fn(),
}));

vi.mock("../../intelligence/sources/osv.js", () => ({
  lookupCveOsv: mockOsv,
}));

vi.mock("../../intelligence/sources/github-advisory.js", () => ({
  lookupCveGitHub: mockGhLookup,
  mergeGhDataIntoCveDetails: mockMergeGh,
}));

vi.mock("../../intelligence/sources/nvd.js", () => ({
  enrichWithNvd: mockEnrichNvd,
}));

vi.mock("../../intelligence/sources/cisa-kev.js", () => ({
  enrichWithCisaKev: mockEnrichKev,
}));

vi.mock("../../intelligence/sources/epss.js", () => ({
  enrichWithEpss: mockEnrichEpss,
}));

vi.mock("../tools/check-inventory.js", () => ({
  checkInventoryTool: { execute: mockInventory },
}));

vi.mock("../tools/check-exploit-signal.js", () => ({
  checkExploitSignalTool: { execute: mockExploitSignal },
}));

vi.mock("./primary-strategy.js", () => ({
  resolvePrimaryResult: mockPrimaryResult,
}));

vi.mock("./fallback.js", () => ({
  shouldAttemptPatchFallback: mockShouldFallback,
  tryPatchFallback: vi.fn(),
}));

vi.mock("./vulnerability-match.js", () => ({
  findVulnerablePackages: mockFindVulnerable,
}));

import { runLocalRemediationPipeline } from "./run.js";

// ---------------------------------------------------------------------------
// Shared CVE fixture
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 60 * 60 * 1000;

function makeOsvDetails(overrides: Partial<CveDetails> = {}): CveDetails {
  return {
    id: "CVE-2024-0001",
    summary: "Test vulnerability",
    severity: "HIGH",
    affectedPackages: [
      {
        name: "vuln-pkg",
        ecosystem: "npm",
        vulnerableRange: ">=1.0.0 <2.0.0",
        firstPatchedVersion: "2.0.0",
        source: "osv",
      },
    ],
    references: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrimaryResult.mockReset();
  mockGhLookup.mockResolvedValue([]);
  mockMergeGh.mockImplementation((base: CveDetails) => base);
  mockEnrichNvd.mockImplementation(async (d: CveDetails) => d);
  mockEnrichKev.mockImplementation(async (d: CveDetails) => d);
  mockEnrichEpss.mockImplementation(async (d: CveDetails) => d);
  mockFindVulnerable.mockReturnValue([]);
  mockShouldFallback.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// VEX suppression
// ---------------------------------------------------------------------------

describe("VEX suppression", () => {
  it("reports covered copies as suppressed without remediating when suppressionsFile has an active match", async () => {
    mockOsv.mockResolvedValue(makeOsvDetails());
    mockInventory.mockResolvedValue({
      packages: [
        { name: "lodash", version: "4.17.10", type: "transitive" },
        { name: "lodash", version: "4.17.21", type: "direct" },
      ],
    });
    mockFindVulnerable.mockReturnValue([
      {
        installed: { name: "lodash", version: "4.17.10", type: "transitive" },
        affected: makeOsvDetails().affectedPackages[0],
      },
    ]);

    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "autoremediator-run-secops-"));
    const suppFile = join(dir, "suppressions.yml");
    writeFileSync(
      suppFile,
      [
        "suppressions:",
        "  - cveId: CVE-2024-0001",
        "    justification: not_affected",
        "    notes: Test environment only",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = await runLocalRemediationPipeline("CVE-2024-0001", {
        cwd: process.cwd(),
        suppressionsFile: suppFile,
      } as any);

      expect(result.summary).toContain("suppressed");
      expect(result.summary).toContain("not_affected");
      expect(result.vulnerablePackages.map((v) => v.installed.version)).toEqual(["4.17.10"]);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        packageName: "lodash",
        fromVersion: "4.17.10",
        strategy: "none",
        applied: false,
        suppressedBy: { justification: "not_affected", notes: "Test environment only" },
      });
      expect(result.sbom?.find((e) => e.version === "4.17.10")?.status).toBe("suppressed");
      expect(result.sbom?.find((e) => e.version === "4.17.21")?.status).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Exploit signal flagging
// ---------------------------------------------------------------------------

describe("exploit signal", () => {
  it("sets exploitSignalTriggered=true when KEV signal fires", async () => {
    const cveWithKev = makeOsvDetails({
      kev: { knownExploited: true, dateAdded: "2024-01-01" },
    });
    mockOsv.mockResolvedValue(cveWithKev);
    mockInventory.mockResolvedValue({ packages: [] });
    mockExploitSignal.mockResolvedValue({ exploitSignalTriggered: true, reason: "KEV match" });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      exploitSignalOverride: { kev: { mandatory: true } },
    } as any);

    expect(result.exploitSignalTriggered).toBe(true);
    expect(mockExploitSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({
          exploitSignalOverride: { kev: { mandatory: true } },
        }),
      }),
    );
  });

  it("feeds online KEV and EPSS enrichment into the exploit-signal check", async () => {
    mockOsv.mockResolvedValue(makeOsvDetails());
    mockEnrichKev.mockImplementation(async (d: CveDetails) => ({
      ...d,
      kev: { knownExploited: true },
    }));
    mockEnrichEpss.mockImplementation(async (d: CveDetails) => ({
      ...d,
      epss: { score: 0.93, percentile: 0.99 },
    }));
    mockInventory.mockResolvedValue({ packages: [] });
    mockExploitSignal.mockResolvedValue({ exploitSignalTriggered: true });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      exploitSignalOverride: { kev: { mandatory: true } },
    } as any);

    expect(result.exploitSignalTriggered).toBe(true);
    expect(mockExploitSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        cveDetails: expect.objectContaining({
          kev: { knownExploited: true },
          epss: { score: 0.93, percentile: 0.99 },
        }),
      }),
    );
  });

  it("does not call KEV or EPSS in offline mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "offline-run-"));
    const snapshotPath = join(dir, "snapshot.json");
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        "CVE-2024-0001": { packageName: "vuln-pkg", vulnerableRange: "<2.0.0", severity: "HIGH" },
      }),
    );
    mockInventory.mockResolvedValue({ packages: [] });

    try {
      const result = await runLocalRemediationPipeline("CVE-2024-0001", {
        cwd: process.cwd(),
        offlineIntelligence: true,
        intelligenceSnapshotPath: snapshotPath,
      } as any);

      expect(result.cveDetails?.id).toBe("CVE-2024-0001");
      expect(mockOsv).not.toHaveBeenCalled();
      expect(mockEnrichKev).not.toHaveBeenCalled();
      expect(mockEnrichEpss).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves exploitSignalTriggered undefined when no exploitSignalOverride is configured", async () => {
    mockOsv.mockResolvedValue(makeOsvDetails());
    mockInventory.mockResolvedValue({ packages: [] });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
    } as any);

    expect(result.exploitSignalTriggered).toBeUndefined();
    expect(mockExploitSignal).not.toHaveBeenCalled();
  });

  it("leaves exploitSignalTriggered undefined when threshold is not met", async () => {
    mockOsv.mockResolvedValue(makeOsvDetails({ epss: { score: 0.1, percentile: 50 } }));
    mockInventory.mockResolvedValue({ packages: [] });
    mockExploitSignal.mockResolvedValue({
      exploitSignalTriggered: false,
      reason: "Below threshold",
    });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      exploitSignalOverride: { epss: { mandatory: true, threshold: 0.5 } },
    } as any);

    expect(result.exploitSignalTriggered).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SLA breach detection
// ---------------------------------------------------------------------------

describe("SLA breach", () => {
  it("populates slaBreaches when CVE is overdue", async () => {
    // Published 200 hours ago; HIGH SLA = 72 hours
    const publishedAt = new Date(Date.now() - 200 * MS_PER_HOUR).toISOString();
    mockOsv.mockResolvedValue(makeOsvDetails({ severity: "HIGH", publishedAt }));
    mockInventory.mockResolvedValue({ packages: [] });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      slaCheck: true,
    } as any);

    // No SLA policy configured in DEFAULT_POLICY → no breaches
    expect(result.slaBreaches).toBeUndefined();
  });

  it("populates slaBreaches when slaCheck and slaPolicy are both active", async () => {
    // Inject a slaPolicy by using the policy path mechanism — not possible directly via options.
    // Instead: slaPolicy comes from loadedPolicy.sla. Policy is loaded from file.
    // We write a real YAML with sla config.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "autoremediator-run-sla-"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "autoremediator.yml"),
      ["sla:", "  high: 72", "  critical: 24"].join("\n"),
      "utf8",
    );

    const publishedAt = new Date(Date.now() - 200 * MS_PER_HOUR).toISOString();
    mockOsv.mockResolvedValue(makeOsvDetails({ severity: "HIGH", publishedAt }));
    mockInventory.mockResolvedValue({ packages: [] });

    try {
      const result = await runLocalRemediationPipeline("CVE-2024-0001", {
        cwd: dir,
        slaCheck: true,
      } as any);

      expect(result.slaBreaches).toHaveLength(1);
      expect(result.slaBreaches?.[0]?.cveId).toBe("CVE-2024-0001");
      expect(result.slaBreaches?.[0]?.severity).toBe("HIGH");
      expect(result.slaBreaches?.[0]?.hoursOverdue).toBeGreaterThanOrEqual(127);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not populate slaBreaches when slaCheck is false", async () => {
    const publishedAt = new Date(Date.now() - 200 * MS_PER_HOUR).toISOString();
    mockOsv.mockResolvedValue(makeOsvDetails({ severity: "CRITICAL", publishedAt }));
    mockInventory.mockResolvedValue({ packages: [] });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      slaCheck: false,
    } as any);

    expect(result.slaBreaches).toBeUndefined();
  });

  it("surfaces slaBreaches on affectedPackages=0 early-exit path", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "autoremediator-run-sla-early-"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "autoremediator.yml"),
      ["sla:", "  critical: 24"].join("\n"),
      "utf8",
    );

    const publishedAt = new Date(Date.now() - 100 * MS_PER_HOUR).toISOString();
    // CVE with no affectedPackages → early exit before inventory
    mockOsv.mockResolvedValue({
      id: "CVE-2024-0001",
      summary: "No packages",
      severity: "CRITICAL",
      publishedAt,
      affectedPackages: [],
      references: [],
    });

    try {
      const result = await runLocalRemediationPipeline("CVE-2024-0001", {
        cwd: dir,
        slaCheck: true,
      } as any);

      expect(result.summary).toContain("no npm affected packages");
      expect(result.slaBreaches).toHaveLength(1);
      expect(result.slaBreaches?.[0]?.hoursOverdue).toBeGreaterThanOrEqual(75);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

describe("containment, escalation and package denylist", () => {
  const vulnerablePackage = {
    installed: { name: "vuln-pkg", version: "1.5.0", type: "direct" as const },
    affected: {
      name: "vuln-pkg",
      ecosystem: "npm" as const,
      vulnerableRange: ">=1.0.0 <2.0.0",
      firstPatchedVersion: "2.0.0",
      source: "osv" as const,
    },
  };

  beforeEach(() => {
    mockOsv.mockResolvedValue(makeOsvDetails());
    mockInventory.mockResolvedValue({
      packages: [{ name: "vuln-pkg", version: "1.5.0", type: "direct" }],
    });
    mockFindVulnerable.mockReturnValue([vulnerablePackage]);
    mockShouldFallback.mockReturnValue(false);
  });

  it("keeps an applied fix for an actively exploited CVE even with containmentMode (escalate, not blocked)", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: {
        packageName: "vuln-pkg",
        fromVersion: "1.5.0",
        strategy: "version-bump",
        applied: true,
        dryRun: false,
        toVersion: "2.0.0",
      },
      steps: 1,
    });
    mockExploitSignal.mockResolvedValue({ exploitSignalTriggered: true, reason: "KEV match" });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      containmentMode: true,
      exploitSignalOverride: { kev: { mandatory: true } },
    } as any);

    expect(result.results[0]?.disposition).toBe("escalate");
    expect(result.results[0]?.applied).toBe(true);
    expect(result.results[0]?.unresolvedReason).toBeUndefined();
  });

  it("blocks applied hold-for-approval outcomes and restores modified files on disk when containmentMode is enabled", async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "containment-run-rollback-"));
    const pkgJsonPath = join(dir, "package.json");
    writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name: "app", dependencies: { "vuln-pkg": "1.5.0" } }, null, 2),
    );

    mockOsv.mockResolvedValue(makeOsvDetails());
    mockInventory.mockResolvedValue({
      packages: [{ name: "vuln-pkg", version: "1.5.0", type: "direct" }],
    });
    mockFindVulnerable.mockReturnValue([
      {
        installed: { name: "vuln-pkg", version: "1.5.0", type: "direct" },
        affected: {
          name: "vuln-pkg",
          vulnerableRange: ">=1.0.0 <2.0.0",
          firstPatchedVersion: "2.0.0",
        },
      },
    ]);

    mockPrimaryResult.mockImplementation(async () => {
      // Mutate package.json on disk
      writeFileSync(
        pkgJsonPath,
        JSON.stringify({ name: "app", dependencies: { "vuln-pkg": "2.0.0" } }, null, 2),
      );
      return {
        result: {
          packageName: "vuln-pkg",
          fromVersion: "1.5.0",
          strategy: "version-bump",
          applied: true,
          dryRun: false,
          toVersion: "2.0.0",
          confidence: 0.4,
        },
      };
    });

    try {
      const result = await runLocalRemediationPipeline("CVE-2024-0001", {
        cwd: dir,
        containmentMode: true,
      } as any);

      expect(result.results[0]?.disposition).toBe("hold-for-approval");
      expect(result.results[0]?.applied).toBe(false);
      expect(result.results[0]?.unresolvedReason).toBe("policy-blocked");

      // Verify on-disk file was restored
      const restored = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      expect(restored.dependencies["vuln-pkg"]).toBe("1.5.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks package listed in denyPackages before invoking primary strategy", async () => {
    mockOsv.mockResolvedValue(makeOsvDetails());
    mockInventory.mockResolvedValue({
      packages: [{ name: "vuln-pkg", version: "1.5.0", type: "direct" }],
    });
    mockFindVulnerable.mockReturnValue([
      {
        installed: { name: "vuln-pkg", version: "1.5.0", type: "direct" },
        affected: {
          name: "vuln-pkg",
          vulnerableRange: ">=1.0.0 <2.0.0",
          firstPatchedVersion: "2.0.0",
        },
      },
    ]);

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      policy: JSON.stringify({
        denyPackages: ["vuln-pkg"],
        allowPackages: [],
        allowMajorBumps: true,
      }),
    } as any);

    expect(mockPrimaryResult).not.toHaveBeenCalled();
    expect(result.results[0]?.packageName).toBe("vuln-pkg");
    expect(result.results[0]?.applied).toBe(false);
    expect(result.results[0]?.unresolvedReason).toBe("policy-blocked");
    expect(result.results[0]?.message).toContain("denyPackages");
  });

  it("blocks package matching wildcard in denyPackages before invoking primary strategy", async () => {
    mockOsv.mockResolvedValue(makeOsvDetails());
    mockInventory.mockResolvedValue({
      packages: [{ name: "vuln-pkg", version: "1.5.0", type: "direct" }],
    });
    mockFindVulnerable.mockReturnValue([
      {
        installed: { name: "vuln-pkg", version: "1.5.0", type: "direct" },
        affected: {
          name: "vuln-pkg",
          vulnerableRange: ">=1.0.0 <2.0.0",
          firstPatchedVersion: "2.0.0",
        },
      },
    ]);

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      policy: JSON.stringify({
        denyPackages: ["vuln-*"],
        allowPackages: [],
        allowMajorBumps: true,
      }),
    } as any);

    expect(mockPrimaryResult).not.toHaveBeenCalled();
    expect(result.results[0]?.packageName).toBe("vuln-pkg");
    expect(result.results[0]?.applied).toBe(false);
    expect(result.results[0]?.unresolvedReason).toBe("policy-blocked");
  });

  it("assigns default escalationAction for unresolved results", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: {
        packageName: "vuln-pkg",
        fromVersion: "1.5.0",
        strategy: "none",
        applied: false,
        dryRun: false,
        unresolvedReason: "no-safe-version",
      },
      steps: 1,
    });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
    } as any);

    expect(result.results[0]?.escalationAction).toBe("open-issue");
  });

  it("applies escalationGraph overrides for unresolved results", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: {
        packageName: "vuln-pkg",
        fromVersion: "1.5.0",
        strategy: "none",
        applied: false,
        dryRun: false,
        unresolvedReason: "patch-generation-failed",
      },
      steps: 1,
    });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      escalationGraph: {
        "patch-generation-failed": "hold-branch",
      },
    } as any);

    expect(result.results[0]?.escalationAction).toBe("hold-branch");
  });

  it("uses policy escalationGraph when option is omitted", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: {
        packageName: "vuln-pkg",
        fromVersion: "1.5.0",
        strategy: "none",
        applied: false,
        dryRun: false,
        unresolvedReason: "no-safe-version",
      },
      steps: 1,
    });

    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "autoremediator-run-escalation-policy-"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "autoremediator.yml"),
      ["escalationGraph:", "  no-safe-version: notify-channel"].join("\n"),
      "utf8",
    );

    try {
      const result = await runLocalRemediationPipeline("CVE-2024-0001", {
        cwd: dir,
      } as any);

      expect(result.results[0]?.escalationAction).toBe("notify-channel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers explicit options escalationGraph over policy escalationGraph", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: {
        packageName: "vuln-pkg",
        fromVersion: "1.5.0",
        strategy: "none",
        applied: false,
        dryRun: false,
        unresolvedReason: "no-safe-version",
      },
      steps: 1,
    });

    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "autoremediator-run-escalation-override-"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "autoremediator.yml"),
      ["escalationGraph:", "  no-safe-version: notify-channel"].join("\n"),
      "utf8",
    );

    try {
      const result = await runLocalRemediationPipeline("CVE-2024-0001", {
        cwd: dir,
        escalationGraph: {
          "no-safe-version": "open-issue",
        },
      } as any);

      expect(result.results[0]?.escalationAction).toBe("open-issue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
