import http from "node:http";
import type { OpenApiServerDeps } from "../server.js";
import { createOpenApiRouteHandlers } from "./routes.js";
import { sendJson } from "../http-utils.js";
import { checkRbacAuthorization } from "../rbac.js";

function isHostAllowed(req: http.IncomingMessage): boolean {
  const configured = process.env.AUTOREMEDIATOR_ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowed =
    configured && configured.length > 0 ? configured : ["127.0.0.1", "localhost", "[::1]"];
  const host = String(req.headers.host ?? "").toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return allowed.includes(name);
}

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
  const key = `${method} ${url.pathname}`;

  const routes = createOpenApiRouteHandlers(deps);
  const handler = routes.get(key);

  // Parametric route: GET /jobs/:jobId
  if (!handler && method === "GET" && url.pathname.startsWith("/jobs/")) {
    if (!checkRbacAuthorization(req, res, "GET /jobs")) {
      return true;
    }
    const jobId = url.pathname.slice("/jobs/".length);
    if (jobId && !jobId.includes("/")) {
      try {
        const job = deps.pollJobFn(jobId);
        sendJson(res, 200, job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 404, { error: message });
      }
      return true;
    }
  }

  if (!handler) {
    return false;
  }

  if (!checkRbacAuthorization(req, res, key)) {
    return true;
  }

  await handler(req, res);
  return true;
}
