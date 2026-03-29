/**
 * autoremediator OpenAPI HTTP server
 *
 * Exposes POST /remediate and POST /remediate-from-scan as a lightweight
 * HTTP server using Node.js built-in http module (no framework dependency).
 *
 * Start: node dist/openapi/server.js [--port 3000]
 */
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  createRemediateOptionSchemaProperties,
  createScanOptionSchemaProperties,
  createScanReportSchemaProperties,
  OPTION_DESCRIPTIONS,
  planRemediation,
  remediate,
  remediateFromScan,
} from "../api.js";
import type { RemediateOptions, ScanOptions } from "../api.js";
import { PACKAGE_VERSION } from "../version";

const DEFAULT_PORT = 3000;

function parsePort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) {
    const p = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(p)) return p;
  }
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (!isNaN(p)) return p;
  }
  return DEFAULT_PORT;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { raw += chunk; });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function withOpenApiSource(options: unknown): Record<string, unknown> {
  const normalized = typeof options === "object" && options !== null
    ? (options as Record<string, unknown>)
    : {};
  return {
    ...normalized,
    source: typeof normalized.source === "string" ? normalized.source : "openapi",
  };
}

interface OpenApiServerDeps {
  remediateFn: typeof remediate;
  remediateFromScanFn: typeof remediateFromScan;
  planRemediationFn: typeof planRemediation;
}

const defaultDeps: OpenApiServerDeps = {
  remediateFn: remediate,
  remediateFromScanFn: remediateFromScan,
  planRemediationFn: planRemediation,
};

export function createOpenApiServer(deps: OpenApiServerDeps = defaultDeps): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const method = req.method?.toUpperCase();

  // Health check
  if (method === "GET" && url.pathname === "/health") {
    return send(res, 200, { status: "ok" });
  }

  // OpenAPI spec
  if (method === "GET" && url.pathname === "/openapi.json") {
    return send(res, 200, OPENAPI_SPEC);
  }

    if (method === "POST" && url.pathname === "/remediate") {
    let body: { cveId?: unknown; options?: unknown };
    try {
      body = (await readBody(req)) as typeof body;
    } catch {
      return send(res, 400, { error: "Invalid JSON body" });
    }
    if (typeof body.cveId !== "string" || !body.cveId) {
      return send(res, 400, { error: "cveId is required (string)" });
    }
    try {
      const report = await deps.remediateFn(body.cveId, withOpenApiSource(body.options) as RemediateOptions);
      return send(res, 200, report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return send(res, 400, { error: message });
    }
  }

    if (method === "POST" && url.pathname === "/plan-remediation") {
    let body: { cveId?: unknown; options?: unknown };
    try {
      body = (await readBody(req)) as typeof body;
    } catch {
      return send(res, 400, { error: "Invalid JSON body" });
    }
    if (typeof body.cveId !== "string" || !body.cveId) {
      return send(res, 400, { error: "cveId is required (string)" });
    }
    try {
      const report = await deps.planRemediationFn(body.cveId, withOpenApiSource(body.options) as RemediateOptions);
      return send(res, 200, report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return send(res, 400, { error: message });
    }
  }

    if (method === "POST" && url.pathname === "/remediate-from-scan") {
    let body: { inputPath?: unknown; options?: unknown };
    try {
      body = (await readBody(req)) as typeof body;
    } catch {
      return send(res, 400, { error: "Invalid JSON body" });
    }
    if (typeof body.inputPath !== "string" || !body.inputPath) {
      return send(res, 400, { error: "inputPath is required (string)" });
    }
    try {
      const report = await deps.remediateFromScanFn(body.inputPath, withOpenApiSource(body.options) as ScanOptions);
      return send(res, 200, report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return send(res, 400, { error: message });
    }
  }

    return send(res, 404, { error: "Not found" });
  });
}

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "autoremediator",
    version: PACKAGE_VERSION,
    description: "Agentic CVE remediation for Node.js dependency projects",
  },
  paths: {
    "/remediate": {
      post: {
        operationId: "remediate",
        summary: "Remediate a single CVE",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["cveId"],
                properties: {
                  cveId: {
                    type: "string",
                    description: OPTION_DESCRIPTIONS.cveId,
                    pattern: "^CVE-\\d{4}-\\d+$",
                  },
                  options: {
                    type: "object",
                    description: "RemediateOptions",
                    properties: createRemediateOptionSchemaProperties(),
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "RemediationReport",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "400": {
            description: "Invalid input or remediation error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/plan-remediation": {
      post: {
        operationId: "planRemediation",
        summary: "Generate a non-mutating remediation preview",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["cveId"],
                properties: {
                  cveId: {
                    type: "string",
                    description: OPTION_DESCRIPTIONS.cveId,
                    pattern: "^CVE-\\d{4}-\\d+$",
                  },
                  options: {
                    type: "object",
                    description: "RemediateOptions",
                    properties: createRemediateOptionSchemaProperties({ includeDryRun: false, includePreview: false }),
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "RemediationReport",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "400": {
            description: "Invalid input or remediation error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/remediate-from-scan": {
      post: {
        operationId: "remediateFromScan",
        summary: "Parse a scanner file and remediate all found CVEs",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["inputPath"],
                properties: {
                  inputPath: {
                    type: "string",
                    description: OPTION_DESCRIPTIONS.inputPath,
                  },
                  options: {
                    type: "object",
                    description: "ScanOptions",
                    properties: createScanOptionSchemaProperties(),
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ScanReport",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: createScanReportSchemaProperties(),
                },
              },
            },
          },
          "400": {
            description: "Invalid input or remediation error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        operationId: "health",
        summary: "Health check",
        responses: {
          "200": {
            description: "Server is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  const port = parsePort();
  const server = createOpenApiServer();
  server.listen(port, () => {
    console.log(`autoremediator OpenAPI server listening on http://localhost:${port}`);
    console.log(`  OpenAPI spec: http://localhost:${port}/openapi.json`);
  });
}
