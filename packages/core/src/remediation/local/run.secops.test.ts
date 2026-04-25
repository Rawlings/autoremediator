/**
 * Tests for SecOps wiring in runLocalRemediationPipeline:
 *   - VEX suppression early-exit
 *   - Exploit signal flagging (KEV / EPSS)
 *   - SLA breach detection
 *   - Regression detection
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CveDetails } from "../../platform/types.js";

// ---------------------------------------------------------------------------
// Module mocks — use vi.hoisted() so refs are available inside factory scope
// ---------------------------------------------------------------------------

const { mockOsv, mockGhLookup, mockMergeGh, mockEnrichNvd, mockInventory, mockExploitSignal } =
  vi.hoisted(() => ({
    mockOsv: vi.fn(),
    mockGhLookup: vi.fn(),
    mockMergeGh: vi.fn((base: CveDetails) => base),
    mockEnrichNvd: vi.fn(async (d: CveDetails) => d),
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
  tryLocalPatchFallback: vi.fn(),
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
  mockGhLookup.mockResolvedValue([]);
  mockMergeGh.mockImplementation((base: CveDetails) => base);
  mockEnrichNvd.mockImplementation(async (d: CveDetails) => d);
  mockFindVulnerable.mockReturnValue([]);
  mockShouldFallback.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// VEX suppression early-exit
// ---------------------------------------------------------------------------

describe("VEX suppression", () => {
  it("exits early with suppressed summary when suppressionsFile contains active match", async () => {
    mockOsv.mockResolvedValue(makeOsvDetails());

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
      "utf8"
    );

    try {
      const result = await runLocalRemediationPipeline("CVE-2024-0001", {
        cwd: process.cwd(),
        suppressionsFile: suppFile,
      } as any);

      expect(result.results).toHaveLength(0);
      expect(result.vulnerablePackages).toHaveLength(0);
      expect(result.summary).toContain("suppressed");
      expect(result.summary).toContain("not_affected");
      // Inventory should NOT have been called
      expect(mockInventory).not.toHaveBeenCalled();
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
      })
    );
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
    mockExploitSignal.mockResolvedValue({ exploitSignalTriggered: false, reason: "Below threshold" });

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
      "utf8"
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
      "utf8"
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

describe("regression check", () => {
  const vulnerablePackage = {
    installed: { name: "vuln-pkg", version: "1.5.0", type: "direct" as const },
    affected: { name: "vuln-pkg", ecosystem: "npm" as const, vulnerableRange: ">=1.0.0 <2.0.0", firstPatchedVersion: "2.0.0", source: "osv" as const },
  };

  beforeEach(() => {
    mockOsv.mockResolvedValue(makeOsvDetails());
    mockInventory.mockResolvedValue({ packages: [{ name: "vuln-pkg", version: "1.5.0", type: "direct" }] });
    mockFindVulnerable.mockReturnValue([vulnerablePackage]);
    mockShouldFallback.mockReturnValue(false);
  });

  it("does not set regressionDetected when toVersion is outside the vulnerable range", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: { packageName: "vuln-pkg", fromVersion: "1.5.0", strategy: "version-bump", applied: true, dryRun: false, toVersion: "2.0.0" },
      steps: 1,
    });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      regressionCheck: true,
    } as any);

    expect(result.results[0]?.regressionDetected).toBeUndefined();
  });

  it("sets regressionDetected=true when toVersion is still inside the vulnerable range", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: { packageName: "vuln-pkg", fromVersion: "1.5.0", strategy: "version-bump", applied: true, dryRun: false, toVersion: "1.8.0" },
      steps: 1,
    });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      regressionCheck: true,
    } as any);

    expect(result.results[0]?.regressionDetected).toBe(true);
  });

  it("does not check regression when regressionCheck is false", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: { packageName: "vuln-pkg", fromVersion: "1.5.0", strategy: "version-bump", applied: true, dryRun: false, toVersion: "1.8.0" },
      steps: 1,
    });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      regressionCheck: false,
    } as any);

    // Even though toVersion is still in range, no regression flag when option is off
    expect(result.results[0]?.regressionDetected).toBeUndefined();
  });

  it("does not set regressionDetected when result was not applied", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: { packageName: "vuln-pkg", fromVersion: "1.5.0", strategy: "none", applied: false, dryRun: false },
      steps: 1,
    });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      regressionCheck: true,
    } as any);

    expect(result.results[0]?.regressionDetected).toBeUndefined();
  });

  it("blocks applied escalate disposition outcomes when containmentMode is enabled", async () => {
    mockPrimaryResult.mockResolvedValue({
      result: { packageName: "vuln-pkg", fromVersion: "1.5.0", strategy: "version-bump", applied: true, dryRun: false, toVersion: "2.0.0" },
      steps: 1,
    });
    mockExploitSignal.mockResolvedValue({ exploitSignalTriggered: true, reason: "KEV match" });

    const result = await runLocalRemediationPipeline("CVE-2024-0001", {
      cwd: process.cwd(),
      containmentMode: true,
      exploitSignalOverride: { kev: { mandatory: true } },
    } as any);

    expect(result.results[0]?.disposition).toBe("escalate");
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
      "utf8"
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
      "utf8"
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

