import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PatchResult, RemediationReport, VexSuppression } from "../../platform/types.js";
import type { ScanReport } from "../contracts.js";
import { npmPurl, splitName } from "../evidence-pack/components.js";

export interface CycloneDxVexVulnerabilityAnalysis {
  state: "resolved" | "not_affected" | "in_triage";
  justification?: "code_not_in_execute_path" | "code_not_reachable" | (string & {});
  detail?: string;
  response?: ("update" | "workaround_available")[];
}

export interface CycloneDxVexVulnerability {
  id: string;
  analysis: CycloneDxVexVulnerabilityAnalysis;
  /** CycloneDX properties: `autoremediator:maintainer-vex` when an installed package ships a verdict, and `autoremediator:proof-of-fix:*` when exploit-proof evidence exists. */
  properties?: Array<{ name: string; value: string }>;
  /** 1.6 output only: the components the advisory matched, by purl. */
  affects?: Array<{ ref: string; versions: Array<{ version: string; status: "affected" }> }>;
}

export interface CycloneDxVexDocument {
  bomFormat: "CycloneDX";
  specVersion: "1.5" | "1.6";
  version: number;
  serialNumber: string;
  metadata: {
    timestamp: string;
    tools: Array<{ name: string; version: string }>;
  };
  /** 1.6 output only: the components `affects` refers to. */
  components?: Array<{
    type: "library";
    "bom-ref": string;
    group?: string;
    name: string;
    version: string;
    purl: string;
  }>;
  vulnerabilities: CycloneDxVexVulnerability[];
}

/** A reproduction script kept by `generateProofOfFix`, as the VEX output refers to it. */
export interface ProofEvidenceRef {
  /** Advisory ids the evidence answers to (the id it was made for and its aliases). */
  advisoryIds: string[];
  packageName: string;
  vulnerableVersion: string;
  fixedVersion: string;
  /** Path of the evidence record, relative to the project. */
  evidencePath: string;
  scriptSha256: string;
  signed: boolean;
}

export interface ToCycloneDxVexOptions {
  toolVersion?: string;
  /** Evidence to cite. Without it the output is unchanged. */
  proofEvidence?: readonly ProofEvidenceRef[];
  /**
   * CycloneDX version to emit (default `1.5`, unchanged). `1.6` additionally gives each
   * vulnerability an `affects` list of purls, and maps policy justifications to values the
   * CycloneDX schema accepts (`mitigated` becomes `protected_by_mitigating_control`; `fixed`
   * becomes state `resolved`; `under_investigation` becomes `in_triage`).
   */
  specVersion?: "1.5" | "1.6";
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
  const vulnerability = mapOutcome(report);
  // Maintainer verdicts are always reported, whether or not policy trusts them. They are what an
  // installed package says about itself, so they are listed as a property and never decide state.
  const claims = report.results.flatMap((result) =>
    (result.maintainerVex ?? []).map(
      (claim) =>
        `${claim.maintainer.name}@${claim.maintainer.version}: not_affected (${claim.justification}) for ${result.packageName}@${result.fromVersion}`,
    ),
  );
  return claims.length > 0
    ? {
        ...vulnerability,
        properties: [...new Set(claims)].map((value) => ({
          name: "autoremediator:maintainer-vex",
          value,
        })),
      }
    : vulnerability;
}

/** CycloneDX analysis justifications that match an OpenVEX one without stretching its meaning. */
const CYCLONEDX_JUSTIFICATION: Record<string, string> = {
  component_not_present: "code_not_present",
  vulnerable_code_not_present: "code_not_present",
  vulnerable_code_not_in_execute_path: "code_not_reachable",
  inline_mitigations_already_exist: "protected_by_mitigating_control",
};

