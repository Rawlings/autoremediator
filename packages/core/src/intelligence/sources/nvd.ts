/**
 * NVD (National Vulnerability Database) API v2 client
 *
 * Used ONLY for fetching authoritative CVSS scores and severity.
 * NVD CPE data is too inconsistent for npm package discovery — use OSV for that.
 *
 * Rate limits: 5 req/30s without key, 50 req/30s with AUTOREMEDIATOR_NVD_API_KEY
 * Uses shared HTTP client for consistent error handling and timeouts.
 */
import type { CveDetails } from "../../platform/types.js";
import { getNvdConfig } from "../../platform/config.js";
import { httpClient } from "../../platform/http-client.js";

const NVD_BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";

interface NvdCvssMetric {
  cvssData: {
    baseScore: number;
    baseSeverity: string;
    vectorString: string;
  };
}

interface NvdVulnerability {
  cve: {
    id: string;
    metrics?: {
      cvssMetricV31?: NvdCvssMetric[];
      cvssMetricV30?: NvdCvssMetric[];
      cvssMetricV2?: NvdCvssMetric[];
    };
    references?: Array<{ url: string; tags?: string[] }>;
  };
}

interface NvdResponse {
  vulnerabilities?: NvdVulnerability[];
  totalResults?: number;
}

function buildNvdHeaders(): Record<string, string> {
  const { apiKey } = getNvdConfig();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.apiKey = apiKey;
  }
  return headers;
}

/**
 * Fetch CVSS score for a CVE from NVD.
 * Returns undefined if NVD doesn't have data or the request fails.
 * Non-fatal — callers should handle undefined gracefully.
 */
export async function fetchNvdCvss(
  cveId: string
): Promise<{ score: number; severity: CveDetails["severity"] } | undefined> {
  const url = `${NVD_BASE}?cveId=${encodeURIComponent(cveId)}`;
  const headers = buildNvdHeaders();

  try {
    const res = await httpClient({ url, headers });
    if (!res.ok) return undefined;

    const data = res.data as NvdResponse;
    const vuln = data.vulnerabilities?.[0];
    if (!vuln) return undefined;

    const metrics = vuln.cve.metrics;
    const metric =
      metrics?.cvssMetricV31?.[0] ??
      metrics?.cvssMetricV30?.[0] ??
      metrics?.cvssMetricV2?.[0];

    if (!metric) return undefined;

    const score = metric.cvssData.baseScore;
    const rawSeverity = metric.cvssData.baseSeverity.toUpperCase();

    const severityMap: Record<string, CveDetails["severity"]> = {
      CRITICAL: "CRITICAL",
      HIGH: "HIGH",
      MEDIUM: "MEDIUM",
      LOW: "LOW",
    };

    return {
      score,
      severity: severityMap[rawSeverity] ?? "UNKNOWN",
    };
  } catch {
    // NVD is non-critical; don't crash the pipeline on network failures
    return undefined;
  }
}

/**
 * Enrich an existing CveDetails with NVD CVSS data.
 * Mutates in place and returns the same object.
 */
export async function enrichWithNvd(details: CveDetails): Promise<CveDetails> {
  const cvss = await fetchNvdCvss(details.id);
  if (cvss) {
    details.cvssScore = cvss.score;
    if (details.severity === "UNKNOWN") {
      details.severity = cvss.severity;
    }
  }
  return details;
}
