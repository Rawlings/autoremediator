import { describe, expect, it, vi } from "vitest";
import { TOOLS, createMcpServer, handleToolCall } from "./server.js";

describe("mcp tool contracts", () => {
  it("includes planRemediation in exposed tools", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("planRemediation");
    expect(names).toContain("listPatchArtifacts");
    expect(names).toContain("inspectPatchArtifact");
    expect(names).toContain("validatePatchArtifact");
  });

  it("declares preview and correlation fields on remediate and scan tools", () => {
    const remediate = TOOLS.find((t) => t.name === "remediate");
    const scan = TOOLS.find((t) => t.name === "remediateFromScan");
    const plan = TOOLS.find((t) => t.name === "planRemediation");

    expect(remediate).toBeDefined();
    expect(scan).toBeDefined();
    expect(plan).toBeDefined();

    const remediateProps = remediate!.inputSchema.properties as Record<string, unknown>;
    const scanProps = scan!.inputSchema.properties as Record<string, unknown>;
    const planProps = plan!.inputSchema.properties as Record<string, unknown>;

    expect(remediateProps.preview).toBeDefined();
    expect(remediateProps.requestId).toBeDefined();
    expect(remediateProps.sessionId).toBeDefined();
    expect(remediateProps.parentRunId).toBeDefined();

    expect(scanProps.preview).toBeDefined();
    expect(scanProps.requestId).toBeDefined();
    expect(scanProps.sessionId).toBeDefined();
    expect(scanProps.parentRunId).toBeDefined();

    expect(planProps.requestId).toBeDefined();
    expect(planProps.sessionId).toBeDefined();
    expect(planProps.parentRunId).toBeDefined();
  });

  it("creates MCP server instance without auto-start side effects", () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  it("dispatches planRemediation calls through handler", async () => {
    const deps = {
      remediateFn: vi.fn(async () => ({ summary: "remediate" } as any)),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" } as any)),
      remediateFromScanFn: vi.fn(async () => ({ status: "ok" } as any)),
      listPatchArtifactsFn: vi.fn(async () => []),
      inspectPatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" } as any)),
      validatePatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" } as any)),
    };

    const result = await handleToolCall(
      "planRemediation",
      { cveId: "CVE-2021-23337", requestId: "req-1" },
      deps
    );

    expect(deps.planRemediationFn).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({ requestId: "req-1", source: "mcp" })
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("planned");
  });

  it("dispatches patch artifact calls through handler", async () => {
    const deps = {
      remediateFn: vi.fn(async () => ({ summary: "remediate" } as any)),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" } as any)),
      remediateFromScanFn: vi.fn(async () => ({ status: "ok" } as any)),
      listPatchArtifactsFn: vi.fn(async () => [{ patchFilePath: "./patches/foo.patch" }]),
      inspectPatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch", exists: true } as any)),
      validatePatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch", diffValid: true } as any)),
    };

    const list = await handleToolCall("listPatchArtifacts", { cwd: "/tmp/project" }, deps as any);
    const inspect = await handleToolCall("inspectPatchArtifact", { patchFilePath: "./patches/foo.patch" }, deps as any);
    const validate = await handleToolCall("validatePatchArtifact", { patchFilePath: "./patches/foo.patch" }, deps as any);

    expect(deps.listPatchArtifactsFn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/project" }));
    expect(deps.inspectPatchArtifactFn).toHaveBeenCalledWith("./patches/foo.patch", {});
    expect(deps.validatePatchArtifactFn).toHaveBeenCalledWith("./patches/foo.patch", {});
    expect(list.content[0]?.text).toContain("foo.patch");
    expect(inspect.content[0]?.text).toContain("exists");
    expect(validate.content[0]?.text).toContain("diffValid");
  });

  it("returns structured error for unknown tool", async () => {
    const result = await handleToolCall("does-not-exist", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });
});
