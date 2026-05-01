import { readFileSync } from "node:fs";
import type { NormalizedFinding } from "./npm-audit.js";

interface SarifResult {
  ruleId?: string;
  message?: { text?: string };
  properties?: Record<string, unknown>;
}

interface SarifRun {
  results?: SarifResult[];
}

interface SarifReport {
  runs?: SarifRun[];
}

const CVE_REGEX = /CVE-\d{4}-\d{1,7}/gi;

function extractPackageName(result: SarifResult): string | undefined {
  const pkg = result.properties?.["packageName"];
  return typeof pkg === "string" ? pkg : undefined;
}

export function parseSarifFromString(content: string): NormalizedFinding[] {
  const report = JSON.parse(content) as SarifReport;
  const findings: NormalizedFinding[] = [];
  const seen = new Set<string>();

  const MAX_RUNS = 100;
  const MAX_TOTAL_RESULTS = 10_000;
  let totalResults = 0;

  for (const run of (report.runs ?? []).slice(0, MAX_RUNS)) {
    for (const result of run.results ?? []) {
      if (totalResults++ >= MAX_TOTAL_RESULTS) break;
      const ruleId = (result.ruleId ?? "").slice(0, 1024);
      const messageText = (result.message?.text ?? "").slice(0, 4096);
      const combined = `${ruleId} ${messageText}`;
      const matches = combined.match(CVE_REGEX) ?? [];
      for (const match of matches) {
        const cveId = match.toUpperCase();
        const pkg = extractPackageName(result);
        const key = `${cveId}:${pkg ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          cveId,
          source: "sarif",
          packageName: pkg,
          severity: "UNKNOWN",
        });
      }
    }
  }

  return findings;
}

export function parseSarifFile(filePath: string): NormalizedFinding[] {
  const content = readFileSync(filePath, "utf8");
  return parseSarifFromString(content);
}
