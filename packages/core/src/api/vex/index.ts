import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { PatchResult, RemediationReport, VexSuppression } from "../../platform/types.js";
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

const isResolved = (result: PatchResult): boolean => result.applied && !result.unresolvedReason;
const isSuppressed = (result: PatchResult): boolean => result.suppressedBy != null;

/**
 * Map one CVE's remediation outcome to a CycloneDX VEX analysis.
 *
 * VEX states are assertions that downstream consumers act on, so each one is only claimed when it
 * holds for *every* affected package: `resolved` when all are fixed, `not_affected` when all carry
 * an explicit suppression. Reachability is a static import scan, a heuristic, so it is reported as
 * triage evidence and never promoted to `not_affected`.
 */
function mapReportToVulnerability(report: RemediationReport): CycloneDxVexVulnerability {
  const { results } = report;
  const resolved = results.filter(isResolved);

  if (results.length > 0 && results.every((r) => isSuppressed(r))) {
    const suppression = results[0]!.suppressedBy!;
    return {
      id: report.cveId,
      analysis: {
        state: "not_affected",
        justification: suppression.justification,
        detail: suppression.notes ?? suppression.justification,
      },
    };
  }

  if (resolved.length > 0 && results.every((r) => isResolved(r) || isSuppressed(r))) {
    const response: ("update" | "workaround_available")[] = [];
    if (resolved.some((r) => r.strategy === "version-bump" || r.strategy === "override")) {
      response.push("update");
    }
    if (resolved.some((r) => r.strategy === "patch-file")) response.push("workaround_available");

    return {
      id: report.cveId,
      analysis: { state: "resolved", response: response.length > 0 ? response : undefined },
    };
  }

  const pending = results.filter((r) => !isResolved(r) && !isSuppressed(r));
  const details: string[] = [];
  if (resolved.length > 0) {
    details.push(`${resolved.length} of ${results.length} affected packages remediated`);
  }
  const reasons = [...new Set(pending.map((r) => r.unresolvedReason).filter(Boolean))];
  if (reasons.length > 0) {
    details.push(resolved.length > 0 ? `unresolved: ${reasons.join(", ")}` : reasons.join(", "));
  }
  const unreachable = pending.filter((r) => r.reachability?.status === "not-reachable");
  if (unreachable.length > 0) {
    details.push(
      `static analysis found no usage of ${unreachable.map((r) => r.packageName).join(", ")} (heuristic, not asserted as not_affected)`,
    );
  }

  return {
    id: report.cveId,
    analysis: { state: "in_triage", detail: details.length > 0 ? details.join("; ") : undefined },
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
