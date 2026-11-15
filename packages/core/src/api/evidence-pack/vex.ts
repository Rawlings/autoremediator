import { randomUUID } from "node:crypto";

import type { CveDetails } from "../../platform/types.js";
import { npmPurl, splitName } from "./components.js";
import type { FindingComponent, VexFinding, VexStatus } from "./findings.js";
import type { CycloneDxComponent, ProductIdentity } from "./sbom.js";

// ---------------------------------------------------------------------------
// CycloneDX 1.6 VEX
// ---------------------------------------------------------------------------

type CdxState = "resolved" | "exploitable" | "in_triage" | "not_affected" | "false_positive";

const CDX_STATE: Record<VexStatus, CdxState> = {
  fixed: "resolved",
  affected: "exploitable",
  not_affected: "not_affected",
  under_investigation: "in_triage",
};

export interface CycloneDxVexVulnerability {
  id: string;
  source?: { name: string; url: string };
  ratings?: Array<{ score?: number; severity: string; method: "other" }>;
  description?: string;
  published?: string;
  advisories?: Array<{ url: string }>;
  recommendation?: string;
  properties?: Array<{ name: string; value: string }>;
  analysis: {
    state: CdxState;
    justification?: string;
    response?: string[];
    detail: string;
  };
  affects?: Array<{
    ref: string;
    versions: Array<{ version: string; status: "affected" | "unaffected" }>;
  }>;
}

export interface CycloneDxVex16 {
  bomFormat: "CycloneDX";
  specVersion: "1.6";
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: { components: CycloneDxComponent[] };
    component: CycloneDxComponent;
    manufacturer?: { name: string };
  };
  components: CycloneDxComponent[];
  vulnerabilities: CycloneDxVexVulnerability[];
}

const SEVERITY: Record<string, string> = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
  UNKNOWN: "unknown",
};

function advisorySource(id: string): { name: string; url: string } | undefined {
  if (/^CVE-\d{4}-\d{4,}$/i.test(id)) {
    return { name: "NVD", url: `https://nvd.nist.gov/vuln/detail/${id.toUpperCase()}` };
  }
  if (/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i.test(id)) {
    return { name: "GitHub Advisory Database", url: `https://github.com/advisories/${id}` };
  }
  return undefined;
}

const isHttpUrl = (value: string): boolean => /^https?:\/\/[^\s]+$/.test(value);
const isDateTime = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);

function libraryComponent(component: FindingComponent): CycloneDxComponent {
  const purl = npmPurl(component.name, component.version);
  return {
    type: "library",
    "bom-ref": purl,
    ...splitName(component.name),
    version: component.version,
    purl,
  };
}

function cdxVulnerability(
  finding: VexFinding,
  details: CveDetails | null | undefined,
  now: string,
): CycloneDxVexVulnerability {
  const source = advisorySource(finding.cveId);
  const references = (details?.references ?? []).filter((url) => isHttpUrl(url));
  const kev = details?.kev;
  const response = finding.updateAvailable ? ["update"] : undefined;
  return {
    id: finding.cveId,
    ...(source ? { source } : {}),
    ...(details?.severity
      ? {
          ratings: [
            {
              ...(details.cvssScore === undefined ? {} : { score: details.cvssScore }),
              severity: SEVERITY[details.severity] ?? "unknown",
              method: "other" as const,
            },
          ],
        }
      : {}),
    ...(details?.summary ? { description: details.summary } : {}),
    ...(details?.publishedAt && isDateTime(details.publishedAt)
      ? { published: details.publishedAt }
      : {}),
    ...(references.length > 0 ? { advisories: references.map((url) => ({ url })) } : {}),
    ...(finding.actionStatement && finding.status === "affected"
      ? { recommendation: finding.actionStatement }
      : {}),
    ...(kev?.knownExploited
      ? {
          properties: [
            { name: "cisa-kev:known-exploited", value: "true" },
            ...(kev.dateAdded ? [{ name: "cisa-kev:date-added", value: kev.dateAdded }] : []),
            ...(kev.dueDate ? [{ name: "cisa-kev:due-date", value: kev.dueDate }] : []),
          ],
        }
      : {}),
    analysis: {
      state: CDX_STATE[finding.status],
      ...(finding.cycloneDxJustification ? { justification: finding.cycloneDxJustification } : {}),
      ...(response ? { response } : {}),
      detail: `${finding.detail} Basis: ${finding.basis === "run" ? `recorded run${finding.runIds.length === 1 ? "" : "s"} ${finding.runIds.join(", ")} read against the current lockfile` : "the project's policy file"}. Generated ${now}.`,
    },
    ...(finding.component
      ? {
          affects: [
            {
              ref: npmPurl(finding.component.name, finding.component.version),
              versions: [
                {
                  version: finding.component.version,
                  status:
                    finding.status === "fixed" ? ("unaffected" as const) : ("affected" as const),
                },
              ],
            },
          ],
        }
      : {}),
  };
}

