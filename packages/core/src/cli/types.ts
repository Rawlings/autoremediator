export type ScanFormat = "auto" | "npm-audit" | "yarn-audit" | "sarif";

export interface CommandOptions {
  cwd: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  patchesDir?: string;
  dryRun: boolean;
  preview: boolean;
  runTests: boolean;
  json: boolean;
  outputFormat: "json" | "sarif";
  llmProvider?: "remote" | "local";
  model?: string;
  modelPersonality?: "analytical" | "pragmatic" | "balanced";
  providerSafetyProfile?: "strict" | "relaxed";
  requireConsensusForHighRisk: boolean;
  consensusProvider?: "remote" | "local";
  consensusModel?: string;
  patchConfidenceLow?: number;
  patchConfidenceMedium?: number;
  patchConfidenceHigh?: number;
  dynamicModelRouting: boolean;
  dynamicRoutingThresholdChars?: number;
  requestId?: string;
  sessionId?: string;
  parentRunId?: string;
  idempotencyKey?: string;
  resume: boolean;
  actor?: string;
  source?: "cli" | "sdk" | "mcp" | "openapi" | "unknown";
  directDependenciesOnly: boolean;
  preferVersionBump: boolean;
  input?: string;
  format: ScanFormat;
  policy?: string;
  evidence: boolean;
  ci: boolean;
  summaryFile?: string;
}

export function isCveId(value: string): boolean {
  return /^CVE-\d{4}-\d+$/i.test(value);
}
