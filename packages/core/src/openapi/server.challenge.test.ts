import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createOpenApiServer, type OpenApiServerDeps } from "./server.js";

describe("Milestone 4 Challenge: OpenAPI HTTP Server Edge Conditions", () => {
  let server: http.Server;

  const mockDeps: OpenApiServerDeps = {
    remediateFn: vi.fn(),
    remediateFromScanFn: vi.fn(),
    remediatePortfolioFn: vi.fn(),
    planRemediationFn: vi.fn(),
    updateOutdatedFn: vi.fn(),
    listPatchArtifactsFn: vi.fn(),
    inspectPatchArtifactFn: vi.fn(),
    validatePatchArtifactFn: vi.fn(),
    toVexFn: vi.fn(),
    submitRemediateJobFn: vi.fn(),
    submitScanJobFn: vi.fn(),
    submitPortfolioJobFn: vi.fn(),
    pollJobFn: vi.fn((id: string) => {
      if (id === "job-123") {
        return {
          jobId: "job-123",
          status: "done" as const,
          submittedAt: "2026-10-11T00:00:00.000Z",
        };
      }
      throw new Error(`Job "${id}" not found`);
    }),
  };

  beforeAll(async () => {
    server = createOpenApiServer(mockDeps);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  async function rawRequest(
    method: string,
    path: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any; raw: string }> {
    const { IncomingMessage, ServerResponse } = await import("node:http");
    const { Socket } = await import("node:net");
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = path;
    req.headers = {
      host: "127.0.0.1",
      "content-type": "application/json",
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    };

    const res = new ServerResponse(req);
    let responseData = "";
    const resultPromise = new Promise<{ status: number; json: any; raw: string }>((resolve) => {
      const origWriteHead = res.writeHead.bind(res);
      res.writeHead = ((status: number, ...args: any[]) => {
        return (origWriteHead as any)(status, ...args);
      }) as any;

      const origEnd = res.end.bind(res);
      res.end = ((chunk?: any, ...args: any[]) => {
        if (chunk) {
          responseData += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        }
        let parsed = null;
        try {
          parsed = responseData ? JSON.parse(responseData) : null;
        } catch {
          parsed = null;
        }
        resolve({
          status: res.statusCode,
          json: parsed,
          raw: responseData,
        });
        return origEnd(chunk, ...args);
      }) as any;
    });

    const timeoutPromise = new Promise<{ status: number; json: any; raw: string }>(
      (_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Request timed out for ${method} ${path}: server never sent response or closed socket`,
            ),
          );
        }, 1500);
        void resultPromise.finally(() => clearTimeout(timer));
      },
    );

    server.emit("request", req, res);

    if (body !== undefined) {
      req.push(body);
    }
    req.push(null);

    return await Promise.race([resultPromise, timeoutPromise]);
  }

  it("handles malformed JSON body across all POST endpoints with HTTP 400 without crashing", async () => {
    const postEndpoints = [
      "/remediate",
      "/plan-remediation",
      "/remediate-from-scan",
      "/remediate-portfolio",
      "/patches/list",
      "/patches/inspect",
      "/patches/validate",
      "/update-outdated",
      "/vex",
      "/jobs/remediate",
      "/jobs/scan",
      "/jobs/portfolio",
    ];

    for (const endpoint of postEndpoints) {
      const res = await rawRequest("POST", endpoint, "{ invalid json syntax ");
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "Invalid JSON body" });
    }
  });

  it("handles empty body requests gracefully across all POST endpoints without hanging or crashing", async () => {
    const postEndpoints = [
      "/remediate",
      "/plan-remediation",
      "/remediate-from-scan",
      "/remediate-portfolio",
      "/patches/list",
      "/patches/inspect",
      "/patches/validate",
      "/update-outdated",
      "/vex",
      "/jobs/remediate",
      "/jobs/scan",
      "/jobs/portfolio",
    ];

    for (const endpoint of postEndpoints) {
      const res = await rawRequest("POST", endpoint, "");
      // Should either be 400 (validation error on required fields) or 200/202 if optional
      expect([200, 202, 400]).toContain(res.status);
    }
  });

  it("handles non-object and primitive JSON payloads (null, false, 0, strings) defensively without hanging or crashing", async () => {
    const postEndpoints = [
      "/remediate",
      "/plan-remediation",
      "/remediate-from-scan",
      "/remediate-portfolio",
      "/patches/inspect",
      "/patches/validate",
      "/jobs/remediate",
      "/jobs/scan",
      "/jobs/portfolio",
    ];

    for (const endpoint of postEndpoints) {
      for (const primitivePayload of ["null", "false", "0", '"plain string"']) {
        const res = await rawRequest("POST", endpoint, primitivePayload);
        expect(res.status).toBe(400);
      }
    }
  });

  it("handles missing or invalid required string fields across all POST endpoints with HTTP 400", async () => {
    // /remediate
    const r1 = await rawRequest("POST", "/remediate", JSON.stringify({}));
    expect(r1.status).toBe(400);
    expect(r1.json.error).toContain("cveId is required");

    // /plan-remediation
    const r2 = await rawRequest("POST", "/plan-remediation", JSON.stringify({ cveId: 123 }));
    expect(r2.status).toBe(400);
    expect(r2.json.error).toContain("cveId is required");

    // /remediate-from-scan
    const r3 = await rawRequest("POST", "/remediate-from-scan", JSON.stringify({}));
    expect(r3.status).toBe(400);
    expect(r3.json.error).toContain("inputPath is required");

    // /remediate-portfolio (requires array)
    const r4 = await rawRequest(
      "POST",
      "/remediate-portfolio",
      JSON.stringify({ targets: "not-array" }),
    );
    expect(r4.status).toBe(400);
    expect(r4.json.error).toContain("targets is required (array)");

    // /patches/inspect
    const r5 = await rawRequest("POST", "/patches/inspect", JSON.stringify({}));
    expect(r5.status).toBe(400);
    expect(r5.json.error).toContain("patchFilePath is required");

    // /patches/validate
    const r6 = await rawRequest("POST", "/patches/validate", JSON.stringify({ patchFilePath: "" }));
    expect(r6.status).toBe(400);
    expect(r6.json.error).toContain("patchFilePath is required");
  });

  it("handles unknown endpoints and nested paths with HTTP 404", async () => {
    const r1 = await rawRequest("GET", "/non-existent-endpoint");
    expect(r1.status).toBe(404);
    expect(r1.json).toEqual({ error: "Not found" });

    const r2 = await rawRequest("POST", "/api/v1/unknown");
    expect(r2.status).toBe(404);
  });

  it("handles parametric /jobs/:jobId errors, missing id, and path traversal cleanly", async () => {
    // Valid poll
    const r1 = await rawRequest("GET", "/jobs/job-123");
    expect(r1.status).toBe(200);
    expect(r1.json.jobId).toBe("job-123");

    // Non-existent job
    const r2 = await rawRequest("GET", "/jobs/job-unknown");
    expect(r2.status).toBe(404);
    expect(r2.json.error).toContain('Job "job-unknown" not found');

    // Trailing slash without job id
    const r3 = await rawRequest("GET", "/jobs/");
    expect(r3.status).toBe(404);

    // Multi-segment path traversal
    const r4 = await rawRequest("GET", "/jobs/foo/bar");
    expect(r4.status).toBe(404);
  });

  it("captures thrown exceptions in underlying API functions as HTTP 400 with structured JSON", async () => {
    vi.mocked(mockDeps.remediateFn).mockRejectedValueOnce(new Error("Underlying engine failure"));
    const res = await rawRequest("POST", "/remediate", JSON.stringify({ cveId: "CVE-2024-9999" }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "Underlying engine failure" });
  });
});
