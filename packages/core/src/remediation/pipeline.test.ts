import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPatchPrompt } from "./strategies/patch-synthesis-prompt.js";
import { accumulateStepResults } from "./strategies/pipeline-telemetry.js";

const mocked = vi.hoisted(() => ({
  generateText: vi.fn(),
  createModel: vi.fn(),
  resolveProvider: vi.fn(),
  estimateModelCostUsd: vi.fn(),
  getPatchConfidenceThreshold: vi.fn(),
  detectPackageManager: vi.fn(),
  lookupCveOsv: vi.fn(),
  lookupCveGitHub: vi.fn(),
  mergeGhDataIntoCveDetails: vi.fn(),
  enrichWithNvd: vi.fn(),
  resolveSafeUpgradeVersion: vi.fn(),
  checkInventoryExecute: vi.fn(),
  applyVersionBumpExecute: vi.fn(),
  applyPackageOverrideExecute: vi.fn(),
  fetchPackageSourceExecute: vi.fn(),
  generatePatchExecute: vi.fn(),
  applyPatchFileExecute: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: mocked.generateText,
  tool: (def: unknown) => def,
}));

vi.mock("../platform/config.js", () => ({
  createModel: mocked.createModel,
  resolveProvider: mocked.resolveProvider,
  estimateModelCostUsd: mocked.estimateModelCostUsd,
  getPatchConfidenceThreshold: mocked.getPatchConfidenceThreshold,
}));

vi.mock("../platform/package-manager.js", () => ({
  detectPackageManager: mocked.detectPackageManager,
}));

vi.mock("../intelligence/sources/osv.js", () => ({
  lookupCveOsv: mocked.lookupCveOsv,
}));

vi.mock("../intelligence/sources/github-advisory.js", () => ({
  lookupCveGitHub: mocked.lookupCveGitHub,
  mergeGhDataIntoCveDetails: mocked.mergeGhDataIntoCveDetails,
}));

vi.mock("../intelligence/sources/nvd.js", () => ({
  enrichWithNvd: mocked.enrichWithNvd,
}));

vi.mock("../intelligence/sources/registry.js", () => ({
  resolveSafeUpgradeVersion: mocked.resolveSafeUpgradeVersion,
}));

vi.mock("./tools/check-inventory.js", () => ({
  checkInventoryTool: { execute: mocked.checkInventoryExecute },
}));

vi.mock("./tools/apply-version-bump.js", () => ({
  applyVersionBumpTool: { execute: mocked.applyVersionBumpExecute },
}));

vi.mock("./tools/apply-package-override.js", () => ({
  applyPackageOverrideTool: { execute: mocked.applyPackageOverrideExecute },
}));

vi.mock("./tools/fetch-package-source.js", () => ({
  fetchPackageSourceTool: { execute: mocked.fetchPackageSourceExecute },
}));

vi.mock("./tools/generate-patch.js", () => ({
  generatePatchTool: { execute: mocked.generatePatchExecute },
}));

vi.mock("./tools/apply-patch-file.js", () => ({
  applyPatchFileTool: { execute: mocked.applyPatchFileExecute },
}));

import { runRemediationPipeline } from "./pipeline.js";

