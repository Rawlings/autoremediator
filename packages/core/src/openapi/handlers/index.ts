import http from "node:http";
import type { OpenApiServerDeps } from "../server.js";
import { createOpenApiRouteHandlers } from "./routes.js";

export async function handleOpenApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: OpenApiServerDeps
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method?.toUpperCase() ?? "GET";
  const key = `${method} ${url.pathname}`;

  const routes = createOpenApiRouteHandlers(deps);
  const handler = routes.get(key);
  if (!handler) {
    return false;
  }

  await handler(req, res);
  return true;
}