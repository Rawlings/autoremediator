import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DependencyScopeCounts, PatchStrategyCounts, UnresolvedReasonCounts } from "./types.js";

export interface EvidenceStep {
  at: string;
  action: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

export interface EvidenceSummary {
  status: "ok" | "partial" | "failed";
  cveCount: number;
  remediationCount: number;
  successCount: number;
  failedCount: number;
  patchCount: number;
  patchValidationFailures?: Array<{
    packageName: string;
    cveId: string;
    error: string;
  }>;
  strategyCounts?: PatchStrategyCounts;
  unresolvedByReason?: UnresolvedReasonCounts;
  dependencyScopeCounts?: DependencyScopeCounts;
  patchesDir?: string;
}

export interface EvidenceLog {
  runId: string;
  requestId?: string;
  sessionId?: string;
  parentRunId?: string;
  actor?: string;
  source?: "cli" | "sdk" | "mcp" | "openapi" | "unknown";
  idempotencyKey?: string;
  cveIds: string[];
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  summary?: EvidenceSummary;
  steps: EvidenceStep[];
}

interface EvidenceContext {
  requestId?: string;
  sessionId?: string;
  parentRunId?: string;
  actor?: string;
  source?: "cli" | "sdk" | "mcp" | "openapi" | "unknown";
  idempotencyKey?: string;
}

export function createEvidenceLog(cwd: string, cveIds: string[], context: EvidenceContext = {}): EvidenceLog {
  return {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestId: context.requestId,
    sessionId: context.sessionId,
    parentRunId: context.parentRunId,
    actor: context.actor,
    source: context.source,
    idempotencyKey: context.idempotencyKey,
    cveIds,
    cwd,
    startedAt: new Date().toISOString(),
    steps: [],
  };
}

export function addEvidenceStep(
  log: EvidenceLog,
  action: string,
  input?: Record<string, unknown>,
  output?: Record<string, unknown>,
  error?: string
): void {
  log.steps.push({
    at: new Date().toISOString(),
    action,
    input,
    output,
    error,
  });
}

export function finalizeEvidence(log: EvidenceLog): EvidenceLog {
  log.finishedAt = new Date().toISOString();
  return log;
}

export function writeEvidenceLog(cwd: string, log: EvidenceLog): string {
  const dir = join(cwd, ".autoremediator", "evidence");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${log.runId}.json`);
  writeFileSync(filePath, JSON.stringify(log, null, 2) + "\n", "utf8");
  return filePath;
}
