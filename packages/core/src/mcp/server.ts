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
import { fileURLToPath } from "node:url";
import {
  checkReachability,
  createRemediateOptionSchemaProperties,
  createScanOptionSchemaProperties,
  createUpdateOutdatedOptionSchemaProperties,
  evaluatePackage,
  inspectPatchArtifact,
  listPatchArtifacts,
  OPTION_DESCRIPTIONS,
  planRemediation,
  pollJob,
  remediate,
  remediatePortfolio,
  remediateFromScan,
  scanDelta,
  submitPortfolioJob,
  submitRemediateJob,
  submitScanJob,
  toCycloneDxVex,
  updateOutdated,
  validatePatchArtifact,
} from "../api/index.js";
import { PACKAGE_VERSION } from "../version";

const PATCH_ARTIFACT_SCHEMA_PROPERTIES = {
  cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
  patchesDir: { type: "string", description: OPTION_DESCRIPTIONS.patchesDir },
  packageManager: {
    type: "string",
    enum: ["npm", "pnpm", "yarn", "bun", "deno"],
    description: OPTION_DESCRIPTIONS.packageManager,
  },
} as const;

interface McpApiDeps {
  remediateFn: typeof remediate;
  planRemediationFn: typeof planRemediation;
  remediateFromScanFn: typeof remediateFromScan;
  remediatePortfolioFn: typeof remediatePortfolio;
  updateOutdatedFn: typeof updateOutdated;
  checkReachabilityFn: typeof checkReachability;
  evaluatePackageFn: typeof evaluatePackage;
  scanDeltaFn: typeof scanDelta;
  healthFn: () => Promise<{ status: "ok" }>;
  listPatchArtifactsFn: typeof listPatchArtifacts;
  inspectPatchArtifactFn: typeof inspectPatchArtifact;
  validatePatchArtifactFn: typeof validatePatchArtifact;
  toVexFn: typeof toCycloneDxVex;
  submitRemediateJobFn: typeof submitRemediateJob;
  submitScanJobFn: typeof submitScanJob;
  submitPortfolioJobFn: typeof submitPortfolioJob;
  pollJobFn: typeof pollJob;
}

const defaultDeps: McpApiDeps = {
  remediateFn: remediate,
  planRemediationFn: planRemediation,
  remediateFromScanFn: remediateFromScan,
  remediatePortfolioFn: remediatePortfolio,
  updateOutdatedFn: updateOutdated,
  checkReachabilityFn: checkReachability,
  evaluatePackageFn: evaluatePackage,
  scanDeltaFn: scanDelta,
  healthFn: async () => ({ status: "ok" }),
  listPatchArtifactsFn: listPatchArtifacts,
  inspectPatchArtifactFn: inspectPatchArtifact,
  validatePatchArtifactFn: validatePatchArtifact,
  toVexFn: toCycloneDxVex,
  submitRemediateJobFn: submitRemediateJob,
  submitScanJobFn: submitScanJob,
  submitPortfolioJobFn: submitPortfolioJob,
  pollJobFn: pollJob,
};

