/**
 * deps.dev enrichment.
 *
 * Adds package metadata lookup coverage count for affected npm packages.
 */
import type { CveDetails } from "../../platform/types.js";
import { getIntelligenceSourceConfig } from "../../platform/config.js";

async function fetchDepsDevPackage(name: string): Promise<boolean> {
  const { depsDevApi } = getIntelligenceSourceConfig();
  if (!depsDevApi) return false;

  try {
    const url = `${depsDevApi}/systems/npm/packages/${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    return res.ok;
  } catch {
    return false;
  }
}

export async function enrichWithDepsDev(details: CveDetails): Promise<CveDetails> {
  const names = Array.from(new Set(details.affectedPackages.map((p) => p.name))).slice(0, 20);
  if (names.length === 0) return details;

  const checks = await Promise.all(names.map((name) => fetchDepsDevPackage(name)));
  const matched = checks.filter(Boolean).length;
  if (matched === 0) return details;

  details.intelligence = {
    ...(details.intelligence ?? {}),
    depsDevEnrichedPackages: matched,
  };
  return details;
}
