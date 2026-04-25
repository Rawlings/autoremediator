import { describe, expect, it, vi } from "vitest";
import { OPENAPI_SPEC, createOpenApiServer } from "./server.js";

describe("openapi server", () => {
  it("exposes plan-remediation route in OpenAPI spec", () => {
    const paths = OPENAPI_SPEC.paths as Record<string, unknown>;
    expect(paths["/openapi.json"]).toBeDefined();
    expect(paths["/plan-remediation"]).toBeDefined();
    expect(paths["/remediate-portfolio"]).toBeDefined();
    expect(paths["/patches/list"]).toBeDefined();
    expect(paths["/patches/inspect"]).toBeDefined();
    expect(paths["/patches/validate"]).toBeDefined();
  });

  it("declares preview and correlation fields for plan-remediation", () => {
    const planRoute = (OPENAPI_SPEC.paths as Record<string, any>)["/plan-remediation"];
    const optionsProps =
      planRoute.post.requestBody.content["application/json"].schema.properties.options.properties;

    expect(optionsProps.requestId).toBeDefined();
    expect(optionsProps.simulationMode).toBeDefined();
    expect(optionsProps.sessionId).toBeDefined();
    expect(optionsProps.parentRunId).toBeDefined();
    expect(optionsProps.idempotencyKey).toBeDefined();
    expect(optionsProps.resume).toBeDefined();
    expect(optionsProps.constraints).toBeDefined();
    expect(optionsProps.packageManager.enum).toEqual(["npm", "pnpm", "yarn", "bun", "deno"]);
    expect(optionsProps.consensusProvider).toBeDefined();
    expect(optionsProps.consensusModel).toBeDefined();
    expect(optionsProps.patchConfidenceThresholds).toBeDefined();
  });

  it("declares strategy and unresolved aggregates on scan responses", () => {
    const scanRoute = (OPENAPI_SPEC.paths as Record<string, any>)["/remediate-from-scan"];
    const responseProps =
      scanRoute.post.responses["200"].content["application/json"].schema.properties;

    expect(responseProps.strategyCounts).toBeDefined();
    expect(responseProps.dependencyScopeCounts).toBeDefined();
    expect(responseProps.unresolvedByReason).toBeDefined();
    expect(responseProps.simulationSummary).toBeDefined();
  });

  it("does not expose simulationMode on update-outdated options", () => {
    const updateOutdatedRoute = (OPENAPI_SPEC.paths as Record<string, any>)["/update-outdated"];
    const optionsProps =
      updateOutdatedRoute.post.requestBody.content["application/json"].schema.properties.options.properties;

    expect(optionsProps.simulationMode).toBeUndefined();
  });

  it("creates server with injected dependencies", () => {
    const server = createOpenApiServer({
      remediateFn: vi.fn(async () => ({ cveId: "CVE-2021-23337" } as any)),
      planRemediationFn: vi.fn(async () => ({ cveId: "CVE-2021-23337" } as any)),
      remediateFromScanFn: vi.fn(async () => ({ schemaVersion: "1.0" } as any)),
      remediatePortfolioFn: vi.fn(async () => ({ schemaVersion: "1.0", status: "ok", targets: [] } as any)),
      updateOutdatedFn: vi.fn(async () => ({ schemaVersion: "1.0", status: "ok" } as any)),
      listPatchArtifactsFn: vi.fn(async () => []),
      inspectPatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" } as any)),
      validatePatchArtifactFn: vi.fn(async () => ({ patchFilePath: "./patches/foo.patch" } as any)),
    });

    expect(server).toBeDefined();
    expect(typeof server.close).toBe("function");
    server.close();
  });

  it("declares patch lifecycle routes in OpenAPI spec", () => {
    const paths = OPENAPI_SPEC.paths as Record<string, any>;
    expect(paths["/patches/list"].post.operationId).toBe("listPatchArtifacts");
    expect(paths["/patches/inspect"].post.operationId).toBe("inspectPatchArtifact");
    expect(paths["/patches/validate"].post.operationId).toBe("validatePatchArtifact");
    expect(paths["/remediate-portfolio"].post.operationId).toBe("remediatePortfolio");
    const inspectOptions =
      paths["/patches/inspect"].post.requestBody.content["application/json"].schema.properties.options
        .properties;
    expect(inspectOptions.patchesDir).toBeDefined();
  });

});
