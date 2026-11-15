/**
 * The MCP server over streamable HTTP, stateless: every request stands alone, so there is no session
 * to hijack, lose or leak. It listens on loopback only and uses the same bearer-token roles as the
 * HTTP API: reading needs `reader`, and each tool needs the role its annotations imply (a tool that
 * can change the project needs `admin`).
 *
 * Start: autoremediator-mcp --http [--port 3001]
 */
import http from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { authorizeRole, type Role } from "../../infra/http/http-auth.js";
import { HttpError, isHostAllowed, readBody, sendJson } from "../../infra/http/http-security.js";
import { type ApiDeps, getOperation, mcpOperations, roleFor } from "../catalog/index.js";
import { createMcpServer } from "./server.js";

const DEFAULT_PORT = 3001;
const ROLE_RANK: Record<Role, number> = { reader: 1, operator: 2, admin: 3 };

/** The strongest role any message in the request needs. */
export function requiredRole(body: unknown): { role: Role; label: string } {
  const messages = Array.isArray(body) ? body : [body];
  let required: { role: Role; label: string } = { role: "reader", label: "MCP" };
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
    if (method !== "tools/call" || typeof params?.name !== "string") continue;
    const operation =
      mcpOperations.find((candidate) => candidate.name === params.name) ??
      getOperation(params.name);
    if (!operation) continue;
    const role = roleFor(operation);
    if (ROLE_RANK[role] > ROLE_RANK[required.role])
      required = { role, label: `tool ${operation.name}` };
  }
  return required;
}

export interface McpHttpOptions {
  deps?: ApiDeps;
  projectDir?: string;
}

export function createMcpHttpServer(options: McpHttpOptions = {}): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        // Reject unexpected Host headers: stops DNS-rebinding pages from reaching a loopback server.
        if (!isHostAllowed(req)) return sendJson(res, 403, { error: "Host not allowed" });

        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (path !== "/mcp") return sendJson(res, 404, { error: "Not found" });
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return sendJson(res, 405, { error: "This server is stateless: use POST /mcp" });
        }

        const body = await readBody(req);
        const { role, label } = requiredRole(body);
        const decision = authorizeRole(req, role, label);
        if (!decision.ok) return sendJson(res, decision.status, { error: decision.error });

        // A fresh server per request: nothing carries over between calls. Confirmation by
        // elicitation needs a session, so over HTTP the role check is the gate.
        const server = createMcpServer({
          deps: options.deps,
          confirm: "off",
          projectDir: options.projectDir,
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message });
          if (error.status === 413) res.once("finish", () => req.destroy());
          return;
        }
        // Never echo internal error details to the client.
        console.error("autoremediator MCP HTTP server error:", error);
        sendJson(res, 500, { error: "Internal Server Error" });
      }
    })();
  });
}

function parsePort(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const index = argv.indexOf("--port");
  const raw = index === -1 ? (env["AUTOREMEDIATOR_MCP_PORT"] ?? env["PORT"]) : argv[index + 1];
  const port = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(port) ? DEFAULT_PORT : port;
}

export function startMcpHttpServer(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): http.Server {
  const port = parsePort(argv, env);
  const server = createMcpHttpServer();
  server.listen(port, "127.0.0.1", () => {
    console.error(`autoremediator MCP server listening on http://127.0.0.1:${port}/mcp`);
  });
  return server;
}
