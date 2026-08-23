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
  pollJob,
  remediate,
  remediatePortfolio,
  remediateFromScan,
  submitPortfolioJob,
  submitRemediateJob,
  submitScanJob,
  toCycloneDxVex,
  updateOutdated,
  validatePatchArtifact,
} from "../api/index.js";
import { handleOpenApiRequest } from "./handlers/index.js";
import { parsePort, sendJson } from "./http-utils.js";

export { OPENAPI_SPEC } from "./spec/index.js";

export interface OpenApiServerDeps {
  remediateFn: typeof remediate;
  remediateFromScanFn: typeof remediateFromScan;
  remediatePortfolioFn: typeof remediatePortfolio;
  planRemediationFn: typeof planRemediation;
  updateOutdatedFn: typeof updateOutdated;
  listPatchArtifactsFn: typeof listPatchArtifacts;
  inspectPatchArtifactFn: typeof inspectPatchArtifact;
  validatePatchArtifactFn: typeof validatePatchArtifact;
  toVexFn: typeof toCycloneDxVex;
  submitRemediateJobFn: typeof submitRemediateJob;
  submitScanJobFn: typeof submitScanJob;
  submitPortfolioJobFn: typeof submitPortfolioJob;
  pollJobFn: typeof pollJob;
}

const defaultDeps: OpenApiServerDeps = {
  remediateFn: remediate,
  remediateFromScanFn: remediateFromScan,
  remediatePortfolioFn: remediatePortfolio,
  planRemediationFn: planRemediation,
  updateOutdatedFn: updateOutdated,
  listPatchArtifactsFn: listPatchArtifacts,
  inspectPatchArtifactFn: inspectPatchArtifact,
  validatePatchArtifactFn: validatePatchArtifact,
  toVexFn: toCycloneDxVex,
  submitRemediateJobFn: submitRemediateJob,
  submitScanJobFn: submitScanJob,
  submitPortfolioJobFn: submitPortfolioJob,
  pollJobFn: pollJob,
};

export function createOpenApiServer(deps: OpenApiServerDeps = defaultDeps): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        if (await handleOpenApiRequest(req, res, deps)) {
          return;
        }
        sendJson(res, 404, { error: "Not found" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal Server Error";
        sendJson(res, 500, { error: message });
      }
    })();
  });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  const port = parsePort();
  const server = createOpenApiServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`autoremediator OpenAPI server listening on http://127.0.0.1:${port}`);
    console.log(`  OpenAPI spec: http://127.0.0.1:${port}/openapi.json`);
  });
}
