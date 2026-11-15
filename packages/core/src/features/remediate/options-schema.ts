import { z } from "zod";

import {
  constraintsSchema,
  OPTION_DESCRIPTIONS,
  PACKAGE_MANAGER_VALUES,
  PROVENANCE_SOURCE_VALUES,
} from "../../infra/policy/schemas.js";
import {
  remediateOptionsSchema,
  scanOptionsSchema,
  updateOutdatedOptionsSchema,
} from "./option-schemas.js";

export { OPTION_DESCRIPTIONS, PACKAGE_MANAGER_VALUES, PROVENANCE_SOURCE_VALUES };

export type JsonSchemaProperty = Record<string, unknown>;

/**
 * JSON Schema `properties` for a wire schema, as MCP tools and OpenAPI paths advertise them.
 * Generated from the zod definitions in `platform/option-schemas.ts`, which also validate input,
 * so what is advertised and what is accepted cannot differ.
 */
export function jsonSchemaProperties(schema: z.ZodType): Record<string, JsonSchemaProperty> {
  const json = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, JsonSchemaProperty>;
  };
  return json.properties ?? {};
}

export function createConstraintSchemaProperties(): Record<string, JsonSchemaProperty> {
  return jsonSchemaProperties(constraintsSchema);
}

export function createRemediateOptionSchemaProperties(options?: {
  includeDryRun?: boolean;
  includePreview?: boolean;
  includeSimulationMode?: boolean;
  includeEvidence?: boolean;
}): Record<string, JsonSchemaProperty> {
  const omitted = {
    ...(options?.includeDryRun === false ? { dryRun: true as const } : {}),
    ...(options?.includePreview === false ? { preview: true as const } : {}),
    ...(options?.includeSimulationMode === false ? { simulationMode: true as const } : {}),
    ...(options?.includeEvidence === false ? { evidence: true as const } : {}),
  };
  return jsonSchemaProperties(remediateOptionsSchema.omit(omitted));
}

export function createScanOptionSchemaProperties(): Record<string, JsonSchemaProperty> {
  return jsonSchemaProperties(scanOptionsSchema);
}

export function createScanReportSchemaProperties(): Record<string, JsonSchemaProperty> {
  return {
    schemaVersion: { type: "string" },
    status: { type: "string", enum: ["ok", "partial", "failed"] },
    generatedAt: { type: "string" },
    cveIds: { type: "array", items: { type: "string" } },
    reports: { type: "array", items: { type: "object" } },
    successCount: { type: "number" },
    failedCount: { type: "number" },
    errors: { type: "array", items: { type: "object" } },
    evidenceFile: { type: "string" },
    patchCount: { type: "number" },
    patchValidationFailures: { type: "array", items: { type: "object" } },
    strategyCounts: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    dependencyScopeCounts: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    unresolvedByReason: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    escalationCounts: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    patchesDir: { type: "string" },
    correlation: { type: "object" },
    provenance: { type: "object" },
    constraints: { type: "object" },
    idempotencyKey: { type: "string" },
    llmUsageCount: { type: "number" },
    totalInputTokens: { type: "number" },
    totalOutputTokens: { type: "number" },
    totalLlmLatencyMs: { type: "number" },
    changeRequests: { type: "array", items: { type: "object" } },
    simulationSummary: { type: "object" },
  };
}

export function createUpdateOutdatedOptionSchemaProperties(): Record<string, JsonSchemaProperty> {
  return jsonSchemaProperties(updateOutdatedOptionsSchema);
}
