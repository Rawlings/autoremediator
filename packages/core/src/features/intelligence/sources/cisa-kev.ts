import { httpClient } from "../../../infra/http/http-client.js";
/**
 * CISA Known Exploited Vulnerabilities (KEV) feed client.
 *
 * Used for risk-priority enrichment only. This source does not provide
 * npm package range intelligence.
 * Uses shared HTTP client for consistent error handling and timeouts.
 */
import type { CveDetails } from "../types.js";

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

/** The feed is a ~1 MB document that changes at most daily; one copy per process is plenty. */
const KEV_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedFeed: { feed: CisaKevFeed; fetchedAt: number } | undefined;
let inFlight: Promise<CisaKevFeed | undefined> | undefined;

/** Drop the in-process copy of the feed (tests, long-running servers that want a refresh). */
export function clearCisaKevCache(): void {
  cachedFeed = undefined;
  inFlight = undefined;
}

async function downloadCisaKevFeed(): Promise<CisaKevFeed | undefined> {
  try {
    const res = await httpClient({ url: CISA_KEV_URL });
    if (!res.ok) return undefined;
    const feed = res.data as CisaKevFeed;
    cachedFeed = { feed, fetchedAt: Date.now() };
    return feed;
  } catch {
    // KEV is enrichment only; failures are non-fatal and are not cached, so the next call retries.
    return undefined;
  } finally {
    inFlight = undefined;
  }
}

/**
 * Fetch the KEV feed once and reuse it: a scan of many CVEs, or concurrent runs in one server,
 * share a single download instead of fetching it per advisory.
 */
export async function fetchCisaKevFeed(): Promise<CisaKevFeed | undefined> {
  if (cachedFeed && Date.now() - cachedFeed.fetchedAt < KEV_CACHE_TTL_MS) return cachedFeed.feed;
  inFlight ??= downloadCisaKevFeed();
  return inFlight;
}

export function findKevEntry(
  feed: CisaKevFeed | undefined,
  cveId: string,
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
