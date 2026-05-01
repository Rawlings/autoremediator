/**
 * Optional vendor and commercial intelligence connectors.
 *
 * Connectors are URL-based and environment configured so enterprise users can
 * plug in proprietary feeds without hard-coding dependencies.
 * Uses shared HTTP client for consistent error handling and timeouts.
 */
import type { CveDetails } from "../../platform/types.js";
import { getIntelligenceSourceConfig } from "../../platform/config.js";
import { httpClient } from "../../platform/http-client.js";

async function probeFeed(url: string, cveId: string, token?: string): Promise<string | undefined> {
  try {
    const feedUrl = new URL(url);

    // Block SSRF to private/loopback/link-local addresses
    const hostname = feedUrl.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      hostname === "0.0.0.0" ||
      /^169\.254\./.test(hostname) ||
      hostname === "[::1]" ||
      hostname === "::1"
    ) {
      return undefined;
    }
    if (feedUrl.protocol !== "https:" && feedUrl.protocol !== "http:") {
      return undefined;
    }

    feedUrl.searchParams.set("cve", cveId);

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await httpClient({ url: feedUrl.toString(), headers });
    if (!res.ok) return undefined;
    return feedUrl.toString();
  } catch {
    return undefined;
  }
}

export async function enrichWithExternalFeeds(details: CveDetails): Promise<CveDetails> {
  const {
    vendorAdvisoryFeeds,
    commercialFeeds,
    commercialFeedToken,
  } = getIntelligenceSourceConfig();

  const vendorHits = (
    await Promise.all(vendorAdvisoryFeeds.map((url) => probeFeed(url, details.id)))
  ).filter((v): v is string => Boolean(v));

  const commercialHits = (
    await Promise.all(
      commercialFeeds.map((url) => probeFeed(url, details.id, commercialFeedToken))
    )
  ).filter((v): v is string => Boolean(v));

  if (vendorHits.length === 0 && commercialHits.length === 0) {
    return details;
  }

  details.intelligence = {
    ...(details.intelligence ?? {}),
    vendorAdvisories: vendorHits.length > 0 ? vendorHits : details.intelligence?.vendorAdvisories,
    commercialFeeds:
      commercialHits.length > 0 ? commercialHits : details.intelligence?.commercialFeeds,
  };

  const mergedRefs = new Set([...details.references, ...vendorHits, ...commercialHits]);
  details.references = Array.from(mergedRefs);

  return details;
}
