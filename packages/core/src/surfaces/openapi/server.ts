/**
 * autoremediator OpenAPI HTTP server
 *
 * Exposes POST /remediate and POST /remediate-from-scan as a lightweight
 * HTTP server using Node.js built-in http module (no framework dependency).
 *
 * Start: node dist/surfaces/openapi/server.js [--port 3000]
 */
import http from "node:http";

import { isEntrypoint } from "../../shared/entrypoint.js";
import { type ApiDeps, defaultApiDeps } from "../catalog/index.js";
import { handleOpenApiRequest } from "./handlers/index.js";
import { parsePort, sendJson } from "./http-utils.js";

export { OPENAPI_SPEC } from "./spec/index.js";

/**
 * The SDK functions the server calls. The ones the original routes needed are required; the rest
 * (reachability, package evaluation, delta scan, patch reconciliation) default to the real
 * implementations.
 */
export type OpenApiServerDeps = Pick<
  ApiDeps,
  | "remediateFn"
  | "remediateFromScanFn"
  | "remediatePortfolioFn"
  | "planRemediationFn"
  | "updateOutdatedFn"
  | "listPatchArtifactsFn"
  | "inspectPatchArtifactFn"
  | "validatePatchArtifactFn"
  | "toVexFn"
  | "submitRemediateJobFn"
  | "submitScanJobFn"
  | "submitPortfolioJobFn"
  | "pollJobFn"
> &
  Partial<ApiDeps>;

const defaultDeps: OpenApiServerDeps = defaultApiDeps;

export function createOpenApiServer(deps: OpenApiServerDeps = defaultDeps): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        if (await handleOpenApiRequest(req, res, deps)) {
          return;
        }
        sendJson(res, 404, { error: "Not found" });
      } catch (err) {
        // Never echo internal error details to the client; log them server-side instead.
        console.error("autoremediator OpenAPI server error:", err);
        sendJson(res, 500, { error: "Internal Server Error" });
      }
    })();
  });
}

if (isEntrypoint(import.meta.url)) {
  const port = parsePort();
  const server = createOpenApiServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`autoremediator OpenAPI server listening on http://127.0.0.1:${port}`);
    console.log(`  OpenAPI spec: http://127.0.0.1:${port}/openapi.json`);
  });
}
