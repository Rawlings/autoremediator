import {
  createRemediateOptionSchemaProperties,
  createScanOptionSchemaProperties,
  createScanReportSchemaProperties,
  OPTION_DESCRIPTIONS,
} from "../api/index.js";
import { PACKAGE_VERSION } from "../version.js";

const PATCH_ARTIFACT_OPTION_PROPERTIES = {
  cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
  patchesDir: { type: "string", description: OPTION_DESCRIPTIONS.patchesDir },
  packageManager: {
    type: "string",
    enum: ["npm", "pnpm", "yarn"],
    description: OPTION_DESCRIPTIONS.packageManager,
  },
} as const;

const REMEDIATION_REPORT_SCHEMA = {
  type: "object",
  properties: {
    cveId: { type: "string" },
    cveDetails: { type: ["object", "null"] },
    vulnerablePackages: { type: "array", items: { type: "object" } },
    results: { type: "array", items: { type: "object" } },
    agentSteps: { type: "number" },
    summary: { type: "string" },
    evidenceFile: { type: "string" },
    llmUsage: { type: "array", items: { type: "object" } },
    correlation: { type: "object" },
    provenance: { type: "object" },
    constraints: { type: "object" },
    resumedFromCache: { type: "boolean" },
  },
} as const;

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "autoremediator",
    version: PACKAGE_VERSION,
    description: "Agentic CVE remediation for Node.js dependency projects",
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local development server",
    },
  ],
  "x-agent-compatible": true,
  "x-agent-use-cases": [
    "plan-first remediation",
    "scanner-driven batch remediation",
    "patch lifecycle validation",
  ],
  paths: {
    "/remediate": {
      post: {
        operationId: "remediate",
        summary: "Remediate a single CVE",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["cveId"],
                properties: {
                  cveId: {
                    type: "string",
                    description: OPTION_DESCRIPTIONS.cveId,
                    pattern: "^CVE-\\d{4}-\\d+$",
                  },
                  options: {
                    type: "object",
                    description: "RemediateOptions",
                    properties: createRemediateOptionSchemaProperties(),
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "RemediationReport",
            content: { "application/json": { schema: REMEDIATION_REPORT_SCHEMA } },
          },
          "400": {
            description: "Invalid input or remediation error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/plan-remediation": {
      post: {
        operationId: "planRemediation",
        summary: "Generate a non-mutating remediation preview",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["cveId"],
                properties: {
                  cveId: {
                    type: "string",
                    description: OPTION_DESCRIPTIONS.cveId,
                    pattern: "^CVE-\\d{4}-\\d+$",
                  },
                  options: {
                    type: "object",
                    description: "RemediateOptions",
                    properties: createRemediateOptionSchemaProperties({
                      includeDryRun: false,
                      includePreview: false,
                      includeEvidence: true,
                    }),
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "RemediationReport",
            content: { "application/json": { schema: REMEDIATION_REPORT_SCHEMA } },
          },
          "400": {
            description: "Invalid input or remediation error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/remediate-from-scan": {
      post: {
        operationId: "remediateFromScan",
        summary: "Parse a scanner file and remediate all found CVEs",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["inputPath"],
                properties: {
                  inputPath: {
                    type: "string",
                    description: OPTION_DESCRIPTIONS.inputPath,
                  },
                  options: {
                    type: "object",
                    description: "ScanOptions",
                    properties: createScanOptionSchemaProperties(),
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ScanReport",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: createScanReportSchemaProperties(),
                },
              },
            },
          },
          "400": {
            description: "Invalid input or remediation error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/patches/list": {
      post: {
        operationId: "listPatchArtifacts",
        summary: "List stored patch artifacts",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  options: {
                    type: "object",
                    description: "PatchArtifactQueryOptions",
                    properties: PATCH_ARTIFACT_OPTION_PROPERTIES,
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Patch artifact summaries",
            content: {
              "application/json": { schema: { type: "array", items: { type: "object" } } },
            },
          },
          "400": {
            description: "Invalid input",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    "/patches/inspect": {
      post: {
        operationId: "inspectPatchArtifact",
        summary: "Inspect a stored patch artifact",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["patchFilePath"],
                properties: {
                  patchFilePath: { type: "string" },
                  options: {
                    type: "object",
                    description: "PatchArtifactQueryOptions",
                    properties: {
                      cwd: PATCH_ARTIFACT_OPTION_PROPERTIES.cwd,
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Patch artifact inspection",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "400": {
            description: "Invalid input",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    "/patches/validate": {
      post: {
        operationId: "validatePatchArtifact",
        summary: "Validate a stored patch artifact",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["patchFilePath"],
                properties: {
                  patchFilePath: { type: "string" },
                  options: {
                    type: "object",
                    description: "PatchArtifactQueryOptions",
                    properties: PATCH_ARTIFACT_OPTION_PROPERTIES,
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Patch artifact validation report",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "400": {
            description: "Invalid input",
            content: {
              "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        operationId: "health",
        summary: "Health check",
        responses: {
          "200": {
            description: "Server is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;