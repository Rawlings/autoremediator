export type JsonSchemaProperty = Record<string, unknown>;

export const PACKAGE_MANAGER_VALUES = ["npm", "pnpm", "yarn", "bun", "deno"] as const;
export const LLM_PROVIDER_VALUES = ["remote", "local"] as const;
export const PROVENANCE_SOURCE_VALUES = ["cli", "sdk", "mcp", "openapi", "unknown"] as const;

export const OPTION_DESCRIPTIONS = {
  cveId: "CVE ID, e.g. CVE-2021-23337",
  inputPath: "Absolute path to the scanner output file",
  cwd: "Absolute path to the project root (default: process.cwd())",
  packageManager: "Package manager override (auto-detected by default)",
  dryRun: "If true, plan changes but write nothing",
  preview: "If true, enforce non-mutating preview mode",
  simulationMode: "If true, attach deterministic simulation and rebuttal metadata for dry-run or preview execution",
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
  policy: "Optional path to .github/autoremediator.yml policy file",
  requestId: "Request correlation ID",
  sessionId: "Session correlation ID",
  parentRunId: "Parent run correlation ID",
  idempotencyKey: "Idempotency key for replay-safe execution",
  resume: "Return cached result for matching idempotency key when available",
  actor: "Actor identity for evidence provenance",
  source: "Source system for provenance",
  format: "Scanner format (default: auto)",
  audit: "Run package-manager-native audit command instead of reading a scan file",
  evidence: "Write evidence JSON to .autoremediator/evidence/ (default: true)",
  directDependenciesOnly: "Restrict remediation to direct dependencies only",
  preferVersionBump: "Reject override and patch remediation when version-bump-only policy is required",
  installMode: "Install behavior profile: deterministic|prefer-offline|standard",
  installPreferOffline: "Override prefer-offline flag behavior for install commands",
  enforceFrozenLockfile: "Override frozen lockfile behavior for install commands",
  workspace: "Workspace/package selector for scoped remediation in monorepos",
  createChangeRequest: "Enable creation of native pull request / merge request after remediation",
  changeRequestProvider: "Change request provider (github|gitlab)",
  changeRequestGrouping: "Grouping strategy for change requests (all|per-cve|per-package)",
  changeRequestRepository: "Repository slug override for change request creation",
  changeRequestBaseBranch: "Base branch used for change request targeting",
  changeRequestBranchPrefix: "Branch prefix for generated change request branches",
  changeRequestTitlePrefix: "Title prefix for generated change requests",
  includeTransitive: "Include transitive dependencies in the outdated check. Default: false.",
  updateOutdated: "Run in update-outdated mode: bump all outdated npm packages without requiring a CVE.",
  kevMandatory: "If true, CVEs with active CISA KEV status bypass severity filtering and are treated as mandatory",
  epssThreshold: "EPSS probability threshold (0..1) above which a CVE is treated as mandatory regardless of severity",
  suppressionsFile: "Path to a YAML file containing additional VEX suppression entries to merge with policy-inline suppressions",
  slaCheck: "Compare CVE publication dates against configured SLA windows and include breach records in the report output",
  skipUnreachable: "Skip remediation for CVEs where the vulnerable package cannot be reached from any project entry point (requires static import analysis)",
  regressionCheck: "After applying a fix, verify the patched version falls outside the CVE's vulnerable range and flag any regression in the report",
  dispositionPolicy: "Autonomous disposition policy controlling when fixes are auto-applied, held, or escalated",
  dispositionPolicyMinConfidenceForAutoApply: "Minimum patch confidence (0–1) required for auto-apply disposition",
  dispositionPolicyHoldForTransitive: "Hold transitive dependency fixes for human review instead of auto-applying",
  dispositionPolicyEscalateOnSlaBreachSeverities: "CVE severities that trigger escalate disposition on SLA breach",
  dispositionPolicyEscalateOnKev: "Escalate disposition for CVEs with active CISA KEV status",
  containmentMode: "Block escalation-disposition results from being applied and record containment in evidence",
  campaignMode: "Enable portfolio campaign mode to risk-rank targets before execution",
  escalationGraph: "Optional mapping from unresolved reasons to intended escalation actions",
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
  includeSimulationMode?: boolean;
  includeEvidence?: boolean;
}): Record<string, JsonSchemaProperty> {
  const includeDryRun = options?.includeDryRun ?? true;
  const includePreview = options?.includePreview ?? true;
  const includeSimulationMode = options?.includeSimulationMode ?? true;
  const includeEvidence = options?.includeEvidence ?? true;

  return {
    cwd: { type: "string", description: OPTION_DESCRIPTIONS.cwd },
    packageManager: { type: "string", enum: [...PACKAGE_MANAGER_VALUES], description: OPTION_DESCRIPTIONS.packageManager },
    ...(includeDryRun ? { dryRun: { type: "boolean", description: OPTION_DESCRIPTIONS.dryRun } } : {}),
    ...(includePreview ? { preview: { type: "boolean", description: OPTION_DESCRIPTIONS.preview } } : {}),
    ...(includeSimulationMode ? { simulationMode: { type: "boolean", description: OPTION_DESCRIPTIONS.simulationMode } } : {}),
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
    changeRequest: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: OPTION_DESCRIPTIONS.createChangeRequest },
        provider: {
          type: "string",
          enum: ["github", "gitlab"],
          description: OPTION_DESCRIPTIONS.changeRequestProvider,
        },
        grouping: {
          type: "string",
          enum: ["all", "per-cve", "per-package"],
          description: OPTION_DESCRIPTIONS.changeRequestGrouping,
        },
        repository: { type: "string", description: OPTION_DESCRIPTIONS.changeRequestRepository },
        baseBranch: { type: "string", description: OPTION_DESCRIPTIONS.changeRequestBaseBranch },
        branchPrefix: { type: "string", description: OPTION_DESCRIPTIONS.changeRequestBranchPrefix },
        titlePrefix: { type: "string", description: OPTION_DESCRIPTIONS.changeRequestTitlePrefix },
      },
    },
    kevMandatory: { type: "boolean", description: OPTION_DESCRIPTIONS.kevMandatory },
    epssThreshold: { type: "number", minimum: 0, maximum: 1, description: OPTION_DESCRIPTIONS.epssThreshold },
    suppressionsFile: { type: "string", description: OPTION_DESCRIPTIONS.suppressionsFile },
    slaCheck: { type: "boolean", description: OPTION_DESCRIPTIONS.slaCheck },
    skipUnreachable: { type: "boolean", description: OPTION_DESCRIPTIONS.skipUnreachable },
    regressionCheck: { type: "boolean", description: OPTION_DESCRIPTIONS.regressionCheck },
    dispositionPolicy: {
      type: "object",
      description: OPTION_DESCRIPTIONS.dispositionPolicy,
      properties: {
        minConfidenceForAutoApply: { type: "number", minimum: 0, maximum: 1, description: OPTION_DESCRIPTIONS.dispositionPolicyMinConfidenceForAutoApply },
        holdForTransitive: { type: "boolean", description: OPTION_DESCRIPTIONS.dispositionPolicyHoldForTransitive },
        escalateOnSlaBreachSeverities: {
          type: "array",
          items: { type: "string", enum: ["critical", "high", "medium", "low"] },
          description: OPTION_DESCRIPTIONS.dispositionPolicyEscalateOnSlaBreachSeverities,
        },
        escalateOnKev: { type: "boolean", description: OPTION_DESCRIPTIONS.dispositionPolicyEscalateOnKev },
      },
    },
    containmentMode: { type: "boolean", description: OPTION_DESCRIPTIONS.containmentMode },
    campaignMode: { type: "boolean", description: OPTION_DESCRIPTIONS.campaignMode },
    escalationGraph: {
      type: "object",
      description: OPTION_DESCRIPTIONS.escalationGraph,
      properties: {
        "consensus-failed": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "constraint-blocked": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "transitive-dependency": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "install-failed": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "major-bump-required": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "no-safe-version": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "override-apply-failed": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "package-json-not-found": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "patch-apply-failed": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "patch-confidence-too-low": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "patch-generation-failed": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "patch-validation-failed": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "policy-blocked": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "requires-llm-fallback": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "source-fetch-failed": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
        "validation-failed": {
          type: "string",
          enum: ["open-issue", "notify-channel", "create-draft-pr", "hold-branch", "none"],
        },
      },
      additionalProperties: false,
    },
  };
}

export function createScanOptionSchemaProperties(): Record<string, JsonSchemaProperty> {
  return {
    ...createRemediateOptionSchemaProperties({ includeEvidence: true }),
    format: { type: "string", enum: ["npm-audit", "yarn-audit", "sarif", "auto"], description: OPTION_DESCRIPTIONS.format },
    audit: { type: "boolean", description: OPTION_DESCRIPTIONS.audit },
    slaCheck: { type: "boolean", description: OPTION_DESCRIPTIONS.slaCheck },
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
    estimatedCostUsd: { type: "number" },
    totalLlmLatencyMs: { type: "number" },
    changeRequests: { type: "array", items: { type: "object" } },
    simulationSummary: { type: "object" },
  };
}

export function createUpdateOutdatedOptionSchemaProperties(): Record<string, JsonSchemaProperty> {
  return {
    ...createRemediateOptionSchemaProperties({ includeEvidence: true, includeSimulationMode: false }),
    includeTransitive: { type: "boolean", description: OPTION_DESCRIPTIONS.includeTransitive },
  };
}
