import { readFileSync } from "node:fs";

export interface NormalizedFinding {
  cveId: string;
  source: "npm-audit" | "yarn-audit" | "sarif";
  packageName?: string;
  severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
}

interface NpmAuditVulnerability {
  name: string;
  via: Array<string | { source?: number; name?: string; url?: string; severity?: string; cwe?: string[]; cvss?: { score?: number } }>;
  severity?: string;
}

interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
}

const CVE_REGEX = /CVE-\d{4}-\d+/gi;

function normalizeSeverity(raw?: string): NormalizedFinding["severity"] {
  if (!raw) return "UNKNOWN";
  const up = raw.toUpperCase();
  if (up === "CRITICAL" || up === "HIGH" || up === "MEDIUM" || up === "LOW") {
    return up;
  }
  return "UNKNOWN";
}

export function parseNpmAuditJsonFromString(content: string): NormalizedFinding[] {
  const report = JSON.parse(content) as NpmAuditReport;
  const findings: NormalizedFinding[] = [];
  const seen = new Set<string>();

  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const viaEntry of vuln.via ?? []) {
      const text = typeof viaEntry === "string" ? viaEntry : `${viaEntry.url ?? ""} ${viaEntry.name ?? ""}`;
      const matches = text.match(CVE_REGEX) ?? [];
      for (const match of matches) {
        const cveId = match.toUpperCase();
        const key = `${cveId}:${vuln.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          cveId,
          source: "npm-audit",
          packageName: vuln.name,
          severity: normalizeSeverity(vuln.severity),
        });
      }
    }
  }

  return findings;
}

export function parseNpmAuditJsonFile(filePath: string): NormalizedFinding[] {
  const content = readFileSync(filePath, "utf8");
  return parseNpmAuditJsonFromString(content);
}
