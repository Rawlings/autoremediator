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

describe("runConsensusGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns agreed=true when primary and consensus diffs match", async () => {
    const sharedDiff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    mockGeneratePatchExecute.mockResolvedValue({
      success: true,
      patches: [{ filePath: "x.ts", unifiedDiff: sharedDiff }],
      llmProvider: "remote",
      llmModel: "gpt-test",
      latencyMs: 123,
    });

    const verdict = await runConsensusGate({
      packageName: "pkg-a",
      vulnerableVersion: "1.0.0",
      cveId: "CVE-2026-0001",
      cveSummary: "summary",
      sourceFiles: { "x.ts": "a" },
      cwd: process.cwd(),
      llmProvider: "remote",
      consensusProvider: "remote",
      primaryPatches: [{ filePath: "x.ts", unifiedDiff: sharedDiff }],
    });

    expect(verdict).toMatchObject({
      agreed: true,
      provider: "remote",
      model: "gpt-test",
      latencyMs: 123,
    });
  });

  it("returns agreed=false when consensus diff mismatches", async () => {
    mockGeneratePatchExecute.mockResolvedValue({
      success: true,
      patches: [{ filePath: "x.ts", unifiedDiff: "diff --git a/x b/x\n" }],
      llmProvider: "local",
      llmModel: "local-test",
      latencyMs: 77,
    });

    const verdict = await runConsensusGate({
      packageName: "pkg-a",
      vulnerableVersion: "1.0.0",
      cveId: "CVE-2026-0001",
      cveSummary: "summary",
      sourceFiles: { "x.ts": "a" },
      cwd: process.cwd(),
      llmProvider: "remote",
      consensusProvider: "local",
      primaryPatches: [{ filePath: "x.ts", unifiedDiff: "different-diff" }],
    });

    expect(verdict).toMatchObject({
      agreed: false,
      provider: "local",
      model: "local-test",
      reason: "High-risk patch did not pass consensus verification.",
      latencyMs: 77,
    });
  });
});