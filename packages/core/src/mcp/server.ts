#!/usr/bin/env node
/**
 * autoremediator MCP server
 *
 * Exposes all autoremediator tools via the Model Context Protocol so LLM hosts
 * and compatible agent hosts can invoke them directly.
 *
 * Start: autoremediator-mcp            (stdio)
 *        autoremediator-mcp --http     (stateless streamable HTTP on 127.0.0.1; see mcp/http.ts)
 */
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  type ApiDeps,
  type CallOptions,
  callMcpOperation,
  defaultApiDeps,
  type McpToolResult,
  type Operation,
  toMcpTools,
} from "../catalog/index.js";
import { isEntrypoint } from "../platform/entrypoint.js";
import { PACKAGE_VERSION } from "../version.js";
import { getPrompt, listPrompts } from "./prompts.js";
import { listResources, readResource, RESOURCE_TEMPLATES } from "./resources.js";

/** The SDK functions the tools call; replaceable in tests. */
export type McpApiDeps = ApiDeps;

/** Tool definitions, generated from the operation catalog. */
export const TOOLS = toMcpTools();

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> = {},
  deps: McpApiDeps = defaultApiDeps,
  options?: CallOptions,
): Promise<McpToolResult> {
  return callMcpOperation(name, args, deps, options);
}

/** Roots the connected client declared, as filesystem paths; empty when it declared none. */
async function clientRootPaths(server: Server): Promise<string[]> {
  if (!server.getClientCapabilities()?.roots) return [];
  try {
    const { roots } = await server.listRoots();
    return roots.flatMap((root) => {
      try {
        return root.uri.startsWith("file:") ? [fileURLToPath(root.uri)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export interface McpServerOptions {
  /** The SDK functions the tools call (default: the real ones). */
  deps?: ApiDeps;
  /**
   * `mutating`: before a tool that changes the project runs, ask the user to confirm through the
   * client (MCP elicitation). A client that cannot ask is refused rather than trusted, so only set
   * this for clients that support it. Default: `AUTOREMEDIATOR_MCP_CONFIRM`, else `off` (hosts
   * already ask about tools annotated as destructive).
   */
  confirm?: "off" | "mutating";
  /** The project whose runs resources expose (default: the client's first root, else the working directory). */
  projectDir?: string;
}

/** The identifying part of a call, for a confirmation prompt. */
function describeCall(input: Record<string, unknown>): string {
  const parts = ["cveId", "runId", "itemId", "attemptId", "inputPath", "cwd"]
    .filter((key) => typeof input[key] === "string")
    .map((key) => `${key} ${String(input[key])}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

async function confirmWithUser(
  server: Server,
  operation: Operation,
  input: Record<string, unknown>,
): Promise<boolean> {
  if (!server.getClientCapabilities()?.elicitation) {
    throw new Error(
      "This server is set to confirm changes with the user, but the client cannot ask (no elicitation support). Set AUTOREMEDIATOR_MCP_CONFIRM=off, or use a client that supports it.",
    );
  }
  const answer = await server.elicitInput({
    message: `${operation.title}${describeCall(input)}. This can change files in the project. Proceed?`,
    requestedSchema: {
      type: "object",
      properties: { proceed: { type: "boolean", title: "Proceed" } },
      required: ["proceed"],
    },
  });
  return answer.action === "accept" && answer.content?.["proceed"] === true;
}

export function createMcpServer(options: McpServerOptions = {}): Server {
  const deps = options.deps ?? defaultApiDeps;
  const confirm =
    options.confirm ??
    (process.env["AUTOREMEDIATOR_MCP_CONFIRM"] === "mutating" ? "mutating" : "off");

  const server = new Server(
    { name: "autoremediator", version: PACKAGE_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const projectDir = async (): Promise<string> =>
    options.projectDir ?? (await clientRootPaths(server))[0] ?? process.cwd();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args ?? {}, deps, {
      clientRoots: await clientRootPaths(server),
      ...(confirm === "mutating"
        ? {
            confirm: (operation: Operation, input: Record<string, unknown>) =>
              confirmWithUser(server, operation, input),
          }
        : {}),
    });
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () =>
    listResources({ projectDir: await projectDir() }),
  );
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [...RESOURCE_TEMPLATES],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readResource(request.params.uri, { projectDir: await projectDir() }),
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () => listPrompts());
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getPrompt(request.params.name, request.params.arguments ?? {}),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function startMcpServer(): Promise<void> {
  if (process.argv.includes("--http")) {
    // Not awaited: `http.js` imports this module, so waiting for it here while this module is still
    // evaluating would deadlock. The listening server keeps the process alive.
    void import("./http.js").then(({ startMcpHttpServer }) => startMcpHttpServer());
    return;
  }
  const transport = new StdioServerTransport();
  const server = createMcpServer();
  await server.connect(transport);
}

if (isEntrypoint(import.meta.url)) {
  await startMcpServer();
}
