/**
 * GitLab advisory enrichment client.
 *
 * Endpoint is configurable because deployment paths vary by mirror.
 */
import type { CveDetails } from "../../platform/types.js";
import { getIntelligenceSourceConfig } from "../../platform/config.js";

interface GitLabAdvisoryRecord {
  identifiers?: Array<{ type?: string; value?: string }>;
  references?: string[];
}

function advisoryMatchesCve(advisory: GitLabAdvisoryRecord, cveId: string): boolean {
  const normalized = cveId.toUpperCase();
  return (advisory.identifiers ?? []).some(
    (id) => id.type?.toUpperCase() === "CVE" && id.value?.toUpperCase() === normalized
  );
}

export async function fetchGitLabAdvisories(cveId: string): Promise<GitLabAdvisoryRecord[]> {
  const { gitLabAdvisoryApi } = getIntelligenceSourceConfig();
  if (!gitLabAdvisoryApi) return [];

  try {
    const url = new URL(gitLabAdvisoryApi);
    url.searchParams.set("identifier", cveId);
    url.searchParams.set("ecosystem", "npm");

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];

    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as GitLabAdvisoryRecord[]) : [];
  } catch {
    return [];
  }
}

export async function enrichWithGitLabAdvisory(details: CveDetails): Promise<CveDetails> {
  const advisories = await fetchGitLabAdvisories(details.id);
  const matched = advisories.filter((a) => advisoryMatchesCve(a, details.id));
  if (matched.length === 0) return details;

  const refs = matched.flatMap((m) => m.references ?? []);
  if (refs.length > 0) {
    const merged = new Set([...details.references, ...refs]);
    details.references = Array.from(merged);
  }

  details.intelligence = {
    ...(details.intelligence ?? {}),
    gitlabAdvisoryMatched: true,
  };

  return details;
}