describe("runRemediationPipeline tool gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.resolveProvider.mockReturnValue("remote");
    mocked.estimateModelCostUsd.mockReturnValue(0.01);
    mocked.getPatchConfidenceThreshold.mockReturnValue(0.7);
    mocked.createModel.mockResolvedValue({ modelId: "fake-model" });
    mocked.detectPackageManager.mockReturnValue("npm");
    mocked.generateText.mockResolvedValue({ text: "done" });
    mocked.lookupCveGitHub.mockResolvedValue([]);
    mocked.mergeGhDataIntoCveDetails.mockImplementation((details: unknown) => details);
    mocked.enrichWithNvd.mockImplementation(async (details: unknown) => details);
    mocked.checkInventoryExecute.mockResolvedValue({ packages: [] });
    mocked.resolveSafeUpgradeVersion.mockResolvedValue({ safeVersion: undefined });
    mocked.fetchPackageSourceExecute.mockResolvedValue({ success: false, error: "source unavailable" });
    mocked.generatePatchExecute.mockResolvedValue({ success: false, error: "patch failed" });
    mocked.applyPatchFileExecute.mockResolvedValue({
      applied: false,
      dryRun: false,
      message: "apply failed",
    });
  });

  it("omits override and patch fallback tools when preferVersionBump is enabled", async () => {
    await runRemediationPipeline("CVE-2021-23337", {
      cwd: "/tmp/project",
      constraints: { preferVersionBump: true },
    });

    const call = mocked.generateText.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    expect(call.tools["apply-version-bump"]).toBeDefined();
    expect(call.tools["apply-package-override"]).toBeUndefined();
    expect(call.tools["fetch-package-source"]).toBeUndefined();
    expect(call.tools["generate-patch"]).toBeUndefined();
    expect(call.tools["apply-patch-file"]).toBeUndefined();
  });

  it("omits override tool when directDependenciesOnly is enabled", async () => {
    await runRemediationPipeline("CVE-2021-23337", {
      cwd: "/tmp/project",
      constraints: { directDependenciesOnly: true },
    });

    const call = mocked.generateText.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    expect(call.tools["apply-version-bump"]).toBeDefined();
    expect(call.tools["apply-package-override"]).toBeUndefined();
    expect(call.tools["fetch-package-source"]).toBeDefined();
    expect(call.tools["generate-patch"]).toBeDefined();
    expect(call.tools["apply-patch-file"]).toBeDefined();
  });

  it("uses patch fallback in local mode when no safe version exists", async () => {
    mocked.resolveProvider.mockReturnValue("local");
    mocked.lookupCveOsv.mockResolvedValue({
      id: "CVE-2021-23337",
      summary: "demo",
      severity: "HIGH",
      references: [],
      affectedPackages: [
        {
          name: "lodash",
          ecosystem: "npm",
          vulnerableRange: ">=4.0.0 <4.17.21",
          source: "osv",
        },
      ],
    });
    mocked.checkInventoryExecute.mockResolvedValue({
      packages: [{ name: "lodash", version: "4.17.0", type: "direct" }],
    });
    mocked.fetchPackageSourceExecute.mockResolvedValue({
      success: true,
      sourceFiles: { "index.js": "module.exports = {}\n" },
    });
    mocked.generatePatchExecute.mockResolvedValue({
      success: true,
      confidence: 0.95,
      patchContent: "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-module.exports = {}\n+module.exports = { safe: true }\n",
      patches: [
        {
          filePath: "index.js",
          unifiedDiff: "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-module.exports = {}\n+module.exports = { safe: true }\n",
        },
      ],
    });
    mocked.applyPatchFileExecute.mockResolvedValue({
      applied: true,
      dryRun: false,
      message: "patched",
      patchFilePath: "./patches/lodash.patch",
    });

    const report = await runRemediationPipeline("CVE-2021-23337", {
      cwd: "/tmp/project",
      llmProvider: "local",
    });

    expect(report.results[0]?.strategy).toBe("patch-file");
    expect(report.results[0]?.applied).toBe(true);
    expect(mocked.fetchPackageSourceExecute).toHaveBeenCalledTimes(1);
    expect(mocked.generatePatchExecute).toHaveBeenCalledTimes(1);
    expect(mocked.applyPatchFileExecute).toHaveBeenCalledTimes(1);
  });

  it("returns requires-llm-fallback when local fallback cannot create model", async () => {
    mocked.resolveProvider.mockReturnValue("local");
    mocked.lookupCveOsv.mockResolvedValue({
      id: "CVE-2021-23337",
      summary: "demo",
      severity: "HIGH",
      references: [],
      affectedPackages: [
        {
          name: "lodash",
          ecosystem: "npm",
          vulnerableRange: ">=4.0.0 <4.17.21",
          source: "osv",
        },
      ],
    });
    mocked.checkInventoryExecute.mockResolvedValue({
      packages: [{ name: "lodash", version: "4.17.0", type: "direct" }],
    });
    mocked.fetchPackageSourceExecute.mockResolvedValue({
      success: true,
      sourceFiles: { "index.js": "module.exports = {}\n" },
    });
    mocked.generatePatchExecute.mockResolvedValue({
      success: false,
      error: "AUTOREMEDIATOR_REMOTE_API_KEY environment variable is required",
    });

    const report = await runRemediationPipeline("CVE-2021-23337", {
      cwd: "/tmp/project",
      llmProvider: "local",
    });

    expect(report.results[0]?.strategy).toBe("none");
    expect(report.results[0]?.unresolvedReason).toBe("requires-llm-fallback");
  });

  it("uses configurable consensus provider and model for high-risk fallback patches", async () => {
    mocked.resolveProvider.mockReturnValue("local");
    mocked.lookupCveOsv.mockResolvedValue({
      id: "CVE-2021-23337",
      summary: "demo",
      severity: "HIGH",
      references: [],
      affectedPackages: [
        {
          name: "lodash",
          ecosystem: "npm",
          vulnerableRange: ">=4.0.0 <4.17.21",
          source: "osv",
        },
      ],
    });
    mocked.checkInventoryExecute.mockResolvedValue({
      packages: [{ name: "lodash", version: "4.17.0", type: "direct" }],
    });
    mocked.fetchPackageSourceExecute.mockResolvedValue({
      success: true,
      sourceFiles: { "index.js": "module.exports = {}\n" },
    });
    mocked.generatePatchExecute
      .mockResolvedValueOnce({
        success: true,
        llmProvider: "remote",
        llmModel: "claude-mythos-latest",
        riskLevel: "high",
        confidence: 0.96,
        patchContent:
          "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-module.exports = {}\n+module.exports = { safe: true }\n",
        patches: [
          {
            filePath: "index.js",
            unifiedDiff:
              "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-module.exports = {}\n+module.exports = { safe: true }\n",
          },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        llmProvider: "remote",
        llmModel: "claude-mythos-verifier",
        riskLevel: "high",
        confidence: 0.94,
        patches: [
          {
            filePath: "index.js",
            unifiedDiff:
              "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-module.exports = {}\n+module.exports = { safe: true }\n",
          },
        ],
      });
    mocked.applyPatchFileExecute.mockResolvedValue({
      applied: true,
      dryRun: false,
      message: "patched",
      patchFilePath: "./patches/lodash.patch",
    });

    const report = await runRemediationPipeline("CVE-2021-23337", {
      cwd: "/tmp/project",
      llmProvider: "local",
      requireConsensusForHighRisk: true,
      consensusProvider: "remote",
      consensusModel: "claude-mythos-verifier",
    });

    expect(report.results[0]?.strategy).toBe("patch-file");
    expect(mocked.generatePatchExecute).toHaveBeenCalledTimes(2);
    expect(mocked.generatePatchExecute.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        llmProvider: "remote",
        model: "claude-mythos-verifier",
      })
    );
  });

  it("uses per-risk confidence override when evaluating generated patch", async () => {
    mocked.getPatchConfidenceThreshold.mockReturnValue(0.95);
    mocked.resolveProvider.mockReturnValue("local");
    mocked.lookupCveOsv.mockResolvedValue({
      id: "CVE-2021-23337",
      summary: "demo",
      severity: "HIGH",
      references: [],
      affectedPackages: [
        {
          name: "lodash",
          ecosystem: "npm",
          vulnerableRange: ">=4.0.0 <4.17.21",
          source: "osv",
        },
      ],
    });
    mocked.checkInventoryExecute.mockResolvedValue({
      packages: [{ name: "lodash", version: "4.17.0", type: "direct" }],
    });
    mocked.fetchPackageSourceExecute.mockResolvedValue({
      success: true,
      sourceFiles: { "index.js": "module.exports = {}\n" },
    });
    mocked.generatePatchExecute.mockResolvedValue({
      success: true,
      llmProvider: "remote",
      llmModel: "claude-mythos-latest",
      riskLevel: "high",
      confidence: 0.91,
      patches: [
        {
          filePath: "index.js",
          unifiedDiff:
            "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-module.exports = {}\n+module.exports = { safe: true }\n",
        },
      ],
    });

    const report = await runRemediationPipeline("CVE-2021-23337", {
      cwd: "/tmp/project",
      llmProvider: "local",
      patchConfidenceThresholds: { high: 0.95 },
    });

    expect(report.results[0]?.strategy).toBe("none");
    expect(report.results[0]?.unresolvedReason).toBe("patch-confidence-too-low");
    expect(mocked.generatePatchExecute.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        patchConfidenceThresholds: { high: 0.95 },
      })
    );
  });
});

