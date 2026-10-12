/**
 * Tool: find-fixed-version
 *
 * Queries the npm registry to find the best safe upgrade version
 * for a vulnerable package.
 */
import { defineTool } from "./tool-compat.js";
import { z } from "zod";
import semver from "semver";
import { resolveSafeUpgradeVersion } from "../../intelligence/sources/registry.js";

export const findFixedVersionTool = defineTool({
  description:
    "Query the npm registry to find the safest published upgrade version for a package that is >= the first patched version. Prefer patch upgrades first, then minor, and only fall back to major when no same-major fix exists.",
  parameters: z.object({
    packageName: z.string().describe("The npm package name"),
    installedVersion: z.string().describe("The currently installed version (exact semver)"),
    firstPatchedVersion: z
      .string()
      .describe(
        "The first version that is NOT vulnerable (from lookup-cve). Use this as the floor.",
      ),
    vulnerableRange: z
      .string()
      .optional()
      .describe("Optional vulnerable semver range used to exclude still-vulnerable versions"),
  }),
  execute: async ({
    packageName,
    installedVersion,
    firstPatchedVersion,
    vulnerableRange,
  }): Promise<{
    safeVersion?: string;
    upgradeLevel?: "patch" | "minor" | "major";
    candidates: Partial<Record<"patch" | "minor" | "major", string>>;
    isMajorBump: boolean;
    majorOnlyFixAvailable: boolean;
    message: string;
  }> => {
    const resolution = await resolveSafeUpgradeVersion(
      packageName,
      installedVersion,
      firstPatchedVersion,
      vulnerableRange,
    );
    const { safeVersion, upgradeLevel, candidates, majorOnlyFixAvailable } = resolution;

    if (!safeVersion) {
      return {
        candidates,
        isMajorBump: false,
        majorOnlyFixAvailable: false,
        message: `No safe upgrade version found for "${packageName}". The patch-file path will be needed.`,
      };
    }

    const parsedInstalled = semver.parse(installedVersion) ?? semver.coerce(installedVersion);
    const parsedSafe = semver.parse(safeVersion) ?? semver.coerce(safeVersion);
    const isMajorBump = Boolean(
      parsedInstalled && parsedSafe && parsedSafe.major > parsedInstalled.major,
    );

    return {
      safeVersion,
      upgradeLevel,
      candidates,
      isMajorBump,
      majorOnlyFixAvailable,
      message: isMajorBump
        ? `Found safe version ${safeVersion} for "${packageName}", but only a major upgrade is available from ${installedVersion}. This should remain blocked unless policy explicitly allows major bumps.`
        : `Found ${upgradeLevel ?? "safe"} upgrade ${safeVersion} for "${packageName}" (from ${installedVersion}).`,
    };
  },
});
