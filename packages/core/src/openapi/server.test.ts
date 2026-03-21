import { describe, expect, it, vi } from "vitest";
import { OPENAPI_SPEC, createOpenApiServer } from "./server.js";

describe("openapi server", () => {
  it("exposes plan-remediation route in OpenAPI spec", () => {
    const paths = OPENAPI_SPEC.paths as Record<string, unknown>;
    expect(paths["/plan-remediation"]).toBeDefined();
  });

  it("declares preview and correlation fields for plan-remediation", () => {
    const planRoute = (OPENAPI_SPEC.paths as Record<string, any>)["/plan-remediation"];
    const optionsProps =
      planRoute.post.requestBody.content["application/json"].schema.properties.options.properties;

    expect(optionsProps.requestId).toBeDefined();
    expect(optionsProps.sessionId).toBeDefined();
    expect(optionsProps.parentRunId).toBeDefined();
    expect(optionsProps.idempotencyKey).toBeDefined();
    expect(optionsProps.resume).toBeDefined();
    expect(optionsProps.constraints).toBeDefined();
    expect(optionsProps.packageManager.enum).toEqual(["npm", "pnpm", "yarn"]);
  });

  it("creates server with injected dependencies", () => {
    const server = createOpenApiServer({
      remediateFn: vi.fn(async () => ({ cveId: "CVE-2021-23337" } as any)),
      planRemediationFn: vi.fn(async () => ({ cveId: "CVE-2021-23337" } as any)),
      remediateFromScanFn: vi.fn(async () => ({ schemaVersion: "1.0" } as any)),
    });

    expect(server).toBeDefined();
    expect(typeof server.close).toBe("function");
    server.close();
  });
});
