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
import { planRemediation, remediate, remediateFromScan } from "../api.js";

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
    { name: "autoremediator", version: "0.1.2" },
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
        cveId: { type: "string", description: "CVE ID, e.g. CVE-2021-23337" },
        cwd: { type: "string", description: "Absolute path to the project root (default: process.cwd())" },
        packageManager: { type: "string", enum: ["npm", "pnpm", "yarn"], description: "Package manager override (auto-detected by default)" },
        dryRun: { type: "boolean", description: "If true, plan changes but write nothing (default: false)" },
        preview: { type: "boolean", description: "If true, enforce non-mutating preview mode" },
        skipTests: { type: "boolean", description: "Skip package-manager test command after applying fix (default: true)" },
        llmProvider: { type: "string", enum: ["openai", "anthropic", "local"], description: "LLM provider override" },
        patchesDir: { type: "string", description: "Directory to write .patch files (default: ./patches)" },
        requestId: { type: "string", description: "Request correlation ID" },
        sessionId: { type: "string", description: "Session correlation ID" },
        parentRunId: { type: "string", description: "Parent run correlation ID" },
        idempotencyKey: { type: "string", description: "Idempotency key for replay-safe execution" },
        resume: { type: "boolean", description: "Return cached result for matching idempotency key when available" },
        actor: { type: "string", description: "Actor identity for evidence provenance" },
        source: { type: "string", enum: ["cli", "sdk", "mcp", "openapi", "unknown"], description: "Source system for provenance" },
        constraints: {
          type: "object",
          properties: {
            directDependenciesOnly: { type: "boolean" },
            preferVersionBump: { type: "boolean" },
          },
        },
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
        cveId: { type: "string", description: "CVE ID, e.g. CVE-2021-23337" },
        cwd: { type: "string", description: "Absolute path to the project root (default: process.cwd())" },
        packageManager: { type: "string", enum: ["npm", "pnpm", "yarn"], description: "Package manager override (auto-detected by default)" },
        skipTests: { type: "boolean", description: "Skip package-manager test command after applying fix (default: true)" },
        llmProvider: { type: "string", enum: ["openai", "anthropic", "local"], description: "LLM provider override" },
        patchesDir: { type: "string", description: "Directory to write .patch files (default: ./patches)" },
        requestId: { type: "string", description: "Request correlation ID" },
        sessionId: { type: "string", description: "Session correlation ID" },
        parentRunId: { type: "string", description: "Parent run correlation ID" },
        idempotencyKey: { type: "string", description: "Idempotency key for replay-safe execution" },
        resume: { type: "boolean", description: "Return cached result for matching idempotency key when available" },
        actor: { type: "string", description: "Actor identity for evidence provenance" },
        source: { type: "string", enum: ["cli", "sdk", "mcp", "openapi", "unknown"], description: "Source system for provenance" },
        constraints: {
          type: "object",
          properties: {
            directDependenciesOnly: { type: "boolean" },
            preferVersionBump: { type: "boolean" },
          },
        },
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
        inputPath: { type: "string", description: "Absolute path to the scanner output file" },
        cwd: { type: "string", description: "Absolute path to the project root" },
        packageManager: { type: "string", enum: ["npm", "pnpm", "yarn"], description: "Package manager override (auto-detected by default)" },
        format: { type: "string", enum: ["auto", "npm-audit", "yarn-audit", "sarif"], description: "Scanner format (default: auto)" },
        dryRun: { type: "boolean", description: "If true, plan changes but write nothing" },
        preview: { type: "boolean", description: "If true, enforce non-mutating preview mode" },
        writeEvidence: { type: "boolean", description: "Write evidence JSON to .autoremediator/evidence/ (default: true)" },
        requestId: { type: "string", description: "Request correlation ID" },
        sessionId: { type: "string", description: "Session correlation ID" },
        parentRunId: { type: "string", description: "Parent run correlation ID" },
        idempotencyKey: { type: "string", description: "Idempotency key for replay-safe execution" },
        resume: { type: "boolean", description: "Return cached result for matching idempotency key when available" },
        actor: { type: "string", description: "Actor identity for evidence provenance" },
        source: { type: "string", enum: ["cli", "sdk", "mcp", "openapi", "unknown"], description: "Source system for provenance" },
        constraints: {
          type: "object",
          properties: {
            directDependenciesOnly: { type: "boolean" },
            preferVersionBump: { type: "boolean" },
          },
        },
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
