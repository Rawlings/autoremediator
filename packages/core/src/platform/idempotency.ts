import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RemediationReport } from "./types.js";

interface IdempotencyEntry {
  key: string;
  cveId: string;
  report: RemediationReport;
  savedAt: string;
}

interface IdempotencyIndex {
  schemaVersion: "1.0";
  entries: Record<string, IdempotencyEntry>;
}

const DEFAULT_INDEX: IdempotencyIndex = {
  schemaVersion: "1.0",
  entries: {},
};

function indexFilePath(cwd: string): string {
  return join(cwd, ".autoremediator", "state", "idempotency.json");
}

function entryKey(idempotencyKey: string, cveId: string): string {
  return `${idempotencyKey}::${cveId.toUpperCase()}`;
}

function loadIndex(cwd: string): IdempotencyIndex {
  const filePath = indexFilePath(cwd);
  if (!existsSync(filePath)) return DEFAULT_INDEX;

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as IdempotencyIndex;
    if (parsed && parsed.schemaVersion === "1.0" && parsed.entries) {
      return parsed;
    }
    return DEFAULT_INDEX;
  } catch {
    return DEFAULT_INDEX;
  }
}

function saveIndex(cwd: string, index: IdempotencyIndex): void {
  const filePath = indexFilePath(cwd);
  mkdirSync(join(cwd, ".autoremediator", "state"), { recursive: true });
  writeFileSync(filePath, JSON.stringify(index, null, 2) + "\n", "utf8");
}

export function readIdempotentReport(
  cwd: string,
  idempotencyKey: string,
  cveId: string
): RemediationReport | undefined {
  const index = loadIndex(cwd);
  const key = entryKey(idempotencyKey, cveId);
  return index.entries[key]?.report;
}

export function storeIdempotentReport(
  cwd: string,
  idempotencyKey: string,
  cveId: string,
  report: RemediationReport
): void {
  const index = loadIndex(cwd);
  const key = entryKey(idempotencyKey, cveId);
  index.entries[key] = {
    key: idempotencyKey,
    cveId: cveId.toUpperCase(),
    report,
    savedAt: new Date().toISOString(),
  };
  saveIndex(cwd, index);
}
