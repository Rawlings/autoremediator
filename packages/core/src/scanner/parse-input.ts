import { extname } from "node:path";
import { readFileSync } from "node:fs";
import { parseNpmAuditJsonFile, type NormalizedFinding } from "./adapters/npm-audit.js";
import { parseYarnAuditJsonFile } from "./adapters/yarn-audit.js";
import { parseSarifFile } from "./adapters/sarif.js";
import type { ScanInputFormat } from "./index.js";

export function parseScanInput(filePath: string, format: ScanInputFormat): NormalizedFinding[] {
  const resolved = format === "auto" ? inferFormat(filePath) : format;

  if (resolved === "npm-audit") {
    return parseNpmAuditJsonFile(filePath);
  }
  if (resolved === "yarn-audit") {
    return parseYarnAuditJsonFile(filePath);
  }
  if (resolved === "sarif") {
    return parseSarifFile(filePath);
  }

  throw new Error(`Unsupported input format: ${resolved}`);
}

function inferFormat(filePath: string): Exclude<ScanInputFormat, "auto"> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".sarif") return "sarif";

  try {
    const content = readFileSync(filePath, "utf8");
    const firstLine = content.split("\n").find((line) => line.trim().startsWith("{"));
    if (firstLine) {
      const parsed = JSON.parse(firstLine) as { type?: string };
      if (parsed.type === "auditAdvisory" || parsed.type === "auditSummary") {
        return "yarn-audit";
      }
    }
  } catch {
    // Ignore parse failures and fall back to npm-audit.
  }

  return "npm-audit";
}
