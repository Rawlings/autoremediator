export type JsonSchemaProperty = Record<string, unknown>;

export const PACKAGE_MANAGER_VALUES = ["npm", "pnpm", "yarn"] as const;
export const LLM_PROVIDER_VALUES = ["remote", "local"] as const;
export const PROVENANCE_SOURCE_VALUES = ["cli", "sdk", "mcp", "openapi", "unknown"] as const;

export const OPTION_DESCRIPTIONS = {
  cveId: "CVE ID, e.g. CVE-2021-23337",
  inputPath: "Absolute path to the scanner output file",
  cwd: "Absolute path to the project root (default: process.cwd())",
  packageManager: "Package manager override (auto-detected by default)",
  dryRun: "If true, plan changes but write nothing",
  preview: "If true, enforce non-mutating preview mode",
  runTests: "Run package-manager test command after applying fix",
  llmProvider: "LLM provider override (remote|local)",
  model: "LLM model override",
  modelPersonality: "Prompt behavior profile: analytical|pragmatic|balanced",
  providerSafetyProfile: "Safety posture profile for confidence gates: strict|relaxed",
  requireConsensusForHighRisk: "Require second-provider agreement for high-risk generated patches",
  consensusProvider: "Provider override for high-risk consensus verification (remote|local)",
  consensusModel: "Model override for high-risk consensus verification",
  patchConfidenceThresholdLow: "Patch acceptance confidence threshold for low-risk patches (0..1)",
  patchConfidenceThresholdMedium: "Patch acceptance confidence threshold for medium-risk patches (0..1)",
  patchConfidenceThresholdHigh: "Patch acceptance confidence threshold for high-risk patches (0..1)",
  dynamicModelRouting: "Enable dynamic model selection by input size",
  dynamicRoutingThresholdChars: "Input size threshold used by dynamic model routing",
  patchesDir: "Directory to write .patch files (default: ./patches)",
  policy: "Optional path to .autoremediator policy file",
  requestId: "Request correlation ID",
  sessionId: "Session correlation ID",
  parentRunId: "Parent run correlation ID",
  idempotencyKey: "Idempotency key for replay-safe execution",
  resume: "Return cached result for matching idempotency key when available",
  actor: "Actor identity for evidence provenance",
  source: "Source system for provenance",
  format: "Scanner format (default: auto)",
  evidence: "Write evidence JSON to .autoremediator/evidence/ (default: true)",
  directDependenciesOnly: "Restrict remediation to direct dependencies only",
  preferVersionBump: "Reject override and patch remediation when version-bump-only policy is required",
  installMode: "Install behavior profile: deterministic|prefer-offline|standard",
  installPreferOffline: "Override prefer-offline flag behavior for install commands",
  enforceFrozenLockfile: "Override frozen lockfile behavior for install commands",
  workspace: "Workspace/package selector for scoped remediation in monorepos",
} as const;

export function createConstraintSchemaProperties(): Record<string, JsonSchemaProperty> {
  return {
    directDependenciesOnly: { type: "boolean", description: OPTION_DESCRIPTIONS.directDependenciesOnly },
    preferVersionBump: { type: "boolean", description: OPTION_DESCRIPTIONS.preferVersionBump },
    installMode: {
      type: "string",
      enum: ["deterministic", "prefer-offline", "standard"],
      description: OPTION_DESCRIPTIONS.installMode,
    },
    installPreferOffline: { type: "boolean", description: OPTION_DESCRIPTIONS.installPreferOffline },
    enforceFrozenLockfile: { type: "boolean", description: OPTION_DESCRIPTIONS.enforceFrozenLockfile },
    workspace: { type: "string", description: OPTION_DESCRIPTIONS.workspace },
  };
}

