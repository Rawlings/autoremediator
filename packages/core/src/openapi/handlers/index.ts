import type http from "node:http";

import {
  A2A_ENDPOINT_PATH,
  AGENT_CARD_PATH,
  handleA2aRequest,
  handleAgentCardRequest,
} from "../../a2a/index.js";
import {
  httpOperations,
  inputJsonSchema,
  mapRequestToInput,
  matchHttpRoute,
  routeKey,
} from "../../catalog/index.js";
import { isHostAllowed } from "../../platform/http-security.js";
import {
  assertPathsConfined,
  getAllowedRoots,
  PathNotAllowedError,
} from "../../platform/path-guard.js";
import { sendJson } from "../http-utils.js";
import { checkRbacAuthorization } from "../rbac.js";
import type { OpenApiServerDeps } from "../server.js";
import { OPENAPI_SPEC } from "../spec/index.js";
import { runOperation } from "./run-operation.js";
import { readJsonBody } from "./validators.js";

export async function handleOpenApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: OpenApiServerDeps,
): Promise<boolean> {
  // Reject unexpected Host headers: stops DNS-rebinding pages from reaching a loopback server.
  if (!isHostAllowed(req)) {
    sendJson(res, 403, { error: "Host not allowed" });
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method?.toUpperCase() ?? "GET";

  // Public probe and spec endpoints are not operations.
  if (method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return true;
  }
  if (method === "GET" && url.pathname === "/openapi.json") {
    sendJson(res, 200, OPENAPI_SPEC);
    return true;
  }

  // The A2A Agent Card is public, like the OpenAPI document; the A2A endpoint authenticates itself
  // because the role it needs depends on the operation the message asks for.
  if (method === "GET" && url.pathname === AGENT_CARD_PATH) {
    handleAgentCardRequest(req, res);
    return true;
  }
  if (method === "POST" && url.pathname === A2A_ENDPOINT_PATH) {
    await handleA2aRequest(req, res, deps);
    return true;
  }

  const match = matchHttpRoute(method, url.pathname, httpOperations);
  if (!match) return false;
  const { operation, params } = match;

  if (!checkRbacAuthorization(req, res, routeKey(operation))) return true;

  let body: unknown;
  if (operation.http!.method === "POST") {
    body = await readJsonBody(req, res);
    if (body === undefined) return true;
  }

  const mapping = mapRequestToInput(operation, body, params);
  if (!mapping.ok) {
    sendJson(res, 400, { error: mapping.error });
    return true;
  }

  await runOperation(operation, mapping.input, deps, res, {
    confine: (input) => assertPathsConfined(inputJsonSchema(operation), input, getAllowedRoots()),
    isPathError: (error) => error instanceof PathNotAllowedError,
  });
  return true;
}
