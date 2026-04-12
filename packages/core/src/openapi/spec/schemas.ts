import { OPTION_DESCRIPTIONS } from "../../api/index.js";

export const PATCH_ARTIFACT_OPTION_PROPERTIES = {
  cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
  patchesDir: { type: "string", description: OPTION_DESCRIPTIONS.patchesDir },
  packageManager: {
    type: "string",
    enum: ["npm", "pnpm", "yarn"],
    description: OPTION_DESCRIPTIONS.packageManager,
  },
} as const;

export const REMEDIATION_REPORT_SCHEMA = {
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

export const ERROR_RESPONSE_SCHEMA = {
  type: "object",
  properties: { error: { type: "string" } },
} as const;