function createBaseServer(): Server {
  return new Server(
    { name: "autoremediator", version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: "health",
    description:
      "Health check tool that returns server readiness status, version, registered tool count, and the list of available capability names.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
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
        ...createRemediateOptionSchemaProperties({
          includeDryRun: false,
          includePreview: false,
          includeEvidence: true,
        }),
      },
    },
  },
  {
    name: "remediateFromScan",
    description:
      "Parse an npm/pnpm/yarn/bun audit JSON or SARIF scan file, extract all CVE IDs, and remediate each one. Returns a ScanReport.",
    inputSchema: {
      type: "object",
      required: ["inputPath"],
      properties: {
        inputPath: { type: "string", description: OPTION_DESCRIPTIONS.inputPath },
        ...createScanOptionSchemaProperties(),
      },
    },
  },
  {
    name: "remediatePortfolio",
    description:
      "Run CVE or scan remediation across multiple targets and return an aggregated PortfolioReport.",
    inputSchema: {
      type: "object",
      required: ["targets"],
      properties: {
        targets: {
          type: "array",
          items: {
            type: "object",
            required: ["cwd"],
            properties: {
              cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
              label: { type: "string" },
              cveId: { type: "string", description: OPTION_DESCRIPTIONS.cveId },
              inputPath: { type: "string", description: OPTION_DESCRIPTIONS.inputPath },
              format: { type: "string", enum: ["auto", "npm-audit", "yarn-audit", "sarif"] },
              audit: { type: "boolean", description: OPTION_DESCRIPTIONS.audit },
            },
          },
        },
        ...createRemediateOptionSchemaProperties(),
      },
    },
  },
  {
    name: "listPatchArtifacts",
    description:
      "List stored patch artifacts in the configured patches directory. Returns patch summaries with manifest metadata when available.",
    inputSchema: {
      type: "object",
      properties: {
        ...PATCH_ARTIFACT_SCHEMA_PROPERTIES,
      },
    },
  },
  {
    name: "inspectPatchArtifact",
    description: "Inspect a stored .patch file and its optional manifest metadata.",
    inputSchema: {
      type: "object",
      required: ["patchFilePath"],
      properties: {
        patchFilePath: { type: "string", description: "Path to the .patch file" },
        ...PATCH_ARTIFACT_SCHEMA_PROPERTIES,
      },
    },
  },
  {
    name: "validatePatchArtifact",
    description:
      "Validate a stored patch artifact against its manifest and the current dependency inventory.",
    inputSchema: {
      type: "object",
      required: ["patchFilePath"],
      properties: {
        patchFilePath: { type: "string", description: "Path to the .patch file" },
        ...PATCH_ARTIFACT_SCHEMA_PROPERTIES,
      },
    },
  },
  {
    name: "updateOutdated",
    description:
      "Bump all outdated npm packages to their latest versions without requiring a CVE ID. Respects policy (allowMajorBumps) and supports dry-run. Returns an UpdateOutdatedReport.",
    inputSchema: {
      type: "object",
      properties: createUpdateOutdatedOptionSchemaProperties(),
    },
  },
  {
    name: "toVex",
    description:
      "Convert a ScanReport or RemediationReport to a CycloneDX 1.5 VEX document. Returns a compliance-ready vulnerability exploitability exchange record binding remediation evidence to SBOM vulnerability entries.",
    inputSchema: {
      type: "object",
      required: ["report"],
      properties: {
        report: {
          type: "object",
          description:
            "A ScanReport or RemediationReport object returned by remediate, planRemediation, or remediateFromScan.",
        },
        toolVersion: {
          type: "string",
          description: "Optional tool version to embed in the VEX document metadata.",
        },
      },
    },
  },
  {
    name: "submitRemediateJob",
    description:
      "Submit a single-CVE remediation as a background async job. Returns a JobHandle immediately with a jobId. Use pollJob to check status and retrieve the result.",
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
    name: "submitScanJob",
    description:
      "Submit a scan-file remediation as a background async job. Returns a JobHandle immediately. Use pollJob to check status.",
    inputSchema: {
      type: "object",
      required: ["inputPath"],
      properties: {
        inputPath: { type: "string", description: OPTION_DESCRIPTIONS.inputPath },
        ...createScanOptionSchemaProperties(),
      },
    },
  },
  {
    name: "submitPortfolioJob",
    description:
      "Submit a portfolio remediation as a background async job. Returns a JobHandle immediately. Use pollJob to check status.",
    inputSchema: {
      type: "object",
      required: ["targets"],
      properties: {
        targets: {
          type: "array",
          items: {
            type: "object",
            required: ["cwd"],
            properties: {
              cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
              label: { type: "string" },
              cveId: { type: "string", description: OPTION_DESCRIPTIONS.cveId },
              inputPath: { type: "string", description: OPTION_DESCRIPTIONS.inputPath },
            },
          },
        },
        ...createRemediateOptionSchemaProperties(),
      },
    },
  },
  {
    name: "pollJob",
    description:
      "Poll the status of a submitted background job. Returns the full AsyncRemediationJob including result when status is 'done' or error when 'failed'.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: {
          type: "string",
          description:
            "Job ID returned by submitRemediateJob, submitScanJob, or submitPortfolioJob.",
        },
      },
    },
  },
  {
    name: "checkReachability",
    description:
      "Scan project source files using oxc-parser AST call-graph tracing to check if a package or vulnerable symbol is reachable and invoked.",
    inputSchema: {
      type: "object",
      required: ["packageName"],
      properties: {
        packageName: {
          type: "string",
          description: "Target package name to trace in project source files.",
        },
        cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
        symbol: {
          type: "string",
          description:
            "Optional specific vulnerable function or export symbol to verify in call graph.",
        },
      },
    },
  },
  {
    name: "evaluatePackage",
    description:
      "Pre-flight security evaluator for npm packages. Queries OSV, CISA KEV, and FIRST EPSS telemetry before installation.",
    inputSchema: {
      type: "object",
      required: ["packageName"],
      properties: {
        packageName: { type: "string", description: "Package name to evaluate." },
        version: { type: "string", description: "Optional specific package version." },
        packageManager: {
          type: "string",
          enum: ["npm", "pnpm", "yarn", "bun", "deno"],
          description: OPTION_DESCRIPTIONS.packageManager,
        },
        enrichIntelligence: {
          type: "boolean",
          description: "Enrich with live CISA KEV and EPSS intelligence feeds.",
        },
      },
    },
  },
  {
    name: "scanDelta",
    description:
      "Git-aware delta vulnerability scanner. Identifies new CVEs introduced by uncommitted edits (vs HEAD) or branch differences (vs base branch).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
        baseRef: {
          type: "string",
          description:
            "Git base reference to compare against (e.g. 'HEAD', 'origin/main'). Defaults to 'HEAD'.",
        },
        packageManager: {
          type: "string",
          enum: ["npm", "pnpm", "yarn", "bun", "deno"],
          description: OPTION_DESCRIPTIONS.packageManager,
        },
      },
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> = {},
  deps: McpApiDeps = defaultDeps,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const withMcpSource = (options: Record<string, unknown>): Record<string, unknown> => ({
    ...options,
    source: typeof options.source === "string" ? options.source : "mcp",
  });

  try {
    if (name === "health") {
      const healthStatus = await deps.healthFn();
      const report = {
        ...healthStatus,
        version: PACKAGE_VERSION,
        toolCount: TOOLS.length,
        capabilities: TOOLS.map((t) => t.name),
      };
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "remediate") {
      const { cveId, ...options } = args as { cveId: string; [key: string]: unknown };
      const report = await deps.remediateFn(
        cveId,
        withMcpSource(options) as Parameters<typeof remediate>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "planRemediation") {
      const { cveId, ...options } = args as { cveId: string; [key: string]: unknown };
      const report = await deps.planRemediationFn(
        cveId,
        withMcpSource(options) as Parameters<typeof planRemediation>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "remediateFromScan") {
      const { inputPath, ...options } = args as { inputPath: string; [key: string]: unknown };
      const report = await deps.remediateFromScanFn(
        inputPath,
        withMcpSource(options) as Parameters<typeof remediateFromScan>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "remediatePortfolio") {
      const { targets, ...options } = args as { targets: unknown[]; [key: string]: unknown };
      const report = await deps.remediatePortfolioFn(
        targets as Parameters<typeof remediatePortfolio>[0],
        withMcpSource(options) as Parameters<typeof remediatePortfolio>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "updateOutdated") {
      const report = await deps.updateOutdatedFn(
        withMcpSource(args) as Parameters<typeof updateOutdated>[0],
      );
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "listPatchArtifacts") {
      const report = await deps.listPatchArtifactsFn(
        args as Parameters<typeof listPatchArtifacts>[0],
      );
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "inspectPatchArtifact") {
      const { patchFilePath, ...options } = args as {
        patchFilePath: string;
        [key: string]: unknown;
      };
      const report = await deps.inspectPatchArtifactFn(
        patchFilePath,
        options as Parameters<typeof inspectPatchArtifact>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "validatePatchArtifact") {
      const { patchFilePath, ...options } = args as {
        patchFilePath: string;
        [key: string]: unknown;
      };
      const report = await deps.validatePatchArtifactFn(
        patchFilePath,
        options as Parameters<typeof validatePatchArtifact>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "submitRemediateJob") {
      const { cveId, ...options } = args as { cveId: string; [key: string]: unknown };
      const handle = deps.submitRemediateJobFn(
        cveId,
        withMcpSource(options) as Parameters<typeof submitRemediateJob>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(handle, null, 2) }] };
    }

    if (name === "submitScanJob") {
      const { inputPath, ...options } = args as { inputPath: string; [key: string]: unknown };
      const handle = deps.submitScanJobFn(
        inputPath,
        withMcpSource(options) as Parameters<typeof submitScanJob>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(handle, null, 2) }] };
    }

    if (name === "submitPortfolioJob") {
      const { targets, ...options } = args as { targets: unknown[]; [key: string]: unknown };
      const handle = deps.submitPortfolioJobFn(
        targets as Parameters<typeof submitPortfolioJob>[0],
        withMcpSource(options) as Parameters<typeof submitPortfolioJob>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(handle, null, 2) }] };
    }

    if (name === "pollJob") {
      const { jobId } = args as { jobId: string };
      const job = deps.pollJobFn(jobId);
      return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
    }

    if (name === "checkReachability") {
      const { packageName, cwd, symbol } = args as {
        packageName: string;
        cwd?: string;
        symbol?: string;
      };
      if (!packageName || typeof packageName !== "string") {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "packageName is required (string)" }) },
          ],
          isError: true,
        };
      }
      const assessment = await deps.checkReachabilityFn({ packageName, cwd, symbol });
      return { content: [{ type: "text", text: JSON.stringify(assessment, null, 2) }] };
    }

    if (name === "evaluatePackage") {
      const { packageName, ...options } = args as {
        packageName: string;
        [key: string]: unknown;
      };
      if (!packageName || typeof packageName !== "string") {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "packageName is required (string)" }) },
          ],
          isError: true,
        };
      }
      const report = await deps.evaluatePackageFn(
        packageName,
        options as Parameters<typeof evaluatePackage>[1],
      );
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "scanDelta") {
      const options = args as Parameters<typeof scanDelta>[0];
      const report = await deps.scanDeltaFn(options);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }

    if (name === "toVex") {
      const { report, toolVersion } = args as { report: unknown; toolVersion?: string };
      if (!report || typeof report !== "object") {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "report is required (object)" }) },
          ],
          isError: true,
        };
      }
      const vex = deps.toVexFn(
        report as Parameters<typeof toCycloneDxVex>[0],
        toolVersion ? { toolVersion } : undefined,
      );
      return { content: [{ type: "text", text: JSON.stringify(vex, null, 2) }] };
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
