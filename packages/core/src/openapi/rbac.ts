import type http from "node:http";

import { httpOperations, roleFor, routeKey as operationRouteKey } from "../catalog/index.js";
import { authorizeRole, type Role } from "../platform/http-auth.js";
import { sendJson } from "./http-utils.js";

export {
  createSignedJwt,
  getRoleForToken,
  verifyJwtRole,
  type JwtPayload,
  type Role,
} from "../platform/http-auth.js";

/** Minimum role per route, derived from each operation's annotations (read-only, planning, mutating). */
const ROUTE_ROLE_REQUIREMENTS: Record<string, Role> = {
  "GET /health": "reader",
  "GET /openapi.json": "reader",
  ...Object.fromEntries(
    httpOperations.map((operation) => [operationRouteKey(operation), roleFor(operation)]),
  ),
};

/**
 * Verifies if the request is authorized for the given route based on Bearer token.
 */
export function checkRbacAuthorization(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  routeKey: string,
): boolean {
  // Public health and spec endpoints don't require auth
  if (routeKey === "GET /health" || routeKey === "GET /openapi.json") {
    return true;
  }

  const decision = authorizeRole(req, ROUTE_ROLE_REQUIREMENTS[routeKey] ?? "admin", routeKey);
  if (!decision.ok) sendJson(res, decision.status, { error: decision.error });
  return decision.ok;
}
