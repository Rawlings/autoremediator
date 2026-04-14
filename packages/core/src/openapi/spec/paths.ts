import {
  createRemediateOptionSchemaProperties,
  createScanOptionSchemaProperties,
  createScanReportSchemaProperties,
  createUpdateOutdatedOptionSchemaProperties,
  OPTION_DESCRIPTIONS,
} from "../../api/index.js";
import {
  ERROR_RESPONSE_SCHEMA,
  PATCH_ARTIFACT_OPTION_PROPERTIES,
  REMEDIATION_REPORT_SCHEMA,
} from "./schemas.js";

export function createOpenApiPaths() {
  return {
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
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
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
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
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
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
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
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
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
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
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
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
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
    "/update-outdated": {
      post: {
        operationId: "updateOutdated",
        summary: "Bump all outdated npm packages to their latest versions",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  options: {
                    type: "object",
                    description: "UpdateOutdatedOptions",
                    properties: createUpdateOutdatedOptionSchemaProperties(),
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "UpdateOutdatedReport",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    schemaVersion: { type: "string" },
                    status: { type: "string", enum: ["ok", "partial", "failed"] },
                    generatedAt: { type: "string" },
                    outdatedPackages: { type: "array", items: { type: "object" } },
                    successCount: { type: "number" },
                    failedCount: { type: "number" },
                    skippedCount: { type: "number" },
                    errors: { type: "array", items: { type: "object" } },
                    evidenceFile: { type: "string" },
                    patchCount: { type: "number" },
                    constraints: { type: "object" },
                    correlation: { type: "object" },
                    provenance: { type: "object" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid input or update error",
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
          },
        },
      },
    },
  } as const;
}