import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EvidenceStep {
  at: string;
  action: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

export interface EvidenceLog {
  runId: string;
  cveIds: string[];
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  steps: EvidenceStep[];
}

export function createEvidenceLog(cwd: string, cveIds: string[]): EvidenceLog {
  return {
    runId: `${Date.now()}`,
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
