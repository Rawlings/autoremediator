import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
      updateOutdatedRoute.post.requestBody.content["application/json"].schema.properties.options
        .properties;

    expect(optionsProps.simulationMode).toBeUndefined();
  });

  it("creates server with injected dependencies", () => {
    const server = createOpenApiServer({
      remediateFn: vi.fn(async () => ({ cveId: "CVE-2021-23337" }) as any),
      planRemediationFn: vi.fn(async () => ({ cveId: "CVE-2021-23337" }) as any),
      remediateFromScanFn: vi.fn(async () => ({ schemaVersion: "1.0" }) as any),
      remediatePortfolioFn: vi.fn(
        async () => ({ schemaVersion: "1.0", status: "ok", targets: [] }) as any,
      ),
      updateOutdatedFn: vi.fn(async () => ({ schemaVersion: "1.0", status: "ok" }) as any),
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
      paths["/patches/inspect"].post.requestBody.content["application/json"].schema.properties
        .options.properties;
    expect(inspectOptions.patchesDir).toBeDefined();
  });

  describe("RBAC token authorization", () => {
    it("validates roles and permissions correctly", async () => {
      const { getRoleForToken } = await import("./rbac.js");
      const envTokens = "admin:tokAdmin,operator:tokOp,reader:tokRead";

      expect(getRoleForToken("tokAdmin", envTokens)).toBe("admin");
      expect(getRoleForToken("tokOp", envTokens)).toBe("operator");
      expect(getRoleForToken("tokRead", envTokens)).toBe("reader");
      expect(getRoleForToken("invalidToken", envTokens)).toBeUndefined();
    });

    it("verifies and extracts roles from signed JWT tokens", async () => {
      const { createSignedJwt, getRoleForToken } = await import("./rbac.js");
      const secret = "super-secret-key-1234";

      const adminJwt = createSignedJwt({ sub: "user-1", role: "admin" }, secret);
      const opJwt = createSignedJwt({ sub: "user-2", roles: ["operator"] }, secret);
      const expiredJwt = createSignedJwt(
        { sub: "user-3", role: "admin", exp: Math.floor(Date.now() / 1000) - 10 },
        secret,
      );

      expect(getRoleForToken(adminJwt, undefined, secret)).toBe("admin");
      expect(getRoleForToken(opJwt, undefined, secret)).toBe("operator");
      expect(getRoleForToken(expiredJwt, undefined, secret)).toBeUndefined();
      expect(getRoleForToken(adminJwt, undefined, "wrong-secret")).toBeUndefined();
    });
  });

  describe("OpenAPI HTTP server real requests", () => {
    let server: import("node:http").Server;
    let baseUrl: string;

    const mockDeps = {
      remediateFn: vi.fn(
        async (cveId, opts) => ({ cveId, status: "applied", source: opts?.source }) as any,
      ),
      planRemediationFn: vi.fn(
        async (cveId, opts) => ({ cveId, status: "planned", source: opts?.source }) as any,
      ),
      remediateFromScanFn: vi.fn(async (inputPath) => ({ inputPath, status: "ok" }) as any),
      remediatePortfolioFn: vi.fn(async (targets) => ({ targets, status: "ok" }) as any),
      updateOutdatedFn: vi.fn(async () => ({ status: "ok" }) as any),
      listPatchArtifactsFn: vi.fn(async () => [{ patchFilePath: "./patches/sample.patch" } as any]),
      inspectPatchArtifactFn: vi.fn(
        async (patchFilePath) => ({ patchFilePath, exists: true }) as any,
      ),
      validatePatchArtifactFn: vi.fn(
        async (patchFilePath) => ({ patchFilePath, valid: true }) as any,
      ),
      toVexFn: vi.fn(() => ({ bomFormat: "CycloneDX", specVersion: "1.5" }) as any),
      submitRemediateJobFn: vi.fn((_cveId) => ({
        jobId: "job-rem-1",
        status: "pending" as const,
        submittedAt: new Date().toISOString(),
      })),
      submitScanJobFn: vi.fn(() => ({
        jobId: "job-scan-1",
        status: "pending" as const,
        submittedAt: new Date().toISOString(),
      })),
      submitPortfolioJobFn: vi.fn(() => ({
        jobId: "job-port-1",
        status: "pending" as const,
        submittedAt: new Date().toISOString(),
      })),
      pollJobFn: vi.fn((jobId) => {
        if (jobId === "job-rem-1") {
          return {
            jobId,
            status: "done" as const,
            submittedAt: new Date().toISOString(),
            result: { cveId: "CVE-2021-23337" },
          } as any;
        }
        throw new Error(`Job not found: ${jobId}`);
      }),
    };

    beforeAll(async () => {
      server = createOpenApiServer(mockDeps);
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => resolve());
        server.on("error", reject);
      });
      const addr = server.address() as import("node:net").AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function makeRequest(
      path: string,
      options: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ): Promise<{ status: number; headers: Headers; json: () => Promise<any> }> {
      try {
        return (await fetch(`${baseUrl}${path}`, options as any)) as any;
      } catch (err: any) {
        if (err?.cause?.code === "EPERM" || err?.code === "EPERM") {
          // In sandboxed environments without loopback socket connect permission (macOS Seatbelt connect EPERM),
          // dispatch directly through server HTTP request handling pipeline.
          const { IncomingMessage, ServerResponse } = await import("node:http");
          const { Socket } = await import("node:net");
          const socket = new Socket();
          const req = new IncomingMessage(socket);
          req.method = options.method ?? "GET";
          req.url = path;
          req.headers = {
            host: "127.0.0.1",
            ...(options.headers
              ? Object.fromEntries(
                  Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v]),
                )
              : {}),
          };

          const res = new ServerResponse(req);
          let responseData = "";
          const resultPromise = new Promise<{
            status: number;
            headers: Headers;
            json: () => Promise<any>;
          }>((resolve) => {
            const origWriteHead = res.writeHead.bind(res);
            res.writeHead = ((status: number, ...args: any[]) => {
              const headersObj =
                typeof args[0] === "object"
                  ? args[0]
                  : typeof args[1] === "object"
                    ? args[1]
                    : undefined;
              if (headersObj) {
                for (const [k, v] of Object.entries(headersObj)) {
                  res.setHeader(k, v as any);
                }
              }
              return (origWriteHead as any)(status, ...args);
            }) as any;

            const origEnd = res.end.bind(res);
            res.end = ((chunk?: any, ...args: any[]) => {
              if (chunk) {
                responseData += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
              }
              const headers = new Headers();
              for (const [k, v] of Object.entries(res.getHeaders())) {
                if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
              }
              resolve({
                status: res.statusCode,
                headers,
                json: async () => (responseData ? JSON.parse(responseData) : null),
              });
              return origEnd(chunk, ...args);
            }) as any;

            const origWrite = res.write.bind(res);
            res.write = ((chunk?: any, ...args: any[]) => {
              if (chunk) {
                responseData += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
              }
              return origWrite(chunk, ...args);
            }) as any;
          });

          server.emit("request", req, res);

          if (options.body) {
            req.push(options.body);
          }
          req.push(null);

          return await resultPromise;
        }
        throw err;
      }
    }

    it("serves GET /health with 200 and json content-type", async () => {
      const res = await makeRequest("/health");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const data = await res.json();
      expect(data).toEqual({ status: "ok" });
    });

    it("serves GET /openapi.json matching specification", async () => {
      const res = await makeRequest("/openapi.json");
      expect(res.status).toBe(200);
      const spec = await res.json();
      expect(spec.openapi).toBe("3.1.0");
      expect(spec.paths["/remediate"]).toBeDefined();
      expect(spec.paths["/plan-remediation"]).toBeDefined();
    });

    it("dispatches POST /plan-remediation with real request body and returns 200", async () => {
      const res = await makeRequest("/plan-remediation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cveId: "CVE-2021-23337", options: { dryRun: true } }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.cveId).toBe("CVE-2021-23337");
      expect(data.status).toBe("planned");
    });

    it("returns 400 when POST /remediate is missing required cveId", async () => {
      const res = await makeRequest("/remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ options: {} }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("cveId is required");
    });

    it("dispatches POST /jobs/remediate and returns 202 with job handle", async () => {
      const res = await makeRequest("/jobs/remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cveId: "CVE-2021-23337" }),
      });
      expect(res.status).toBe(202);
      const handle = await res.json();
      expect(handle.jobId).toBe("job-rem-1");
      expect(handle.status).toBe("pending");
    });

    it("polls job via GET /jobs/:jobId returning 200 or 404", async () => {
      const okRes = await makeRequest("/jobs/job-rem-1");
      expect(okRes.status).toBe(200);
      const job = await okRes.json();
      expect(job.status).toBe("done");

      const notFoundRes = await makeRequest("/jobs/non-existent-job");
      expect(notFoundRes.status).toBe(404);
    });

    it("returns 404 for unknown route", async () => {
      const res = await makeRequest("/unregistered-endpoint");
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Not found");
    });
  });
});
