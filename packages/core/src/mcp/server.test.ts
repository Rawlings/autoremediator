import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TOOLS, createMcpServer, handleToolCall } from "./server.js";

describe("mcp tool contracts", () => {
  it("includes planRemediation in exposed tools", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("health");
    expect(names).toContain("planRemediation");
    expect(names).toContain("remediatePortfolio");
    expect(names).toContain("listPatchArtifacts");
    expect(names).toContain("inspectPatchArtifact");
    expect(names).toContain("validatePatchArtifact");
    expect(names).toContain("checkReachability");
    expect(names).toContain("evaluatePackage");
    expect(names).toContain("scanDelta");
  });

  it("dispatches health calls through handler", async () => {
    const deps = {
      remediateFn: vi.fn(async () => ({ summary: "remediate" }) as any),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" }) as any),
      remediateFromScanFn: vi.fn(async () => ({ status: "ok" }) as any),
      remediatePortfolioFn: vi.fn(async () => ({ status: "ok", targets: [] }) as any),
      updateOutdatedFn: vi.fn(async () => ({ status: "ok" }) as any),
      healthFn: vi.fn(async () => ({ status: "ok" as const })),
      listPatchArtifactsFn: vi.fn(async () => []),
      inspectPatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      validatePatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      toVexFn: vi.fn(() => ({ bomFormat: "CycloneDX" }) as any),
      submitRemediateJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitScanJobFn: vi.fn(() => ({
        jobId: "j2",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitPortfolioJobFn: vi.fn(() => ({
        jobId: "j3",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      pollJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "done",
        submittedAt: new Date().toISOString(),
        result: {},
      })),
    };

    const result = await handleToolCall("health", {}, deps as any);

    expect(deps.healthFn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("ok");
  });

  it("health response includes version, toolCount, and capabilities", async () => {
    const deps = {
      remediateFn: vi.fn(async () => ({ summary: "remediate" }) as any),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" }) as any),
      remediateFromScanFn: vi.fn(async () => ({ status: "ok" }) as any),
      remediatePortfolioFn: vi.fn(async () => ({ status: "ok", targets: [] }) as any),
      updateOutdatedFn: vi.fn(async () => ({ status: "ok" }) as any),
      healthFn: vi.fn(async () => ({ status: "ok" as const })),
      listPatchArtifactsFn: vi.fn(async () => []),
      inspectPatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      validatePatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      toVexFn: vi.fn(() => ({ bomFormat: "CycloneDX" }) as any),
      submitRemediateJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitScanJobFn: vi.fn(() => ({
        jobId: "j2",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitPortfolioJobFn: vi.fn(() => ({
        jobId: "j3",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      pollJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "done",
        submittedAt: new Date().toISOString(),
        result: {},
      })),
    };

    const result = await handleToolCall("health", {}, deps as any);

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.toolCount).toBe("number");
    expect(body.toolCount).toBe(TOOLS.length);
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(body.capabilities).toContain("health");
    expect(body.capabilities).toContain("remediate");
    expect(body.capabilities).toContain("remediateFromScan");
    expect(body.capabilities).toContain("remediatePortfolio");
    expect(body.capabilities).toContain("updateOutdated");
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
    expect(remediateProps.simulationMode).toBeDefined();
    expect(remediateProps.requestId).toBeDefined();
    expect(remediateProps.sessionId).toBeDefined();
    expect(remediateProps.parentRunId).toBeDefined();
    expect(remediateProps.consensusProvider).toBeDefined();
    expect(remediateProps.consensusModel).toBeDefined();
    expect(remediateProps.patchConfidenceThresholds).toBeDefined();

    expect(scanProps.preview).toBeDefined();
    expect(scanProps.simulationMode).toBeDefined();
    expect(scanProps.requestId).toBeDefined();
    expect(scanProps.sessionId).toBeDefined();
    expect(scanProps.parentRunId).toBeDefined();
    expect(scanProps.consensusProvider).toBeDefined();
    expect(scanProps.consensusModel).toBeDefined();
    expect(scanProps.patchConfidenceThresholds).toBeDefined();

    expect(planProps.requestId).toBeDefined();
    expect(planProps.simulationMode).toBeDefined();
    expect(planProps.sessionId).toBeDefined();
    expect(planProps.parentRunId).toBeDefined();
    expect(planProps.consensusProvider).toBeDefined();
    expect(planProps.consensusModel).toBeDefined();
    expect(planProps.patchConfidenceThresholds).toBeDefined();
  });

  it("declares dispositionPolicy on remediate, planRemediation, remediateFromScan, and remediatePortfolio tools", () => {
    const remediate = TOOLS.find((t) => t.name === "remediate");
    const plan = TOOLS.find((t) => t.name === "planRemediation");
    const scan = TOOLS.find((t) => t.name === "remediateFromScan");
    const portfolio = TOOLS.find((t) => t.name === "remediatePortfolio");

    for (const tool of [remediate, plan, scan, portfolio]) {
      expect(tool).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, unknown>;
      expect(props.dispositionPolicy).toBeDefined();
      expect((props.dispositionPolicy as Record<string, unknown>).type).toBe("object");
    }
  });

  it("does not expose simulationMode on updateOutdated", () => {
    const updateOutdated = TOOLS.find((t) => t.name === "updateOutdated");

    expect(updateOutdated).toBeDefined();
    const props = updateOutdated!.inputSchema.properties as Record<string, unknown>;
    expect(props.simulationMode).toBeUndefined();
  });

  it("creates MCP server instance without auto-start side effects", () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  it("dispatches remediateFromScan with slaBreachSummary without serialization error", async () => {
    const slaBreachSummary = {
      breachCount: 1,
      breaches: [
        {
          cveId: "CVE-2021-23337",
          severity: "HIGH",
          hoursOverdue: 48,
          deadlineAt: "2025-01-04T00:00:00.000Z",
          recommendedAction: "open-issue",
        },
      ],
    };

    const deps = {
      remediateFn: vi.fn(async () => ({ summary: "remediate" }) as any),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" }) as any),
      remediateFromScanFn: vi.fn(
        async () =>
          ({
            schemaVersion: "1.0",
            status: "partial",
            generatedAt: new Date().toISOString(),
            cveIds: ["CVE-2021-23337"],
            reports: [],
            successCount: 0,
            failedCount: 1,
            errors: [],
            patchCount: 0,
            slaBreachSummary,
          }) as any,
      ),
      remediatePortfolioFn: vi.fn(async () => ({ status: "ok", targets: [] }) as any),
      updateOutdatedFn: vi.fn(async () => ({ status: "ok" }) as any),
      healthFn: vi.fn(async () => ({ status: "ok" as const })),
      listPatchArtifactsFn: vi.fn(async () => []),
      inspectPatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      validatePatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      toVexFn: vi.fn(() => ({ bomFormat: "CycloneDX" }) as any),
      submitRemediateJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitScanJobFn: vi.fn(() => ({
        jobId: "j2",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitPortfolioJobFn: vi.fn(() => ({
        jobId: "j3",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      pollJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "done",
        submittedAt: new Date().toISOString(),
        result: {},
      })),
    };

    const result = await handleToolCall(
      "remediateFromScan",
      { inputPath: "./audit.json", cwd: "/tmp/project" },
      deps as any,
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toHaveProperty("slaBreachSummary");
    expect(JSON.parse(text).slaBreachSummary.breachCount).toBe(1);
  });

  it("dispatches planRemediation calls through handler", async () => {
    const deps = {
      remediateFn: vi.fn(async () => ({ summary: "remediate" }) as any),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" }) as any),
      remediateFromScanFn: vi.fn(async () => ({ status: "ok" }) as any),
      remediatePortfolioFn: vi.fn(async () => ({ status: "ok", targets: [] }) as any),
      updateOutdatedFn: vi.fn(async () => ({ status: "ok" }) as any),
      healthFn: vi.fn(async () => ({ status: "ok" as const })),
      listPatchArtifactsFn: vi.fn(async () => []),
      inspectPatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      validatePatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      toVexFn: vi.fn(() => ({ bomFormat: "CycloneDX" }) as any),
      submitRemediateJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "pending" as const,
        submittedAt: new Date().toISOString(),
      })),
      submitScanJobFn: vi.fn(() => ({
        jobId: "j2",
        status: "pending" as const,
        submittedAt: new Date().toISOString(),
      })),
      submitPortfolioJobFn: vi.fn(() => ({
        jobId: "j3",
        status: "pending" as const,
        submittedAt: new Date().toISOString(),
      })),
      pollJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "done" as const,
        submittedAt: new Date().toISOString(),
      })),
    };

    const result = await handleToolCall(
      "planRemediation",
      { cveId: "CVE-2021-23337", requestId: "req-1" },
      deps as any,
    );

    expect(deps.planRemediationFn).toHaveBeenCalledWith(
      "CVE-2021-23337",
      expect.objectContaining({ requestId: "req-1", source: "mcp" }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("planned");
  });

  it("dispatches remediatePortfolio calls through handler", async () => {
    const deps = {
      remediateFn: vi.fn(async () => ({ summary: "remediate" }) as any),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" }) as any),
      remediateFromScanFn: vi.fn(async () => ({ status: "ok" }) as any),
      remediatePortfolioFn: vi.fn(
        async () => ({ status: "ok", targets: [{ cwd: "/tmp/a" }] }) as any,
      ),
      updateOutdatedFn: vi.fn(async () => ({ status: "ok" }) as any),
      healthFn: vi.fn(async () => ({ status: "ok" as const })),
      listPatchArtifactsFn: vi.fn(async () => []),
      inspectPatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      validatePatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" }) as any),
      toVexFn: vi.fn(() => ({ bomFormat: "CycloneDX" }) as any),
      submitRemediateJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitScanJobFn: vi.fn(() => ({
        jobId: "j2",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitPortfolioJobFn: vi.fn(() => ({
        jobId: "j3",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      pollJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "done",
        submittedAt: new Date().toISOString(),
        result: {},
      })),
    };

    const result = await handleToolCall(
      "remediatePortfolio",
      {
        targets: [{ cwd: "/tmp/a", cveId: "CVE-2021-23337" }],
        requestId: "req-portfolio",
      },
      deps as any,
    );

    expect(deps.remediatePortfolioFn).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ requestId: "req-portfolio", source: "mcp" }),
    );
    expect(result.content[0]?.text).toContain("targets");
  });

  it("dispatches patch artifact calls through handler", async () => {
    const deps = {
      remediateFn: vi.fn(async () => ({ summary: "remediate" }) as any),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" }) as any),
      remediateFromScanFn: vi.fn(async () => ({ status: "ok" }) as any),
      remediatePortfolioFn: vi.fn(async () => ({ status: "ok", targets: [] }) as any),
      updateOutdatedFn: vi.fn(async () => ({ status: "ok" }) as any),
      healthFn: vi.fn(async () => ({ status: "ok" as const })),
      listPatchArtifactsFn: vi.fn(async () => [{ patchFilePath: "./patches/foo.patch" }]),
      inspectPatchArtifactFn: vi.fn(
        async () => ({ patchFilePath: "./patches/foo.patch", exists: true }) as any,
      ),
      validatePatchArtifactFn: vi.fn(
        async () => ({ patchFilePath: "./patches/foo.patch", diffValid: true }) as any,
      ),
      toVexFn: vi.fn(() => ({ bomFormat: "CycloneDX" }) as any),
      submitRemediateJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitScanJobFn: vi.fn(() => ({
        jobId: "j2",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitPortfolioJobFn: vi.fn(() => ({
        jobId: "j3",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      pollJobFn: vi.fn(() => ({
        jobId: "j1",
        status: "done",
        submittedAt: new Date().toISOString(),
        result: {},
      })),
    };

    const list = await handleToolCall("listPatchArtifacts", { cwd: "/tmp/project" }, deps as any);
    const inspect = await handleToolCall(
      "inspectPatchArtifact",
      { patchFilePath: "./patches/foo.patch", patchesDir: "./custom-patches" },
      deps as any,
    );
    const validate = await handleToolCall(
      "validatePatchArtifact",
      { patchFilePath: "./patches/foo.patch" },
      deps as any,
    );

    expect(deps.listPatchArtifactsFn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
    expect(deps.inspectPatchArtifactFn).toHaveBeenCalledWith(
      "./patches/foo.patch",
      expect.objectContaining({ patchesDir: "./custom-patches" }),
    );
    expect(deps.validatePatchArtifactFn).toHaveBeenCalledWith("./patches/foo.patch", {});
    expect(list.content[0]?.text).toContain("foo.patch");
    expect(inspect.content[0]?.text).toContain("exists");
    expect(validate.content[0]?.text).toContain("diffValid");
  });

  it("dispatches checkReachability, evaluatePackage, and scanDelta calls through handler", async () => {
    const deps = {
      remediateFn: vi.fn(async () => ({ summary: "remediate" }) as any),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" }) as any),
      remediateFromScanFn: vi.fn(async () => ({ status: "ok" }) as any),
      remediatePortfolioFn: vi.fn(async () => ({ status: "ok", targets: [] }) as any),
      updateOutdatedFn: vi.fn(async () => ({ status: "ok" }) as any),
      checkReachabilityFn: vi.fn(async () => ({
        packageName: "lodash",
        status: "reachable" as const,
        reason: "used in app",
      })),
      evaluatePackageFn: vi.fn(async () => ({
        schemaVersion: "1.0" as const,
        packageName: "express",
        isVulnerable: false,
        verdict: "safe" as const,
        summary: "safe",
        vulnerabilities: [],
        generatedAt: "",
      })),
      scanDeltaFn: vi.fn(async () => ({
        schemaVersion: "1.0" as const,
        status: "ok" as const,
        baseRef: "HEAD",
        targetRef: "working-tree",
        changedManifests: [],
        dependencyChanges: [],
        introducedFindings: [],
        resolvedFindings: [],
        netRiskVerdict: "neutral" as const,
        summary: "clean",
        generatedAt: "",
      })),
      healthFn: vi.fn(async () => ({ status: "ok" as const })),
      listPatchArtifactsFn: vi.fn(async () => []),
      inspectPatchArtifactFn: vi.fn(async () => ({}) as any),
      validatePatchArtifactFn: vi.fn(async () => ({}) as any),
      toVexFn: vi.fn(() => ({}) as any),
      submitRemediateJobFn: vi.fn(() => ({
        jobId: "1",
        status: "pending" as const,
        submittedAt: "",
      })),
      submitScanJobFn: vi.fn(() => ({ jobId: "2", status: "pending" as const, submittedAt: "" })),
      submitPortfolioJobFn: vi.fn(() => ({
        jobId: "3",
        status: "pending" as const,
        submittedAt: "",
      })),
      pollJobFn: vi.fn(() => ({
        jobId: "1",
        status: "done" as const,
        submittedAt: "",
        result: {},
      })),
    };

    const reachability = await handleToolCall(
      "checkReachability",
      { packageName: "lodash", symbol: "merge" },
      deps as any,
    );
    const evaluate = await handleToolCall(
      "evaluatePackage",
      { packageName: "express", version: "4.18.2" },
      deps as any,
    );
    const delta = await handleToolCall("scanDelta", { baseRef: "origin/main" }, deps as any);

    expect(deps.checkReachabilityFn).toHaveBeenCalledWith({
      packageName: "lodash",
      symbol: "merge",
      cwd: undefined,
    });
    expect(deps.evaluatePackageFn).toHaveBeenCalledWith("express", { version: "4.18.2" });
    expect(deps.scanDeltaFn).toHaveBeenCalledWith({ baseRef: "origin/main" });

    expect(reachability.content[0]?.text).toContain("reachable");
    expect(evaluate.content[0]?.text).toContain("safe");
    expect(delta.content[0]?.text).toContain("neutral");
  });

  it("returns structured error for unknown tool", async () => {
    const result = await handleToolCall("does-not-exist", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });
});

describe("async job MCP tools", () => {
  function makeJobDeps(overrides = {}) {
    return {
      remediateFn: vi.fn(async () => ({ summary: "remediate" }) as any),
      planRemediationFn: vi.fn(async () => ({ summary: "planned" }) as any),
      remediateFromScanFn: vi.fn(async () => ({ status: "ok" }) as any),
      remediatePortfolioFn: vi.fn(async () => ({ status: "ok", targets: [] }) as any),
      updateOutdatedFn: vi.fn(async () => ({ status: "ok" }) as any),
      healthFn: vi.fn(async () => ({ status: "ok" as const })),
      listPatchArtifactsFn: vi.fn(async () => []),
      inspectPatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./p.patch" }) as any),
      validatePatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./p.patch" }) as any),
      toVexFn: vi.fn(() => ({ bomFormat: "CycloneDX" }) as any),
      submitRemediateJobFn: vi.fn(() => ({
        jobId: "test-job-1",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitScanJobFn: vi.fn(() => ({
        jobId: "test-job-2",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      submitPortfolioJobFn: vi.fn(() => ({
        jobId: "test-job-3",
        status: "pending",
        submittedAt: new Date().toISOString(),
      })),
      pollJobFn: vi.fn(() => ({
        jobId: "test-job-1",
        status: "done",
        submittedAt: new Date().toISOString(),
        result: {},
      })),
      ...overrides,
    };
  }

  it("submitRemediateJob tool dispatches and returns JobHandle", async () => {
    const deps = makeJobDeps();
    const result = await handleToolCall(
      "submitRemediateJob",
      { cveId: "CVE-2021-1234" },
      deps as any,
    );
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body.jobId).toBe("test-job-1");
    expect(body.status).toBe("pending");
    expect(deps.submitRemediateJobFn).toHaveBeenCalledWith(
      "CVE-2021-1234",
      expect.objectContaining({ source: "mcp" }),
    );
  });

  it("submitScanJob tool dispatches and returns JobHandle", async () => {
    const deps = makeJobDeps();
    const result = await handleToolCall(
      "submitScanJob",
      { inputPath: "/tmp/audit.json" },
      deps as any,
    );
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body.jobId).toBe("test-job-2");
    expect(deps.submitScanJobFn).toHaveBeenCalledWith(
      "/tmp/audit.json",
      expect.objectContaining({ source: "mcp" }),
    );
  });

  it("submitPortfolioJob tool dispatches and returns JobHandle", async () => {
    const deps = makeJobDeps();
    const result = await handleToolCall(
      "submitPortfolioJob",
      { targets: [{ cwd: "/tmp" }] },
      deps as any,
    );
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body.jobId).toBe("test-job-3");
  });

  it("pollJob tool dispatches and returns job state", async () => {
    const deps = makeJobDeps();
    const result = await handleToolCall("pollJob", { jobId: "test-job-1" }, deps as any);
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body.status).toBe("done");
    expect(deps.pollJobFn).toHaveBeenCalledWith("test-job-1");
  });
});

describe("MCP Client integration via InMemoryTransport", () => {
  it("completes handshake, lists tools, and executes health tool", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const toolList = await client.listTools();
    expect(toolList.tools.length).toBe(TOOLS.length);

    const healthResult = await client.callTool({ name: "health", arguments: {} });
    expect(healthResult.isError).toBeFalsy();
    const content = healthResult.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0]?.text ?? "");
    expect(body.status).toBe("ok");
    expect(body.toolCount).toBe(TOOLS.length);

    await client.close();
    await server.close();
  });

  it("handles unknown tool call through client transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "unknown_tool", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Unknown tool");

    await client.close();
    await server.close();
  });
});

describe("MCP stdio server process integration", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const serverPath = resolve(__dirname, "../../dist/mcp/server.js");
  let proc: ChildProcessWithoutNullStreams;
  let stdoutBuffer = "";
  const pendingRequests = new Map<number, (res: any) => void>();

  beforeAll(async () => {
    if (!existsSync(serverPath)) {
      throw new Error(
        `MCP server build artifact not found at ${serverPath}. Run pnpm build first.`,
      );
    }

    proc = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pendingRequests.has(msg.id)) {
            pendingRequests.get(msg.id)!(msg);
            pendingRequests.delete(msg.id);
          }
        } catch {
          // ignore non-json lines
        }
      }
    });
  });

  afterAll(() => {
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
  });

  function sendRpc(req: { id?: number; method: string; params?: any }): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (req.id !== undefined) pendingRequests.delete(req.id);
        reject(new Error(`RPC timeout for method: ${req.method}`));
      }, 5000);

      if (req.id !== undefined) {
        pendingRequests.set(req.id, (res) => {
          clearTimeout(timeout);
          resolve(res);
        });
      }

      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...req }) + "\n");

      if (req.id === undefined) {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  it("completes MCP initialize handshake over stdio", async () => {
    const initRes = await sendRpc({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest-stdio-client", version: "1.0.0" },
      },
    });

    expect(initRes.jsonrpc).toBe("2.0");
    expect(initRes.id).toBe(1);
    expect(initRes.result.serverInfo.name).toBe("autoremediator");
    expect(initRes.result.capabilities.tools).toBeDefined();

    // Send initialized notification
    await sendRpc({ method: "notifications/initialized" });
  });

  it("lists all registered tools via tools/list over stdio", async () => {
    const listRes = await sendRpc({
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(listRes.result.tools).toBeInstanceOf(Array);
    expect(listRes.result.tools.length).toBe(TOOLS.length);
    const names = listRes.result.tools.map((t: any) => t.name);
    expect(names).toContain("health");
    expect(names).toContain("remediate");
    expect(names).toContain("planRemediation");
    expect(names).toContain("remediateFromScan");
    expect(names).toContain("remediatePortfolio");
  });

  it("executes health tool via tools/call and returns structured report over stdio", async () => {
    const callRes = await sendRpc({
      id: 3,
      method: "tools/call",
      params: { name: "health", arguments: {} },
    });

    expect(callRes.result.isError).toBeFalsy();
    const content = callRes.result.content[0]?.text;
    expect(content).toBeDefined();
    const report = JSON.parse(content);
    expect(report.status).toBe("ok");
    expect(report.toolCount).toBe(TOOLS.length);
    expect(report.capabilities).toContain("health");
  });

  it("returns structured error when calling unknown tool over stdio", async () => {
    const errRes = await sendRpc({
      id: 4,
      method: "tools/call",
      params: { name: "unknown_tool_xyz", arguments: {} },
    });

    expect(errRes.result.isError).toBe(true);
    expect(errRes.result.content[0]?.text).toContain("Unknown tool: unknown_tool_xyz");
  });
});
