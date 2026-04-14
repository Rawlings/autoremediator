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
  updateOutdated,
  validatePatchArtifact,
} from "../api/index.js";
import { OPENAPI_SPEC } from "./spec/index.js";
import { handleOpenApiRequest } from "./handlers/index.js";
import { parsePort, sendJson } from "./http-utils.js";

export { OPENAPI_SPEC } from "./spec/index.js";

export interface OpenApiServerDeps {
  remediateFn: typeof remediate;
  remediateFromScanFn: typeof remediateFromScan;
  planRemediationFn: typeof planRemediation;
  updateOutdatedFn: typeof updateOutdated;
  listPatchArtifactsFn: typeof listPatchArtifacts;
  inspectPatchArtifactFn: typeof inspectPatchArtifact;
  validatePatchArtifactFn: typeof validatePatchArtifact;
}

const defaultDeps: OpenApiServerDeps = {
  remediateFn: remediate,
  remediateFromScanFn: remediateFromScan,
  planRemediationFn: planRemediation,
  updateOutdatedFn: updateOutdated,
  listPatchArtifactsFn: listPatchArtifacts,
  inspectPatchArtifactFn: inspectPatchArtifact,
  validatePatchArtifactFn: validatePatchArtifact,
};

export function createOpenApiServer(deps: OpenApiServerDeps = defaultDeps): http.Server {
  return http.createServer(async (req, res) => {
    if (await handleOpenApiRequest(req, res, deps)) {
      return;
    }
    return sendJson(res, 404, { error: "Not found" });
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
