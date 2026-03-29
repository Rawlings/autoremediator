#!/usr/bin/env node
/**
 * autoremediator MCP server
 *
 * Exposes all autoremediator tools via the Model Context Protocol so LLM hosts
 * (Claude Desktop, Cursor, Copilot, etc.) can invoke them directly.
 *
 * Start: autoremediator-mcp   (stdio transport)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import {
  createRemediateOptionSchemaProperties,
  createScanOptionSchemaProperties,
  OPTION_DESCRIPTIONS,
  planRemediation,
  remediate,
  remediateFromScan,
} from "../api/index.js";
import { PACKAGE_VERSION } from "../version";

interface McpApiDeps {
  remediateFn: typeof remediate;
  planRemediationFn: typeof planRemediation;
  remediateFromScanFn: typeof remediateFromScan;
}

const defaultDeps: McpApiDeps = {
  remediateFn: remediate,
  planRemediationFn: planRemediation,
  remediateFromScanFn: remediateFromScan,
};

function createBaseServer(): Server {
  return new Server(
    { name: "autoremediator", version: PACKAGE_VERSION },
    { capabilities: { tools: {} } }
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: "remediate",
    description:
      "Remediate a single CVE in a Node.js project. Looks up the CVE, scans the project inventory, and applies a version bump or generates a patch file. Returns a RemediationReport.",
    inputSchema: {
      type: "object",
      required: ["cveId"],
      properties: {
        cveId: { type: "string", description: OPTION_DESCRIPTIONS.cveId },
        ...createRemediateOptionSchemaProperties(),
      },
    },
  },
  {
    name: "planRemediation",
    description:
      "Generate a non-mutating remediation preview for a single CVE in a Node.js project. Returns a RemediationReport with planned results.",
    inputSchema: {
      type: "object",
      required: ["cveId"],
      properties: {
        cveId: { type: "string", description: OPTION_DESCRIPTIONS.cveId },
        ...createRemediateOptionSchemaProperties({ includeDryRun: false, includePreview: false, includeEvidence: true }),
      },
    },
  },
  {
    name: "remediateFromScan",
    description:
      "Parse an npm/pnpm/yarn audit JSON or SARIF scan file, extract all CVE IDs, and remediate each one. Returns a ScanReport.",
    inputSchema: {
      type: "object",
      required: ["inputPath"],
      properties: {
        inputPath: { type: "string", description: OPTION_DESCRIPTIONS.inputPath },
        ...createScanOptionSchemaProperties(),
      },
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> = {},
  deps: McpApiDeps = defaultDeps
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const withMcpSource = (options: Record<string, unknown>): Record<string, unknown> => ({
    ...options,
    source: typeof options.source === "string" ? options.source : "mcp",
  });

  try {
    if (name === "remediate") {
      const { cveId, ...options } = args as { cveId: string; [key: string]: unknown };
      const report = await deps.remediateFn(cveId, withMcpSource(options) as Parameters<typeof remediate>[1]);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "planRemediation") {
      const { cveId, ...options } = args as { cveId: string; [key: string]: unknown };
      const report = await deps.planRemediationFn(cveId, withMcpSource(options) as Parameters<typeof planRemediation>[1]);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "remediateFromScan") {
      const { inputPath, ...options } = args as { inputPath: string; [key: string]: unknown };
      const report = await deps.remediateFromScanFn(inputPath, withMcpSource(options) as Parameters<typeof remediateFromScan>[1]);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

export function createMcpServer(): Server {
  const server = createBaseServer();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, (args ?? {}) as Record<string, unknown>);
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

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  await startMcpServer();
}
