import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RemediationReport, VexSuppression } from "../../platform/types.js";
import type { ScanReport } from "../contracts.js";

export interface CycloneDxVexVulnerabilityAnalysis {
  state: "resolved" | "not_affected" | "in_triage";
  justification?: "code_not_in_execute_path" | "code_not_reachable" | (string & {});
  detail?: string;
  response?: ("update" | "workaround_available")[];
}

export interface CycloneDxVexVulnerability {
  id: string;
  analysis: CycloneDxVexVulnerabilityAnalysis;
}

export interface CycloneDxVexDocument {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: number;
  serialNumber: string;
  metadata: {
    timestamp: string;
    tools: Array<{ name: string; version: string }>;
  };
  vulnerabilities: CycloneDxVexVulnerability[];
}

export interface ToCycloneDxVexOptions {
  toolVersion?: string;
}

function mapReportToVulnerability(report: RemediationReport): CycloneDxVexVulnerability {
  const hasResolved = report.results.some((r) => r.applied && !r.unresolvedReason);
  const hasSuppressed = report.results.some((r) => r.suppressedBy != null);
  const notReachableResult = report.results.find((r) => r.reachability?.status === "not-reachable");

  if (notReachableResult && !hasResolved) {
    return {
      id: report.cveId,
      analysis: {
        state: "not_affected",
        justification: notReachableResult.reachability?.justification ?? "code_not_in_execute_path",
        detail: notReachableResult.reachability?.reason ?? "Code is not in execution path",
      },
    };
  }

  if (hasSuppressed && !hasResolved) {
    const suppressed = report.results.find((r) => r.suppressedBy != null)!;
    return {
      id: report.cveId,
      analysis: {
        state: "not_affected",
        justification: suppressed.suppressedBy!.justification,
        detail: suppressed.suppressedBy!.notes ?? suppressed.suppressedBy!.justification,
      },
    };
  }

  if (hasResolved) {
    const resolvedResults = report.results.filter((r) => r.applied && !r.unresolvedReason);
    const hasVersionBumpOrOverride = resolvedResults.some(
      (r) => r.strategy === "version-bump" || r.strategy === "override",
    );
    const hasPatchFile = resolvedResults.some((r) => r.strategy === "patch-file");

    const response: ("update" | "workaround_available")[] = [];
    if (hasVersionBumpOrOverride) response.push("update");
    if (hasPatchFile) response.push("workaround_available");

    return {
      id: report.cveId,
      analysis: {
        state: "resolved",
        response: response.length > 0 ? response : undefined,
      },
    };
  }

  const firstUnresolved = report.results.find((r) => r.unresolvedReason);
  return {
    id: report.cveId,
    analysis: {
      state: "in_triage",
      detail: firstUnresolved?.unresolvedReason,
    },
  };
}

export function toCycloneDxVex(
  report: ScanReport | RemediationReport,
  options: ToCycloneDxVexOptions = {},
): CycloneDxVexDocument {
  const toolVersion = options.toolVersion ?? "unknown";
  const timestamp = new Date().toISOString();
  const serialNumber = `urn:uuid:${randomUUID()}`;

  let remediationReports: RemediationReport[];

  // Discriminate: ScanReport has `reports` array; RemediationReport has `cveId`
  if ("reports" in report && Array.isArray((report as ScanReport).reports)) {
    remediationReports = (report as ScanReport).reports;
  } else {
    remediationReports = [report as RemediationReport];
  }

  const vulnerabilities = remediationReports.map(mapReportToVulnerability);

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    serialNumber,
    metadata: {
      timestamp,
      tools: [{ name: "autoremediator", version: toolVersion }],
    },
    vulnerabilities,
  };
}

/**
 * Persists or updates a CycloneDX 1.5 VEX document with a suppressed vulnerability entry.
 */
export function saveSuppressionToVexDocument(
  filePath: string,
  suppression: VexSuppression,
  toolVersion = "unknown",
): void {
  const targetDir = dirname(filePath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  let doc: CycloneDxVexDocument;
  if (existsSync(filePath)) {
    try {
      doc = JSON.parse(readFileSync(filePath, "utf8")) as CycloneDxVexDocument;
    } catch {
      doc = createEmptyVexDocument(toolVersion);
    }
  } else {
    doc = createEmptyVexDocument(toolVersion);
  }

  if (!Array.isArray(doc.vulnerabilities)) {
    doc.vulnerabilities = [];
  }

  const existingIndex = doc.vulnerabilities.findIndex(
    (v) => v.id.toUpperCase() === suppression.cveId.toUpperCase(),
  );

  const vulnEntry: CycloneDxVexVulnerability = {
    id: suppression.cveId,
    analysis: {
      state: "not_affected",
      justification: suppression.justification,
      detail: suppression.notes ?? suppression.justification,
    },
  };

  if (existingIndex >= 0) {
    doc.vulnerabilities[existingIndex] = vulnEntry;
  } else {
    doc.vulnerabilities.push(vulnEntry);
  }

  doc.metadata.timestamp = new Date().toISOString();
  doc.version = ((doc.version as number) ?? 1) + 1;

  writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

function createEmptyVexDocument(toolVersion: string): CycloneDxVexDocument {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    serialNumber: `urn:uuid:${randomUUID()}`,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ name: "autoremediator", version: toolVersion }],
    },
    vulnerabilities: [],
  };
}
