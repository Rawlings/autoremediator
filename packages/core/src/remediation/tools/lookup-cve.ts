/**
 * Tool: lookup-cve
 *
 * Fetches CVE details from OSV (primary) and GitHub Advisory (secondary),
 * merges them, and optionally enriches with supplemental intelligence data.
 */
import { tool } from "ai";
import { z } from "zod";
import { lookupCveOsv } from "../../intelligence/sources/osv.js";
import { lookupCveGitHub, mergeGhDataIntoCveDetails } from "../../intelligence/sources/github-advisory.js";
import { enrichWithNvd } from "../../intelligence/sources/nvd.js";
import { enrichWithCisaKev } from "../../intelligence/sources/cisa-kev.js";
import { enrichWithEpss } from "../../intelligence/sources/epss.js";
import { enrichWithCveServices } from "../../intelligence/sources/cve-services.js";
import { enrichWithGitLabAdvisory } from "../../intelligence/sources/gitlab-advisory.js";
import { enrichWithCertCc } from "../../intelligence/sources/certcc.js";
import { enrichWithDepsDev } from "../../intelligence/sources/deps-dev.js";
import { enrichWithOssfScorecard } from "../../intelligence/sources/ossf-scorecard.js";
import { enrichWithExternalFeeds } from "../../intelligence/sources/external-feeds.js";
import type { CveDetails } from "../../platform/types.js";

export const lookupCveTool = tool({
  description:
    "Look up a CVE ID and return the list of affected npm packages, their vulnerable version ranges, and the first patched version. Always call this first.",
  parameters: z.object({
    cveId: z
      .string()
      .regex(/^CVE-\d{4}-\d+$/i, "Must be a valid CVE ID like CVE-2021-23337"),
  }),
  execute: async ({ cveId }): Promise<{ success: boolean; data?: CveDetails; error?: string }> => {
    const normalizedId = cveId.toUpperCase();

    // Fan out to OSV + GitHub Advisory in parallel
    const [osvDetails, ghPackages] = await Promise.all([
      lookupCveOsv(normalizedId),
      lookupCveGitHub(normalizedId),
    ]);

    if (!osvDetails && ghPackages.length === 0) {
      return {
        success: false,
        error: `CVE "${normalizedId}" was not found in OSV or GitHub Advisory databases. It may be too new, or not affect npm packages.`,
      };
    }

    // Start from OSV result or construct a minimal shell from GH data
    let details: CveDetails = osvDetails ?? {
      id: normalizedId,
      summary: "Details sourced from GitHub Advisory Database.",
      severity: "UNKNOWN",
      references: [],
      affectedPackages: [],
    };

    // Merge GitHub Advisory data (adds firstPatchedVersion, fills gaps)
    if (ghPackages.length > 0) {
      details = mergeGhDataIntoCveDetails(details, ghPackages);
    }

    const sourceHealth: Record<string, { attempted: boolean; changed: boolean; error?: string }> = {};

    const applyEnricher = async (
      sourceName: string,
      enricher: (input: CveDetails) => Promise<CveDetails>
    ): Promise<void> => {
      const before = JSON.stringify(details);
      try {
        details = await enricher(details);
        const after = JSON.stringify(details);
        sourceHealth[sourceName] = {
          attempted: true,
          changed: before !== after,
        };
      } catch (error) {
        sourceHealth[sourceName] = {
          attempted: true,
          changed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    await applyEnricher("nvd", enrichWithNvd);
    await applyEnricher("cisa-kev", enrichWithCisaKev);
    await applyEnricher("epss", enrichWithEpss);
    await applyEnricher("cve-services", enrichWithCveServices);
    await applyEnricher("gitlab-advisory", enrichWithGitLabAdvisory);
    await applyEnricher("certcc", enrichWithCertCc);
    await applyEnricher("deps-dev", enrichWithDepsDev);
    await applyEnricher("ossf-scorecard", enrichWithOssfScorecard);
    await applyEnricher("external-feeds", enrichWithExternalFeeds);

    details.intelligence = {
      ...(details.intelligence ?? {}),
      sourceHealth,
    };

    if (details.affectedPackages.length === 0) {
      return {
        success: false,
        error: `CVE "${normalizedId}" was found but has no npm-specific affected packages listed. It may affect a different ecosystem.`,
      };
    }

    return { success: true, data: details };
  },
});
