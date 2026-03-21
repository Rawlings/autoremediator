/**
 * Tool: find-fixed-version
 *
 * Queries the npm registry to find the best safe upgrade version
 * for a vulnerable package.
 */
import { tool } from "ai";
import { z } from "zod";
import { findSafeUpgradeVersion } from "../../intelligence/sources/registry.js";

export const findFixedVersionTool = tool({
  description:
    "Query the npm registry to find the lowest published version of a package that is >= the first patched version. Prefer same-major upgrades. Returns undefined if no safe version exists.",
  parameters: z.object({
    packageName: z.string().describe("The npm package name"),
    installedVersion: z.string().describe("The currently installed version (exact semver)"),
    firstPatchedVersion: z
      .string()
      .describe(
        "The first version that is NOT vulnerable (from lookup-cve). Use this as the floor."
      ),
  }),
  execute: async ({
    packageName,
    installedVersion,
    firstPatchedVersion,
  }): Promise<{
    safeVersion?: string;
    isMajorBump: boolean;
    message: string;
  }> => {
    const safeVersion = await findSafeUpgradeVersion(
      packageName,
      installedVersion,
      firstPatchedVersion
    );

    if (!safeVersion) {
      return {
        isMajorBump: false,
        message: `No safe upgrade version found for "${packageName}". The patch-file path will be needed.`,
      };
    }

    const installedMajor = parseInt(installedVersion.split(".")[0] ?? "0", 10);
    const safeMajor = parseInt(safeVersion.split(".")[0] ?? "0", 10);
    const isMajorBump = safeMajor > installedMajor;

    return {
      safeVersion,
      isMajorBump,
      message: isMajorBump
        ? `Found safe version ${safeVersion} for "${packageName}", but it is a major bump from ${installedVersion}. Applying anyway — consumer should review for breaking changes.`
        : `Found safe version ${safeVersion} for "${packageName}" (from ${installedVersion}).`,
    };
  },
});
