/**
 * OSV API client (https://osv.dev)
 *
 * Used as the primary source for CVE → affected npm package mapping.
 * No auth required. SEMVER event ranges are machine-readable.
 * Uses shared HTTP client for consistent error handling and timeouts.
 */
import semver from "semver";

import { httpClient } from "../../platform/http-client.js";
import type { AffectedPackage, CveDetails } from "../../platform/types.js";

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
      throw new Error(`OSV API error for ${cveId}: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Query OSV for all vulnerabilities affecting a specific npm package and optional version.
 */
export async function queryOsvPackage(
  packageName: string,
  version?: string,
): Promise<OsvVulnerability[]> {
  const url = `${OSV_BASE}/query`;
  const body: Record<string, unknown> = {
    package: {
      name: packageName,
      ecosystem: "npm",
    },
  };
  if (version) {
    body.version = version;
  }

  try {
    const res = await httpClient({
      url,
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });

    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(`OSV API error ${res.status} for query "${packageName}": ${res.text}`);
    }

    const data = res.data as { vulns?: OsvVulnerability[] };
    return data.vulns ?? [];
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`OSV API error for query "${packageName}": ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Convert OSV range events into a semver range.
 *
 * Events describe a sequence of [introduced, fixed) intervals, and a record can contain several,
 * so intervals are unioned with `||` (a space-joined range would mean intersection).
 * e.g. [introduced 0, fixed 1.5, introduced 2.0, fixed 2.3] → "<1.5.0 || >=2.0.0 <2.3.0".
 */
function eventsToSemverRange(events: OsvSemverEvent[]): string | undefined {
  const intervals: string[] = [];
  let lower: string | undefined;

  for (const event of events) {
    if (event.introduced !== undefined) {
      if (lower !== undefined) intervals.push(`>=${lower}`);
      lower = event.introduced === "0" ? "0.0.0" : event.introduced;
    } else if (event.fixed !== undefined || event.last_affected !== undefined) {
      const upper = event.fixed !== undefined ? `<${event.fixed}` : `<=${event.last_affected}`;
      intervals.push(lower !== undefined ? `>=${lower} ${upper}` : upper);
      lower = undefined;
    }
  }
  if (lower !== undefined) intervals.push(`>=${lower}`);

  return intervals.length > 0 ? intervals.join(" || ") : undefined;
}

/**
 * The affected-version range of an OSV `affected` entry, or `undefined` when the record does not
 * say. Never guesses "everything": claiming all versions are vulnerable would trigger fixes for
 * installs that are not affected.
 *
 * npm advisories carry SEMVER ranges, or ECOSYSTEM ranges (which for npm are also semver, and
 * are what GitHub-sourced records use), or just an explicit version list.
 */
function affectedRange(affected: OsvAffected): string | undefined {
  const ranges = affected.ranges ?? [];
  const range =
    ranges.find((r) => r.type === "SEMVER") ?? ranges.find((r) => r.type === "ECOSYSTEM");
  const fromEvents = range ? eventsToSemverRange(range.events) : undefined;
  if (fromEvents) return fromEvents;

  const versions = (affected.versions ?? []).filter((v) => semver.valid(v) !== null);
  return versions.length > 0 ? versions.map((v) => `=${v}`).join(" || ") : undefined;
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

    const vulnerableRange = affectedRange(affected);
    if (!vulnerableRange) continue;

    const events = (
      affected.ranges?.find((r) => r.type === "SEMVER") ??
      affected.ranges?.find((r) => r.type === "ECOSYSTEM")
    )?.events;
    const fixedEvent = events?.find((e) => e.fixed !== undefined);

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
    publishedAt: vuln.published,
    references: vuln.references?.map((r) => r.url) ?? [],
    affectedPackages: npmAffected,
  };
}

function deriveSeverity(severityEntries?: OsvVulnerability["severity"]): CveDetails["severity"] {
  if (!severityEntries?.length) return "UNKNOWN";

  // Prefer CVSS_V3 type
  const cvssEntry = severityEntries.find((s) => s.type === "CVSS_V3") ?? severityEntries[0];
  if (!cvssEntry) return "UNKNOWN";

  // Extract base score from vector string, e.g. "CVSS:3.1/AV:N/AC:L/.../7.5/..."
  const scoreMatch = /(\d+\.\d+)$/.exec(cvssEntry.score);
  if (scoreMatch?.[1] !== undefined) {
    const score = Number.parseFloat(scoreMatch[1]);
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
