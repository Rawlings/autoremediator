/**
 * Tool: lookup-cve
 *
 * Fetches CVE details from OSV (primary) and GitHub Advisory (secondary),
 * merges them, and optionally enriches with NVD CVSS scores.
 */
import { tool } from "ai";
import { z } from "zod";
import { lookupCveOsv } from "../../intelligence/sources/osv.js";
import { lookupCveGitHub, mergeGhDataIntoCveDetails } from "../../intelligence/sources/github-advisory.js";
import { enrichWithNvd } from "../../intelligence/sources/nvd.js";
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

    // Enrich with NVD CVSS score (non-fatal)
    details = await enrichWithNvd(details);

    if (details.affectedPackages.length === 0) {
      return {
        success: false,
        error: `CVE "${normalizedId}" was found but has no npm-specific affected packages listed. It may affect a different ecosystem.`,
      };
    }

    return { success: true, data: details };
  },
});
