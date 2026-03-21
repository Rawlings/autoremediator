/**
 * GitHub Advisory Database API client
 *
 * Used as a secondary source to enrich CVE data with `first_patched_version`.
 * Unauthenticated access works; set GITHUB_TOKEN env var for higher rate limits.
 */
import type { AffectedPackage, CveDetails } from "../../platform/types.js";
import { getGitHubToken } from "../../platform/config.js";

const GH_ADVISORY_BASE = "https://api.github.com/advisories";

// ---------------------------------------------------------------------------
// Raw GitHub Advisory response types
// ---------------------------------------------------------------------------

interface GhVulnerability {
  package: {
    ecosystem: string;
    name: string;
  };
  vulnerable_version_range: string | null;
  first_patched_version: string | null;
}

interface GhAdvisory {
  ghsa_id: string;
  cve_id: string | null;
  summary: string;
  severity: "low" | "medium" | "high" | "critical" | "unknown";
  vulnerabilities: GhVulnerability[];
  cvss?: { score: number; vector_string: string };
  references: Array<{ url: string }>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = getGitHubToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fetch GitHub advisories for a given CVE ID filtered to npm ecosystem.
 * Returns an empty array if none found.
 */
export async function fetchGhAdvisories(cveId: string): Promise<GhAdvisory[]> {
  const url = new URL(GH_ADVISORY_BASE);
  url.searchParams.set("cve_id", cveId);
  url.searchParams.set("ecosystem", "npm");
  url.searchParams.set("type", "reviewed");
  url.searchParams.set("per_page", "10");

  const res = await fetch(url.toString(), { headers: buildHeaders() });

  if (res.status === 404) return [];
  if (!res.ok) {
    // Non-fatal: log and return empty so OSV can still succeed
    console.warn(
      `[autoremediator] GitHub Advisory API returned ${res.status} for ${cveId} — skipping.`
    );
    return [];
  }

  return res.json() as Promise<GhAdvisory[]>;
}

/**
 * Parse GitHub advisories into AffectedPackage entries.
 * Deduplication against OSV results is handled in lookup-cve.ts.
 */
export function parseGhAdvisories(advisories: GhAdvisory[]): AffectedPackage[] {
  const packages: AffectedPackage[] = [];

  for (const advisory of advisories) {
    for (const vuln of advisory.vulnerabilities) {
      if (vuln.package.ecosystem.toLowerCase() !== "npm") continue;

      packages.push({
        name: vuln.package.name,
        ecosystem: "npm",
        vulnerableRange: vuln.vulnerable_version_range ?? ">=0.0.0",
        firstPatchedVersion: vuln.first_patched_version ?? undefined,
        source: "github-advisory",
      });
    }
  }

  return packages;
}

/**
 * Merge data from GitHub advisory into a CveDetails object built from OSV.
 * Fills in `firstPatchedVersion` where OSV didn't have it, and enriches CVSS.
 */
export function mergeGhDataIntoCveDetails(
  details: CveDetails,
  ghPackages: AffectedPackage[]
): CveDetails {
  const enriched = { ...details };

  for (const ghPkg of ghPackages) {
    const existing = enriched.affectedPackages.find(
      (p) => p.name === ghPkg.name
    );

    if (existing) {
      // Backfill firstPatchedVersion if OSV didn't have it
      if (!existing.firstPatchedVersion && ghPkg.firstPatchedVersion) {
        existing.firstPatchedVersion = ghPkg.firstPatchedVersion;
      }
    } else {
      // Package only known via GitHub Advisory (not yet in OSV)
      enriched.affectedPackages.push(ghPkg);
    }
  }

  return enriched;
}

/** High-level convenience: fetch + parse, returns enrichment packages */
export async function lookupCveGitHub(cveId: string): Promise<AffectedPackage[]> {
  const advisories = await fetchGhAdvisories(cveId);
  return parseGhAdvisories(advisories);
}
