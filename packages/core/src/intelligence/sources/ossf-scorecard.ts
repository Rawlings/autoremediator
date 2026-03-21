/**
 * OpenSSF Scorecard enrichment.
 *
 * Uses best-effort project checks from affected package names.
 */
import type { CveDetails } from "../../platform/types.js";
import { getIntelligenceSourceConfig } from "../../platform/config.js";

async function checkProject(project: string): Promise<boolean> {
  const { scorecardApi } = getIntelligenceSourceConfig();
  if (!scorecardApi) return false;

  try {
    const url = new URL(`${scorecardApi}/projects`);
    url.searchParams.set("project", project);
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function enrichWithOssfScorecard(details: CveDetails): Promise<CveDetails> {
  const projects = Array.from(
    new Set(details.affectedPackages.map((p) => `github.com/${p.name}/${p.name}`))
  ).slice(0, 10);

  if (projects.length === 0) return details;

  const checks = await Promise.all(projects.map((project) => checkProject(project)));
  const matched = checks.filter(Boolean).length;
  if (matched === 0) return details;

  details.intelligence = {
    ...(details.intelligence ?? {}),
    scorecardProjects: matched,
  };

  return details;
}