function mapOutcome(report: RemediationReport): CycloneDxVexVulnerability {
  const { results } = report;
  const resolved = results.filter((result) => isResolved(result));

  if (results.length > 0 && results.every((r) => isSuppressed(r))) {
    const first = results[0]!;
    const suppression = first.suppressedBy!;
    if (suppression.source === "maintainer-vex") {
      const openVex = first.maintainerVex?.[0]?.justification;
      const mapped = openVex ? CYCLONEDX_JUSTIFICATION[openVex] : undefined;
      return {
        id: report.cveId,
        analysis: {
          state: "not_affected",
          ...(mapped ? { justification: mapped } : {}),
          detail: `Maintainer VEX, trusted by policy: ${suppression.notes ?? suppression.justification}`,
        },
      };
    }
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

/**
 * Cite exploit-proof evidence for a vulnerability: a reproduction that failed on the vulnerable
 * version and passed on the fixed one. Adds properties and a sentence of detail, and changes
 * nothing else; with no evidence the entry is returned as it was.
 */
function withProofEvidence(
  vulnerability: CycloneDxVexVulnerability,
  report: RemediationReport,
  evidence: readonly ProofEvidenceRef[],
): CycloneDxVexVulnerability {
  const id = report.cveId.toUpperCase();
  const packages = new Set(report.results.map((result) => result.packageName));
  const cited = evidence.filter(
    (ref) => ref.advisoryIds.some((advisoryId) => advisoryId.toUpperCase() === id) && packages.has(ref.packageName),
  );
  if (cited.length === 0) return vulnerability;

  const sentence = cited
    .map(
      (ref) =>
        `exploit-proof evidence ${ref.evidencePath}: a reproduction script fails on ${ref.packageName}@${ref.vulnerableVersion} and passes on ${ref.packageName}@${ref.fixedVersion}${ref.signed ? " (signed)" : ""}`,
    )
    .join("; ");
  const detail = vulnerability.analysis.detail;
  return {
    ...vulnerability,
    analysis: { ...vulnerability.analysis, detail: detail ? `${detail}; ${sentence}` : sentence },
    properties: cited.flatMap((ref) => [
      { name: "autoremediator:proof-of-fix:evidence", value: ref.evidencePath },
      { name: "autoremediator:proof-of-fix:script-sha256", value: ref.scriptSha256 },
    ]),
  };
}

/** The 1.6 form of one vulnerability: schema-valid analysis values, and `affects` by purl. */
function upgradeToSpec16(
  vulnerability: CycloneDxVexVulnerability,
  report: RemediationReport,
): CycloneDxVexVulnerability {
  const { analysis } = vulnerability;
  const suppressed =
    report.results.length > 0 && report.results.every((result) => isSuppressed(result))
      ? report.results[0]!.suppressedBy
      : undefined;
  let next: CycloneDxVexVulnerabilityAnalysis = analysis;
  if (suppressed) {
    const detail = analysis.detail ?? suppressed.justification;
    switch (suppressed.justification) {
      case "not_affected": {
        next = { state: "not_affected", detail };
        break;
      }
      case "mitigated": {
        next = { state: "not_affected", justification: "protected_by_mitigating_control", detail };
        break;
      }
      case "fixed": {
        next = { state: "resolved", detail };
        break;
      }
      case "under_investigation": {
        next = { state: "in_triage", detail };
        break;
      }
    }
  } else if (analysis.justification === "code_not_in_execute_path") {
    // Not a CycloneDX value; reachability is never asserted as not_affected here anyway.
    next = { ...analysis, justification: undefined };
  }
  const seen = new Set<string>();
  const affects: NonNullable<CycloneDxVexVulnerability["affects"]> = [];
  for (const result of report.results) {
    const ref = npmPurl(result.packageName, result.fromVersion);
    if (seen.has(ref)) continue;
    seen.add(ref);
    affects.push({ ref, versions: [{ version: result.fromVersion, status: "affected" }] });
  }
  return { ...vulnerability, analysis: next, ...(affects.length > 0 ? { affects } : {}) };
}

export function toCycloneDxVex(
  report: ScanReport | RemediationReport,
  options: ToCycloneDxVexOptions = {},
): CycloneDxVexDocument {
  const specVersion = options.specVersion ?? "1.5";
  const toolVersion = options.toolVersion ?? "unknown";
  const timestamp = new Date().toISOString();
  const serialNumber = `urn:uuid:${randomUUID()}`;

  let remediationReports: RemediationReport[];

  // Discriminate: ScanReport has `reports` array; RemediationReport has `cveId`
  if ("reports" in report && Array.isArray(report.reports)) {
    remediationReports = report.reports;
  } else {
    remediationReports = [report as RemediationReport];
  }

  const vulnerabilities = remediationReports.map((remediationReport) => {
    const mapped = withProofEvidence(
      mapReportToVulnerability(remediationReport),
      remediationReport,
      options.proofEvidence ?? [],
    );
    return specVersion === "1.6" ? upgradeToSpec16(mapped, remediationReport) : mapped;
  });

  const components: NonNullable<CycloneDxVexDocument["components"]> = [];
  if (specVersion === "1.6") {
    const seen = new Set<string>();
    for (const remediationReport of remediationReports) {
      for (const result of remediationReport.results) {
        const purl = npmPurl(result.packageName, result.fromVersion);
        if (seen.has(purl)) continue;
        seen.add(purl);
        components.push({
          type: "library",
          "bom-ref": purl,
          ...splitName(result.packageName),
          version: result.fromVersion,
          purl,
        });
      }
    }
  }

  return {
    bomFormat: "CycloneDX",
    specVersion,
    version: 1,
    serialNumber,
    metadata: {
      timestamp,
      tools: [{ name: "autoremediator", version: toolVersion }],
    },
    ...(specVersion === "1.6" ? { components } : {}),
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

  if (existingIndex !== -1) {
    doc.vulnerabilities[existingIndex] = vulnEntry;
  } else {
    doc.vulnerabilities.push(vulnEntry);
  }

  doc.metadata.timestamp = new Date().toISOString();
  doc.version = (doc.version ?? 1) + 1;

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
