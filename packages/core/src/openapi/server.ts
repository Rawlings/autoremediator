/**
 * autoremediator OpenAPI HTTP server
 *
 * Exposes POST /remediate and POST /remediate-from-scan as a lightweight
 * HTTP server using Node.js built-in http module (no framework dependency).
 *
 * Start: node dist/openapi/server.js [--port 3000]
 */
import http from "node:http";
import { remediate, remediateFromScan } from "../api.js";
import type { RemediateOptions, ScanOptions } from "../api.js";

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

const server = http.createServer(async (req, res) => {
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
      const report = await remediate(body.cveId, (body.options ?? {}) as RemediateOptions);
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
      const report = await remediateFromScan(body.inputPath, (body.options ?? {}) as ScanOptions);
      return send(res, 200, report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return send(res, 400, { error: message });
    }
  }

  return send(res, 404, { error: "Not found" });
});

const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "autoremediator",
    version: "0.1.2",
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
                    description: "CVE identifier, e.g. CVE-2021-23337",
                    pattern: "^CVE-\\d{4}-\\d+$",
                  },
                  options: {
                    type: "object",
                    description: "RemediateOptions",
                    properties: {
                      cwd: { type: "string" },
                      packageManager: { type: "string", enum: ["npm", "pnpm", "yarn"] },
                      dryRun: { type: "boolean" },
                      skipTests: { type: "boolean" },
                      llmProvider: { type: "string", enum: ["openai", "anthropic", "local"] },
                      patchesDir: { type: "string" },
                      policyPath: { type: "string" },
                    },
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
                    description: "Absolute or relative path to npm/pnpm/yarn audit JSON or SARIF file",
                  },
                  options: {
                    type: "object",
                    description: "ScanOptions",
                    properties: {
                      cwd: { type: "string" },
                      packageManager: { type: "string", enum: ["npm", "pnpm", "yarn"] },
                      dryRun: { type: "boolean" },
                      skipTests: { type: "boolean" },
                      llmProvider: { type: "string", enum: ["openai", "anthropic", "local"] },
                      format: { type: "string", enum: ["npm-audit", "yarn-audit", "sarif", "auto"] },
                      patchesDir: { type: "string" },
                      policyPath: { type: "string" },
                      writeEvidence: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ScanReport",
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

const port = parsePort();
server.listen(port, () => {
  console.log(`autoremediator OpenAPI server listening on http://localhost:${port}`);
  console.log(`  OpenAPI spec: http://localhost:${port}/openapi.json`);
});