export function createRemediateOptionSchemaProperties(options?: {
  includeDryRun?: boolean;
  includePreview?: boolean;
  includeEvidence?: boolean;
}): Record<string, JsonSchemaProperty> {
  const includeDryRun = options?.includeDryRun ?? true;
  const includePreview = options?.includePreview ?? true;
  const includeEvidence = options?.includeEvidence ?? true;

  return {
    cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
    packageManager: { type: "string", enum: [...PACKAGE_MANAGER_VALUES], description: OPTION_DESCRIPTIONS.packageManager },
    ...(includeDryRun ? { dryRun: { type: "boolean", description: OPTION_DESCRIPTIONS.dryRun } } : {}),
    ...(includePreview ? { preview: { type: "boolean", description: OPTION_DESCRIPTIONS.preview } } : {}),
    runTests: { type: "boolean", description: OPTION_DESCRIPTIONS.runTests },
    llmProvider: { type: "string", enum: [...LLM_PROVIDER_VALUES], description: OPTION_DESCRIPTIONS.llmProvider },
    model: { type: "string", description: OPTION_DESCRIPTIONS.model },
    modelPersonality: { type: "string", enum: ["analytical", "pragmatic", "balanced"], description: OPTION_DESCRIPTIONS.modelPersonality },
    providerSafetyProfile: { type: "string", enum: ["strict", "relaxed"], description: OPTION_DESCRIPTIONS.providerSafetyProfile },
    requireConsensusForHighRisk: { type: "boolean", description: OPTION_DESCRIPTIONS.requireConsensusForHighRisk },
    consensusProvider: { type: "string", enum: [...LLM_PROVIDER_VALUES], description: OPTION_DESCRIPTIONS.consensusProvider },
    consensusModel: { type: "string", description: OPTION_DESCRIPTIONS.consensusModel },
    patchConfidenceThresholds: {
      type: "object",
      properties: {
        low: { type: "number", minimum: 0, maximum: 1, description: OPTION_DESCRIPTIONS.patchConfidenceThresholdLow },
        medium: { type: "number", minimum: 0, maximum: 1, description: OPTION_DESCRIPTIONS.patchConfidenceThresholdMedium },
        high: { type: "number", minimum: 0, maximum: 1, description: OPTION_DESCRIPTIONS.patchConfidenceThresholdHigh },
      },
    },
    dynamicModelRouting: { type: "boolean", description: OPTION_DESCRIPTIONS.dynamicModelRouting },
    dynamicRoutingThresholdChars: { type: "number", description: OPTION_DESCRIPTIONS.dynamicRoutingThresholdChars },
    patchesDir: { type: "string", description: OPTION_DESCRIPTIONS.patchesDir },
    policy: { type: "string", description: OPTION_DESCRIPTIONS.policy },
    ...(includeEvidence ? { evidence: { type: "boolean", description: OPTION_DESCRIPTIONS.evidence } } : {}),
    requestId: { type: "string", description: OPTION_DESCRIPTIONS.requestId },
    sessionId: { type: "string", description: OPTION_DESCRIPTIONS.sessionId },
    parentRunId: { type: "string", description: OPTION_DESCRIPTIONS.parentRunId },
    idempotencyKey: { type: "string", description: OPTION_DESCRIPTIONS.idempotencyKey },
    resume: { type: "boolean", description: OPTION_DESCRIPTIONS.resume },
    actor: { type: "string", description: OPTION_DESCRIPTIONS.actor },
    source: { type: "string", enum: [...PROVENANCE_SOURCE_VALUES], description: OPTION_DESCRIPTIONS.source },
    constraints: {
      type: "object",
      properties: createConstraintSchemaProperties(),
    },
  };
}

export function createScanOptionSchemaProperties(): Record<string, JsonSchemaProperty> {
  return {
    ...createRemediateOptionSchemaProperties({ includeEvidence: true }),
    format: { type: "string", enum: ["npm-audit", "yarn-audit", "sarif", "auto"], description: OPTION_DESCRIPTIONS.format },
  };
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
    patchesDir: { type: "string" },
    correlation: { type: "object" },
    provenance: { type: "object" },
    constraints: { type: "object" },
    idempotencyKey: { type: "string" },
    llmUsageCount: { type: "number" },
    estimatedCostUsd: { type: "number" },
    totalLlmLatencyMs: { type: "number" },
  };
}
