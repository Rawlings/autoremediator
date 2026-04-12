/**
 * CERT/CC search enrichment.
 *
 * This source tries to locate a CERT/CC page mentioning a CVE.
 * Uses shared HTTP client for consistent error handling and timeouts.
 */
import type { CveDetails } from "../../platform/types.js";
import { getIntelligenceSourceConfig } from "../../platform/config.js";
import { httpClient } from "../../platform/http-client.js";

const CERTCC_HOME = "https://www.kb.cert.org/vuls/";

export async function findCertCcReference(cveId: string): Promise<string | undefined> {
  const { certCcSearchUrl } = getIntelligenceSourceConfig();
  if (!certCcSearchUrl) return undefined;

  try {
    const url = new URL(certCcSearchUrl);
    url.searchParams.set("query", cveId);

    const res = await httpClient({
      url: url.toString(),
      headers: { Accept: "text/html" },
    });
    if (!res.ok) return undefined;

    const html = res.text;
    const match = html.match(/https:\/\/www\.kb\.cert\.org\/vuls\/id\/\d+/i);
    return match?.[0] ?? undefined;
  } catch {
    return undefined;
  }
}

export async function enrichWithCertCc(details: CveDetails): Promise<CveDetails> {
  const ref = await findCertCcReference(details.id);
  if (!ref) return details;

  if (!details.references.includes(ref)) {
    details.references.push(ref);
  }

  details.intelligence = {
    ...(details.intelligence ?? {}),
    certCcMatched: true,
  };

  if (!details.references.includes(CERTCC_HOME)) {
    details.references.push(CERTCC_HOME);
  }

  return details;
}
