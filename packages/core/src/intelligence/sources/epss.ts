/**
 * FIRST EPSS API client.
 *
 * Adds exploitation probability metadata for prioritization.
 */
import type { CveDetails } from "../../platform/types.js";
import { getIntelligenceSourceConfig } from "../../platform/config.js";

interface EpssRow {
  cve: string;
  epss: string;
  percentile: string;
  date?: string;
}

interface EpssResponse {
  data?: EpssRow[];
}

export async function fetchEpss(cveId: string): Promise<EpssRow | undefined> {
  const { epssApi } = getIntelligenceSourceConfig();
  if (!epssApi) return undefined;

  try {
    const url = new URL(epssApi);
    url.searchParams.set("cve", cveId);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return undefined;

    const body = (await res.json()) as EpssResponse;
    return body.data?.[0];
  } catch {
    return undefined;
  }
}

export async function enrichWithEpss(details: CveDetails): Promise<CveDetails> {
  const row = await fetchEpss(details.id);
  if (!row) return details;

  const score = Number.parseFloat(row.epss);
  const percentile = Number.parseFloat(row.percentile);
  if (!Number.isFinite(score) || !Number.isFinite(percentile)) {
    return details;
  }

  details.epss = {
    score,
    percentile,
    date: row.date,
  };
  return details;
}
