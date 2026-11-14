#!/usr/bin/env node
/**
 * autoremediator MCP server
 *
 * Exposes all autoremediator tools via the Model Context Protocol so LLM hosts
 * and compatible agent hosts can invoke them directly.
 *
 * Start: autoremediator-mcp   (stdio transport)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  type ApiDeps,
  callMcpOperation,
  defaultApiDeps,
  type McpToolResult,
  toMcpTools,
} from "../catalog/index.js";
import { isEntrypoint } from "../platform/entrypoint.js";
import { PACKAGE_VERSION } from "../version.js";

/** The SDK functions the tools call; replaceable in tests. */
export type McpApiDeps = ApiDeps;

function createBaseServer(): Server {
  return new Server(
    { name: "autoremediator", version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );
}

/** Tool definitions, generated from the operation catalog. */
export const TOOLS = toMcpTools();

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> = {},
  deps: McpApiDeps = defaultApiDeps,
): Promise<McpToolResult> {
  return callMcpOperation(name, args, deps);
}

export function createMcpServer(): Server {
  const server = createBaseServer();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args ?? {});
  });

  return server;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  const server = createMcpServer();
  await server.connect(transport);
}

if (isEntrypoint(import.meta.url)) {
  await startMcpServer();
}
