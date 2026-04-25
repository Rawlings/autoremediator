/**
 * Tool: check-version-match
 *
 * Cross-references inventory packages against CVE-affected package ranges
 * to find which installed packages are actually vulnerable.
 */
import { defineTool } from "./tool-compat.js";
import { z } from "zod";
import semver from "semver";
import type { AffectedPackage, InventoryPackage, VulnerablePackage } from "../../platform/types.js";

const affectedPackageSchema = z.object({
  name: z.string(),
  ecosystem: z.literal("npm"),
  vulnerableRange: z.string(),
  firstPatchedVersion: z.string().optional(),
  source: z.enum(["osv", "github-advisory"]),
});

const inventoryPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  type: z.enum(["direct", "transitive"]),
});

export const checkVersionMatchTool = defineTool({
  description:
    "Check which of the project's installed packages fall within the CVE's vulnerable version ranges. Returns only the packages that are actually vulnerable.",
  parameters: z.object({
    installedPackages: z
      .array(inventoryPackageSchema)
      .describe("Output from the check-inventory tool"),
    affectedPackages: z
      .array(affectedPackageSchema)
      .describe("affectedPackages array from the lookup-cve tool result"),
  }),
  execute: async ({ installedPackages, affectedPackages }): Promise<{
    vulnerablePackages: VulnerablePackage[];
    checkedCount: number;
  }> => {
    const vulnerable: VulnerablePackage[] = [];

    for (const affected of affectedPackages as AffectedPackage[]) {
      // Find all installed packages with matching name
      const matches = (installedPackages as InventoryPackage[]).filter(
        (p) => p.name === affected.name
      );

      for (const installed of matches) {
        // Validate the installed version is parseable
        if (!semver.valid(installed.version)) continue;

        let isVulnerable = false;
        try {
          isVulnerable = semver.satisfies(installed.version, affected.vulnerableRange, {
            includePrerelease: false,
          });
        } catch {
          // Malformed range — skip rather than crash
          continue;
        }

        if (isVulnerable) {
          vulnerable.push({ installed, affected });
        }
      }
    }

    return {
      vulnerablePackages: vulnerable,
      checkedCount: installedPackages.length,
    };
  },
});
