import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  generateText: vi.fn(),
  createModel: vi.fn(),
  resolveProvider: vi.fn(),
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
    mocked.resolveProvider.mockReturnValue("openai");
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
      error: "OPENAI_API_KEY environment variable is required",
    });

    const report = await runRemediationPipeline("CVE-2021-23337", {
      cwd: "/tmp/project",
      llmProvider: "local",
    });

    expect(report.results[0]?.strategy).toBe("none");
    expect(report.results[0]?.unresolvedReason).toBe("requires-llm-fallback");
  });
});