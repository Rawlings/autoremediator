import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  generateText: vi.fn(),
  createModel: vi.fn(),
  resolveProvider: vi.fn(),
  detectPackageManager: vi.fn(),
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

import { runRemediationPipeline } from "./pipeline.js";

describe("runRemediationPipeline tool gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.resolveProvider.mockReturnValue("openai");
    mocked.createModel.mockResolvedValue({ modelId: "fake-model" });
    mocked.detectPackageManager.mockReturnValue("npm");
    mocked.generateText.mockResolvedValue({ text: "done" });
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
});