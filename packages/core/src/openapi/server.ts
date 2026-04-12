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
  inspectPatchArtifact,
  listPatchArtifacts,
  planRemediation,
  remediate,
  remediateFromScan,
  validatePatchArtifact,
} from "../api/index.js";
import type { PatchArtifactQueryOptions, RemediateOptions, ScanOptions } from "../api/index.js";
import { OPENAPI_SPEC } from "./spec.js";

export { OPENAPI_SPEC } from "./spec.js";

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
  listPatchArtifactsFn: typeof listPatchArtifacts;
  inspectPatchArtifactFn: typeof inspectPatchArtifact;
  validatePatchArtifactFn: typeof validatePatchArtifact;
}

const defaultDeps: OpenApiServerDeps = {
  remediateFn: remediate,
  remediateFromScanFn: remediateFromScan,
  planRemediationFn: planRemediation,
  listPatchArtifactsFn: listPatchArtifacts,
  inspectPatchArtifactFn: inspectPatchArtifact,
  validatePatchArtifactFn: validatePatchArtifact,
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

    if (method === "POST" && url.pathname === "/patches/list") {
      let body: { options?: unknown };
      try {
        body = (await readBody(req)) as typeof body;
      } catch {
        return send(res, 400, { error: "Invalid JSON body" });
      }
      try {
        const report = await deps.listPatchArtifactsFn(body.options as PatchArtifactQueryOptions);
        return send(res, 200, report);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return send(res, 400, { error: message });
      }
    }

    if (method === "POST" && url.pathname === "/patches/inspect") {
      let body: { patchFilePath?: unknown; options?: unknown };
      try {
        body = (await readBody(req)) as typeof body;
      } catch {
        return send(res, 400, { error: "Invalid JSON body" });
      }
      if (typeof body.patchFilePath !== "string" || !body.patchFilePath) {
        return send(res, 400, { error: "patchFilePath is required (string)" });
      }
      try {
        const report = await deps.inspectPatchArtifactFn(body.patchFilePath, body.options as PatchArtifactQueryOptions);
        return send(res, 200, report);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return send(res, 400, { error: message });
      }
    }

    if (method === "POST" && url.pathname === "/patches/validate") {
      let body: { patchFilePath?: unknown; options?: unknown };
      try {
        body = (await readBody(req)) as typeof body;
      } catch {
        return send(res, 400, { error: "Invalid JSON body" });
      }
      if (typeof body.patchFilePath !== "string" || !body.patchFilePath) {
        return send(res, 400, { error: "patchFilePath is required (string)" });
      }
      try {
        const report = await deps.validatePatchArtifactFn(body.patchFilePath, body.options as PatchArtifactQueryOptions);
        return send(res, 200, report);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return send(res, 400, { error: message });
      }
    }

    return send(res, 404, { error: "Not found" });
  });
}

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