describe("buildPatchPrompt", () => {
  const baseParams = {
    cveId: "CVE-2021-23337",
    packageName: "lodash",
    vulnerableVersion: "4.17.20",
    vulnerabilityCategory: "redos",
    cveSummary: "Regular expression denial of service vulnerability in lodash.",
    sourceFiles: {
      "index.js": "module.exports = function value() { return true; }\n",
    },
  };

  it.each([
    ["analytical", "Provide concise analysis with explicit risk tradeoffs."],
    ["pragmatic", "Prioritize minimal, safe changes with low operational risk."],
    ["balanced", "Balance analytical explanation with practical remediation."],
    [undefined, "Balance analytical explanation with practical remediation."],
  ])("builds the expected prompt for personality %s", (modelPersonality, expectedDirective) => {
    const prompt = buildPatchPrompt({
      ...baseParams,
      modelPersonality,
    });

    expect(prompt.trim().length).toBeGreaterThan(0);
    expect(prompt).toContain("CVE-2021-23337");
    expect(prompt).toContain("lodash@4.17.20");
    expect(prompt).toContain("Regular Expression Denial of Service (ReDoS)");
    expect(prompt).toContain("### File: index.js");
    expect(prompt).toContain(expectedDirective);
  });
});

describe("accumulateStepResults", () => {
  it("accumulates results for each supported tool name", () => {
    const cveDetails = { id: "CVE-2021-23337" } as any;
    const vulnerablePackage = {
      installed: { name: "lodash", version: "4.17.20", type: "direct" },
    } as any;
    const patchArtifact = { confidence: 0.92, riskLevel: "medium" };

    const result = accumulateStepResults({
      toolResults: [
        { toolName: "lookup-cve", result: { data: cveDetails } },
        {
          toolName: "check-version-match",
          result: { vulnerablePackages: [vulnerablePackage] },
        },
        {
          toolName: "apply-version-bump",
          result: { packageName: "lodash", strategy: "version-bump", applied: true },
        },
        {
          toolName: "apply-package-override",
          result: { packageName: "lodash", strategy: "package-override", applied: true },
        },
        {
          toolName: "apply-patch-file",
          result: {
            packageName: "lodash",
            vulnerableVersion: "4.17.20",
            patchFilePath: "./patches/lodash.patch",
            patchArtifact,
            applied: true,
            dryRun: false,
            message: "patched",
            validation: { passed: true },
          },
        },
      ],
      cveDetails: null,
      vulnerablePackages: [],
      collectedResults: [],
      getDependencyScope: (packageName) => (packageName === "lodash" ? "direct" : undefined),
    });

    expect(result.cveDetails).toBe(cveDetails);
    expect(result.vulnerablePackages).toEqual([vulnerablePackage]);
    expect(result.collectedResults).toHaveLength(3);
    expect(result.collectedResults[0]).toEqual(
      expect.objectContaining({
        packageName: "lodash",
        strategy: "version-bump",
        dependencyScope: "direct",
      })
    );
    expect(result.collectedResults[1]).toEqual(
      expect.objectContaining({
        packageName: "lodash",
        strategy: "package-override",
        dependencyScope: "direct",
      })
    );
    expect(result.collectedResults[2]).toEqual(
      expect.objectContaining({
        packageName: "lodash",
        strategy: "patch-file",
        patchFilePath: "./patches/lodash.patch",
        dependencyScope: "direct",
        confidence: 0.92,
        riskLevel: "medium",
      })
    );
  });

  it("records validation failure when apply-patch-file does not apply", () => {
    const result = accumulateStepResults({
      toolResults: [
        {
          toolName: "apply-patch-file",
          result: {
            packageName: "lodash",
            vulnerableVersion: "4.17.20",
            applied: false,
            dryRun: false,
            error: "validation failed",
            validation: { passed: false, error: "tests failed" },
          },
        },
      ],
      cveDetails: null,
      vulnerablePackages: [],
      collectedResults: [],
      getDependencyScope: () => "transitive",
    });

    expect(result.collectedResults[0]).toEqual(
      expect.objectContaining({
        strategy: "patch-file",
        unresolvedReason: "patch-validation-failed",
        dependencyScope: "transitive",
        message: "validation failed",
        validation: { passed: false, error: "tests failed" },
      })
    );
  });
});