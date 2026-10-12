import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGeneratePatchExecute } = vi.hoisted(() => ({
  mockGeneratePatchExecute: vi.fn(),
}));

vi.mock("../tools/generate-patch/index.js", () => ({
  generatePatchTool: {
    execute: mockGeneratePatchExecute,
  },
}));

import { runConsensusGate } from "./consensus-gate.js";

describe("runConsensusGate authentic verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PRIMARY_PATCH_DIFF = `--- a/src/index.ts
+++ b/src/index.ts
@@ -10,3 +10,4 @@
 function parse(input: string) {
+  if (typeof input !== "string") throw new TypeError("Expected string");
   return JSON.parse(input);
 }
`;

  const MATCHING_SECONDARY_DIFF = `--- a/src/index.ts
+++ b/src/index.ts
@@ -10,3 +10,4 @@
 function parse(input: string) {
+  if (typeof input !== "string") throw new TypeError("Expected string");
   return JSON.parse(input);
 }
`;

  const DIVERGENT_SECONDARY_DIFF = `--- a/src/index.ts
+++ b/src/index.ts
@@ -10,3 +10,4 @@
 function parse(input: string) {
+  if (!input) return null;
   return JSON.parse(input);
 }
`;

  it("returns agreed=true when secondary model independently reproduces identical diff", async () => {
    mockGeneratePatchExecute.mockResolvedValue({
      success: true,
      patches: [{ filePath: "src/index.ts", unifiedDiff: MATCHING_SECONDARY_DIFF }],
      llmProvider: "remote",
      llmModel: "claude-mythos-verifier",
      latencyMs: 142,
      estimatedCostUsd: 0.02,
    });

    const verdict = await runConsensusGate({
      packageName: "lodash",
      vulnerableVersion: "4.17.20",
      cveId: "CVE-2021-23337",
      cveSummary: "Command injection vulnerability",
      sourceFiles: { "src/index.ts": "..." },
      cwd: "/tmp/project",
      llmProvider: "remote",
      consensusProvider: "remote",
      consensusModel: "claude-mythos-verifier",
      primaryPatches: [{ filePath: "src/index.ts", unifiedDiff: PRIMARY_PATCH_DIFF }],
    });

    expect(verdict.agreed).toBe(true);
    expect(verdict.provider).toBe("remote");
    expect(verdict.model).toBe("claude-mythos-verifier");
    expect(verdict.latencyMs).toBe(142);
    expect(verdict.estimatedCostUsd).toBe(0.02);
  });

  it("returns agreed=false with reason when secondary model produces divergent diff", async () => {
    mockGeneratePatchExecute.mockResolvedValue({
      success: true,
      patches: [{ filePath: "src/index.ts", unifiedDiff: DIVERGENT_SECONDARY_DIFF }],
      llmProvider: "local",
      llmModel: "deepseek-coder",
      latencyMs: 85,
    });

    const verdict = await runConsensusGate({
      packageName: "lodash",
      vulnerableVersion: "4.17.20",
      cveId: "CVE-2021-23337",
      cveSummary: "Command injection vulnerability",
      sourceFiles: { "src/index.ts": "..." },
      cwd: "/tmp/project",
      llmProvider: "remote",
      consensusProvider: "local",
      consensusModel: "deepseek-coder",
      primaryPatches: [{ filePath: "src/index.ts", unifiedDiff: PRIMARY_PATCH_DIFF }],
    });

    expect(verdict.agreed).toBe(false);
    expect(verdict.provider).toBe("local");
    expect(verdict.model).toBe("deepseek-coder");
    expect(verdict.reason).toBe("High-risk patch did not pass consensus verification.");
  });

  it("returns agreed=false when secondary patch generation fails", async () => {
    mockGeneratePatchExecute.mockResolvedValue({
      success: false,
      error: "Context window exceeded",
      llmProvider: "remote",
      llmModel: "gpt-4o",
      latencyMs: 50,
    });

    const verdict = await runConsensusGate({
      packageName: "pkg",
      vulnerableVersion: "1.0.0",
      cveId: "CVE-2026-0001",
      cveSummary: "overflow",
      sourceFiles: {},
      cwd: "/tmp/project",
      llmProvider: "remote",
      consensusProvider: "remote",
      primaryPatches: [{ filePath: "x.ts", unifiedDiff: PRIMARY_PATCH_DIFF }],
    });

    expect(verdict.agreed).toBe(false);
    expect(verdict.reason).toBe("Context window exceeded");
  });

  it("returns agreed=false when secondary patch output has no patches", async () => {
    mockGeneratePatchExecute.mockResolvedValue({
      success: true,
      patches: [],
      llmProvider: "remote",
      llmModel: "gpt-4o",
    });

    const verdict = await runConsensusGate({
      packageName: "pkg",
      vulnerableVersion: "1.0.0",
      cveId: "CVE-2026-0001",
      cveSummary: "overflow",
      sourceFiles: {},
      cwd: "/tmp/project",
      llmProvider: "remote",
      consensusProvider: "remote",
      primaryPatches: [{ filePath: "x.ts", unifiedDiff: PRIMARY_PATCH_DIFF }],
    });

    expect(verdict.agreed).toBe(false);
    expect(verdict.reason).toBe("Consensus could not compare patch output.");
  });

  it("propagates routing and safety options to patch generator execute", async () => {
    mockGeneratePatchExecute.mockResolvedValue({
      success: true,
      patches: [{ filePath: "src/index.ts", unifiedDiff: MATCHING_SECONDARY_DIFF }],
    });

    await runConsensusGate({
      packageName: "pkg",
      vulnerableVersion: "1.0.0",
      cveId: "CVE-2026-0001",
      cveSummary: "overflow",
      sourceFiles: { "src/index.ts": "..." },
      cwd: "/tmp/project",
      llmProvider: "remote",
      consensusProvider: "local",
      consensusModel: "qwen-2.5",
      modelPersonality: "analytical",
      providerSafetyProfile: "strict",
      patchConfidenceThresholds: { high: 0.98 },
      dynamicModelRouting: true,
      dynamicRoutingThresholdChars: 4000,
      primaryPatches: [{ filePath: "src/index.ts", unifiedDiff: PRIMARY_PATCH_DIFF }],
    });

    expect(mockGeneratePatchExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        llmProvider: "local",
        model: "qwen-2.5",
        modelPersonality: "analytical",
        providerSafetyProfile: "strict",
        patchConfidenceThresholds: { high: 0.98 },
        dynamicModelRouting: true,
        dynamicRoutingThresholdChars: 4000,
      }),
    );
  });
});
