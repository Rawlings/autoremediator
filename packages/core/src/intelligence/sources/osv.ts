/**
 * OSV API client (https://osv.dev)
 *
 * Used as the primary source for CVE → affected npm package mapping.
 * No auth required. SEMVER event ranges are machine-readable.
 * Uses shared HTTP client for consistent error handling and timeouts.
 */
import type { AffectedPackage, CveDetails } from "../../platform/types.js";
import { httpClient } from "../../platform/http-client.js";

const OSV_BASE = "https://api.osv.dev/v1";


// ---------------------------------------------------------------------------
// Raw OSV response types
// ---------------------------------------------------------------------------

interface OsvSemverEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

interface OsvRange {
  type: "SEMVER" | "GIT" | "ECOSYSTEM";
  events: OsvSemverEvent[];
  repo?: string;
}

interface OsvAffected {
  package: {
    name: string;
    ecosystem: string;
    purl?: string;
  };
  ranges?: OsvRange[];
  versions?: string[];
  database_specific?: Record<string, unknown>;
  ecosystem_specific?: Record<string, unknown>;
}

interface OsvVulnerability {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: Array<{
    type: string;
    score: string;
  }>;
  affected?: OsvAffected[];
  references?: Array<{ type: string; url: string }>;
  schema_version?: string;
  modified?: string;
  published?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a vulnerability by CVE ID (or any OSV/GHSA ID).
 * Returns null if the CVE is not found in OSV.
 */
export async function fetchOsvVuln(cveId: string): Promise<OsvVulnerability | null> {
  const url = `${OSV_BASE}/vulns/${encodeURIComponent(cveId)}`;

  try {
    const res = await httpClient({ url });

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`OSV API error ${res.status} for ${cveId}: ${res.text}`);
    }

    return res.data as OsvVulnerability;
  } catch (err) {
    // If httpClient throws (timeout, network error), convert to HTTP error
    if (err instanceof Error) {
      throw new Error(`OSV API error for ${cveId}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Convert an OSV SEMVER range event array to a semver range string.
 * OSV uses ordered [introduced, fixed) events.
 * e.g. [{ introduced: "0" }, { fixed: "4.17.21" }] → ">=0.0.0 <4.17.21"
 */
function osvEventsToSemverRange(events: OsvSemverEvent[]): string {
  const parts: string[] = [];

  for (const event of events) {
    if (event.introduced !== undefined) {
      const v = event.introduced === "0" ? "0.0.0" : event.introduced;
      parts.push(`>=${v}`);
    }
    if (event.fixed !== undefined) {
      parts.push(`<${event.fixed}`);
    }
    if (event.last_affected !== undefined) {
      parts.push(`<=${event.last_affected}`);
    }
  }

  return parts.join(" ") || ">=0.0.0";
}

/**
 * Parse an OSV vulnerability into autoremediator's CveDetails shape,
 * filtering affected entries to npm ecosystem only.
 */
export function parseOsvVuln(vuln: OsvVulnerability): CveDetails {
  const npmAffected: AffectedPackage[] = [];

  for (const affected of vuln.affected ?? []) {
    const ecosystem = affected.package?.ecosystem;
    const packageName = affected.package?.name;
    if (!ecosystem || typeof ecosystem !== "string") continue;
    if (!packageName || typeof packageName !== "string") continue;
    if (ecosystem.toLowerCase() !== "npm") continue;

    // Find the best SEMVER range
    const semverRange = affected.ranges?.find((r) => r.type === "SEMVER");
    const vulnerableRange = semverRange
      ? osvEventsToSemverRange(semverRange.events)
      : ">=0.0.0";

    // Derive firstPatchedVersion from the "fixed" event
    const fixedEvent = semverRange?.events.find((e) => e.fixed !== undefined);

    npmAffected.push({
      name: packageName,
      ecosystem: "npm",
      vulnerableRange,
      firstPatchedVersion: fixedEvent?.fixed,
      source: "osv",
    });
  }

  // Best-effort severity from CVSS score string (e.g. "CVSS:3.1/.../7.5")
  const severity = deriveSeverity(vuln.severity);

  return {
    id: vuln.id,
    summary: vuln.summary ?? vuln.details ?? "No summary available.",
    severity,
    references: vuln.references?.map((r) => r.url) ?? [],
    affectedPackages: npmAffected,
  };
}

function deriveSeverity(
  severityEntries?: OsvVulnerability["severity"]
): CveDetails["severity"] {
  if (!severityEntries?.length) return "UNKNOWN";

  // Prefer CVSS_V3 type
  const cvssEntry =
    severityEntries.find((s) => s.type === "CVSS_V3") ?? severityEntries[0];

  // Extract base score from vector string, e.g. "CVSS:3.1/AV:N/AC:L/.../7.5/..."
  const scoreMatch = cvssEntry.score.match(/(\d+\.\d+)$/);
  if (scoreMatch) {
    const score = parseFloat(scoreMatch[1]);
    if (score >= 9.0) return "CRITICAL";
    if (score >= 7.0) return "HIGH";
    if (score >= 4.0) return "MEDIUM";
    return "LOW";
  }

  return "UNKNOWN";
}

/** High-level convenience: fetch + parse */
export async function lookupCveOsv(cveId: string): Promise<CveDetails | null> {
  const vuln = await fetchOsvVuln(cveId);
  if (!vuln) return null;
  return parseOsvVuln(vuln);
}
