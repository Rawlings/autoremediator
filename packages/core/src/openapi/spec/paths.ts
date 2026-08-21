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
    "/openapi.json": {
      get: {
        operationId: "openapiJson",
        summary: "Get the OpenAPI specification document",
        responses: {
          "200": {
            description: "OpenAPI specification",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                },
              },
            },
          },
        },
      },
    },
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
    "/remediate-portfolio": {
      post: {
        operationId: "remediatePortfolio",
        summary: "Run remediation across multiple targets",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
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
                        format: {
                          type: "string",
                          enum: ["auto", "npm-audit", "yarn-audit", "sarif"],
                        },
                        audit: { type: "boolean", description: OPTION_DESCRIPTIONS.audit },
                      },
                    },
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
            description: "PortfolioReport",
            content: { "application/json": { schema: { type: "object" } } },
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
                    properties: PATCH_ARTIFACT_OPTION_PROPERTIES,
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
    "/vex": {
      post: {
        operationId: "toVex",
        summary: "Convert a ScanReport or RemediationReport to a CycloneDX 1.5 VEX document",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["report"],
                properties: {
                  report: {
                    type: "object",
                    description:
                      "A ScanReport or RemediationReport object returned by remediate, planRemediation, or remediateFromScan.",
                  },
                  options: {
                    type: "object",
                    properties: {
                      toolVersion: {
                        type: "string",
                        description: "Tool version to embed in VEX document metadata.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "CycloneDX 1.5 VEX document",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    bomFormat: { type: "string" },
                    specVersion: { type: "string" },
                    version: { type: "number" },
                    serialNumber: { type: "string" },
                    metadata: { type: "object" },
                    vulnerabilities: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid input",
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
          },
        },
      },
    },
    "/jobs/remediate": {
      post: {
        operationId: "submitRemediateJob",
        summary: "Submit a single-CVE remediation as a background async job",
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
          "202": {
            description: "JobHandle",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jobId: { type: "string" },
                    status: { type: "string", enum: ["pending", "running", "done", "failed"] },
                    submittedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid input",
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
          },
        },
      },
    },
    "/jobs/scan": {
      post: {
        operationId: "submitScanJob",
        summary: "Submit a scan-file remediation as a background async job",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["inputPath"],
                properties: {
                  inputPath: { type: "string", description: OPTION_DESCRIPTIONS.inputPath },
                  options: { type: "object", properties: createScanOptionSchemaProperties() },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "JobHandle",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jobId: { type: "string" },
                    status: { type: "string" },
                    submittedAt: { type: "string" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid input",
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
          },
        },
      },
    },
    "/jobs/portfolio": {
      post: {
        operationId: "submitPortfolioJob",
        summary: "Submit a portfolio remediation as a background async job",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["targets"],
                properties: {
                  targets: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["cwd"],
                      properties: {
                        cwd: { type: "string" },
                        label: { type: "string" },
                        cveId: { type: "string" },
                        inputPath: { type: "string" },
                      },
                    },
                  },
                  options: { type: "object", properties: createRemediateOptionSchemaProperties() },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "JobHandle",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jobId: { type: "string" },
                    status: { type: "string" },
                    submittedAt: { type: "string" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid input",
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
          },
        },
      },
    },
    "/jobs/{jobId}": {
      get: {
        operationId: "pollJob",
        summary: "Poll the status of a submitted background job",
        parameters: [
          {
            name: "jobId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Job ID returned by a submit job endpoint.",
          },
        ],
        responses: {
          "200": {
            description: "AsyncRemediationJob",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jobId: { type: "string" },
                    status: { type: "string", enum: ["pending", "running", "done", "failed"] },
                    submittedAt: { type: "string", format: "date-time" },
                    completedAt: { type: "string", format: "date-time" },
                    result: { type: "object" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
          "404": {
            description: "Job not found",
            content: { "application/json": { schema: ERROR_RESPONSE_SCHEMA } },
          },
        },
      },
    },
  } as const;
}
