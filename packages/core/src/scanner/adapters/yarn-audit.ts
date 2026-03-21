import { readFileSync } from "node:fs";
import type { NormalizedFinding } from "./npm-audit.js";

const CVE_REGEX = /CVE-\d{4}-\d+/gi;

function normalizeSeverity(raw?: string): NormalizedFinding["severity"] {
  if (!raw) return "UNKNOWN";
  const up = raw.toUpperCase();
  if (up === "CRITICAL" || up === "HIGH" || up === "MEDIUM" || up === "LOW") {
    return up;
  }
  return "UNKNOWN";
}

export function parseYarnAuditJsonFromString(content: string): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  const seen = new Set<string>();

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const event = parsed as {
      type?: string;
      data?: {
        advisory?: {
          module_name?: string;
          severity?: string;
          url?: string;
          cves?: string[];
        };
      };
    };

    if (event.type !== "auditAdvisory") continue;

    const advisory = event.data?.advisory;
    const packageName = advisory?.module_name;
    const severity = normalizeSeverity(advisory?.severity);

    const text = `${advisory?.url ?? ""} ${(advisory?.cves ?? []).join(" ")}`;
    const matches = text.match(CVE_REGEX) ?? [];

    for (const match of matches) {
      const cveId = match.toUpperCase();
      const key = `${cveId}:${packageName ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({
        cveId,
        source: "yarn-audit",
        packageName,
        severity,
      });
    }
  }

  return findings;
}

export function parseYarnAuditJsonFile(filePath: string): NormalizedFinding[] {
  const content = readFileSync(filePath, "utf8");
  return parseYarnAuditJsonFromString(content);
}
