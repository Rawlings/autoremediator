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
import { remediate, remediateFromScan } from "../api.js";

const server = new Server(
  { name: "autoremediator", version: "0.1.2" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
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
        skipTests: { type: "boolean", description: "Skip package-manager test command after applying fix (default: true)" },
        llmProvider: { type: "string", enum: ["openai", "anthropic", "local"], description: "LLM provider override" },
        patchesDir: { type: "string", description: "Directory to write .patch files (default: ./patches)" },
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
        writeEvidence: { type: "boolean", description: "Write evidence JSON to .autoremediator/evidence/ (default: true)" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "remediate") {
      const { cveId, ...options } = args as { cveId: string; [key: string]: unknown };
      const report = await remediate(cveId, options as Parameters<typeof remediate>[1]);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "remediateFromScan") {
      const { inputPath, ...options } = args as { inputPath: string; [key: string]: unknown };
      const report = await remediateFromScan(inputPath, options as Parameters<typeof remediateFromScan>[1]);
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
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