/**
 * A CycloneDX 1.6 VEX document: one vulnerability per advisory and component, each with the
 * `affects` reference to the component's purl, the analysis state, and where the claim came from.
 * The components it references are listed in the document so it stands alone.
 */
export function buildCycloneDxVex(input: {
  findings: VexFinding[];
  cves: Map<string, CveDetails | null>;
  product: ProductIdentity;
  toolVersion: string;
  now: Date;
}): CycloneDxVex16 {
  const timestamp = input.now.toISOString();
  const referenced = new Map<string, CycloneDxComponent>();
  for (const finding of input.findings) {
    if (finding.component) {
      referenced.set(
        npmPurl(finding.component.name, finding.component.version),
        libraryComponent(finding.component),
      );
    }
  }
  const productRef =
    input.product.purl ??
    `product:${input.product.name}${input.product.version ? `@${input.product.version}` : ""}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp,
      tools: {
        components: [
          {
            type: "application",
            "bom-ref": "autoremediator",
            name: "autoremediator",
            version: input.toolVersion,
          },
        ],
      },
      component: {
        type: "application",
        "bom-ref": productRef,
        ...splitName(input.product.name),
        ...(input.product.version ? { version: input.product.version } : {}),
        ...(input.product.purl ? { purl: input.product.purl } : {}),
      },
      ...(input.product.manufacturer ? { manufacturer: { name: input.product.manufacturer } } : {}),
    },
    components: [...referenced.values()].toSorted((a, b) =>
      a["bom-ref"].localeCompare(b["bom-ref"]),
    ),
    vulnerabilities: input.findings.map((finding) =>
      cdxVulnerability(finding, input.cves.get(finding.cveId), timestamp),
    ),
  };
}

// ---------------------------------------------------------------------------
// OpenVEX v0.2.0
// ---------------------------------------------------------------------------

export const OPENVEX_CONTEXT = "https://openvex.dev/ns/v0.2.0";

export interface OpenVexStatement {
  vulnerability: { name: string; aliases?: string[] };
  timestamp: string;
  products: Array<{
    "@id": string;
    identifiers?: { purl: string };
    subcomponents?: Array<{ "@id": string; identifiers: { purl: string } }>;
  }>;
  status: VexStatus;
  justification?: string;
  impact_statement?: string;
  action_statement?: string;
  action_statement_timestamp?: string;
  status_notes?: string;
}

export interface OpenVexDocument {
  "@context": typeof OPENVEX_CONTEXT;
  "@id": string;
  author: string;
  role?: string;
  timestamp: string;
  version: number;
  tooling: string;
  statements: OpenVexStatement[];
}

function openVexStatement(
  finding: VexFinding,
  product: ProductIdentity,
  now: string,
): OpenVexStatement {
  const productId =
    product.purl ??
    `urn:product:${encodeURIComponent(product.name)}${product.version ? `@${encodeURIComponent(product.version)}` : ""}`;
  const componentPurl = finding.component
    ? npmPurl(finding.component.name, finding.component.version)
    : undefined;
  const basis =
    finding.basis === "run"
      ? `recorded run${finding.runIds.length === 1 ? "" : "s"} ${finding.runIds.join(", ")}`
      : "the project's policy file";
  const needsImpact = finding.status === "not_affected" && !finding.openVexJustification;
  return {
    vulnerability: { name: finding.cveId },
    timestamp: now,
    products: [
      {
        "@id": productId,
        ...(product.purl ? { identifiers: { purl: product.purl } } : {}),
        ...(componentPurl
          ? { subcomponents: [{ "@id": componentPurl, identifiers: { purl: componentPurl } }] }
          : {}),
      },
    ],
    status: finding.status,
    ...(finding.status === "not_affected" && finding.openVexJustification
      ? { justification: finding.openVexJustification }
      : {}),
    // OpenVEX asks for a justification or an impact statement when nothing is affected.
    ...(needsImpact || (finding.status === "not_affected" && finding.impactStatement)
      ? { impact_statement: finding.impactStatement ?? finding.detail }
      : {}),
    ...(finding.status === "affected"
      ? {
          action_statement: finding.actionStatement ?? "No remediation has been recorded.",
          action_statement_timestamp: now,
        }
      : {}),
    status_notes: `${finding.detail} Basis: ${basis}.`,
  };
}

export function buildOpenVex(input: {
  findings: VexFinding[];
  product: ProductIdentity;
  author?: string;
  toolVersion: string;
  now: Date;
}): OpenVexDocument {
  const timestamp = input.now.toISOString();
  return {
    "@context": OPENVEX_CONTEXT,
    "@id": `urn:uuid:${randomUUID()}`,
    author:
      input.author ??
      `Unreviewed draft generated by autoremediator ${input.toolVersion} for ${input.product.name}`,
    timestamp,
    version: 1,
    tooling: `autoremediator ${input.toolVersion}`,
    statements: input.findings.map((finding) =>
      openVexStatement(finding, input.product, timestamp),
    ),
  };
}
