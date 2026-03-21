/**
 * CISA Known Exploited Vulnerabilities (KEV) feed client.
 *
 * Used for risk-priority enrichment only. This source does not provide
 * npm package range intelligence.
 */
import type { CveDetails } from "../../platform/types.js";

const CISA_KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

interface CisaKevVulnerability {
  cveID: string;
  dateAdded?: string;
  dueDate?: string;
  requiredAction?: string;
  knownRansomwareCampaignUse?: string;
}

interface CisaKevFeed {
  vulnerabilities?: CisaKevVulnerability[];
}

export async function fetchCisaKevFeed(): Promise<CisaKevFeed | undefined> {
  try {
    const res = await fetch(CISA_KEV_URL, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as CisaKevFeed;
  } catch {
    // KEV is enrichment only; failures are non-fatal.
    return undefined;
  }
}

export function findKevEntry(
  feed: CisaKevFeed | undefined,
  cveId: string
): CisaKevVulnerability | undefined {
  if (!feed?.vulnerabilities?.length) return undefined;
  const normalized = cveId.toUpperCase();
  return feed.vulnerabilities.find((v) => v.cveID.toUpperCase() === normalized);
}

export async function enrichWithCisaKev(details: CveDetails): Promise<CveDetails> {
  const feed = await fetchCisaKevFeed();
  const entry = findKevEntry(feed, details.id);
  if (!entry) return details;

  details.kev = {
    knownExploited: true,
    dateAdded: entry.dateAdded,
    dueDate: entry.dueDate,
    requiredAction: entry.requiredAction,
    knownRansomwareCampaignUse: entry.knownRansomwareCampaignUse,
  };

  if (!details.references.includes(CISA_KEV_URL)) {
    details.references.push(CISA_KEV_URL);
  }

  return details;
}
