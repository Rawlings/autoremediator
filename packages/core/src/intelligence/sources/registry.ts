/**
 * npm registry API client
 *
 * Used to:
 * - Fetch the full list of published versions for a package
 * - Find the lowest semver-compatible safe upgrade from `firstPatchedVersion`
 * - Download tarballs for patch generation (fallback path)
 *
 * Uses shared HTTP client for consistent error handling and timeouts.
 */
import semver from "semver";
import { httpClient } from "../../platform/http-client.js";

const NPM_REGISTRY = "https://registry.npmjs.org";

export type SafeUpgradeLevel = "patch" | "minor" | "major";

export interface SafeUpgradeResolution {
  safeVersion?: string;
  upgradeLevel?: SafeUpgradeLevel;
  candidates: Partial<Record<SafeUpgradeLevel, string>>;
  majorOnlyFixAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Raw registry types (abbreviated)
// ---------------------------------------------------------------------------

interface NpmPackument {
  name: string;
  versions: Record<string, { version: string; dist: { tarball: string } }>;
  "dist-tags": Record<string, string>;
  time: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all published versions for an npm package.
 * Returns an empty array if the package is not found.
 */
export async function fetchPackageVersions(packageName: string): Promise<string[]> {
  const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`;

  try {
    const res = await httpClient({ url });

    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(
        `npm registry error ${res.status} for "${packageName}": ${res.text}`
      );
    }

    const data = res.data as NpmPackument;
    return Object.keys(data.versions);
  } catch (err) {
    // If httpClient throws (timeout, network error), treat as not found
    if (err instanceof Error && err.message.includes("registry error")) {
      throw err;
    }
    return [];
  }
}

/**
 * Find the lowest published version that satisfies `>= firstPatchedVersion`
 * and is semver-compatible with the currently installed version (same major,
 * unless there is no same-major option).
 *
 * Strategy:
 *   1. Try same-major, lowest version >= firstPatchedVersion
 *   2. Fallback: any published version >= firstPatchedVersion (lowest)
 *   3. Returns undefined if nothing found
 */
export async function findSafeUpgradeVersion(
  packageName: string,
  installedVersion: string,
  firstPatchedVersion: string,
  vulnerableRange?: string
): Promise<string | undefined> {
  const resolution = await resolveSafeUpgradeVersion(
    packageName,
    installedVersion,
    firstPatchedVersion,
    vulnerableRange
  );

  return resolution.safeVersion;
}

export async function resolveSafeUpgradeVersion(
  packageName: string,
  installedVersion: string,
  firstPatchedVersion: string,
  vulnerableRange?: string
): Promise<SafeUpgradeResolution> {
  const versions = await fetchPackageVersions(packageName);
  if (!versions.length) {
    return {
      candidates: {},
      majorOnlyFixAvailable: false,
    };
  }

  const installed = semver.parse(installedVersion);

  // All versions >= firstPatchedVersion, sorted ascending
  const candidates = versions
    .filter((v) => semver.valid(v) && semver.gte(v, firstPatchedVersion))
    .filter((v) => {
      if (!vulnerableRange) return true;
      try {
        return !semver.satisfies(v, vulnerableRange, { includePrerelease: false });
      } catch {
        // If vulnerable range cannot be parsed, avoid filtering out candidates.
        return true;
      }
    })
    .sort(semver.compare);

  if (!candidates.length) {
    return {
      candidates: {},
      majorOnlyFixAvailable: false,
    };
  }

  const categorizedCandidates: SafeUpgradeResolution["candidates"] = {};

  for (const candidate of candidates) {
    const level = classifyUpgradeLevel(installedVersion, candidate);
    if (!level) continue;
    if (!categorizedCandidates[level]) {
      categorizedCandidates[level] = candidate;
    }
  }

  const safeVersion =
    categorizedCandidates.patch ?? categorizedCandidates.minor ?? categorizedCandidates.major;

  if (!safeVersion) {
    return {
      candidates: categorizedCandidates,
      majorOnlyFixAvailable: false,
    };
  }

  const upgradeLevel = classifyUpgradeLevel(installedVersion, safeVersion);
  const majorOnlyFixAvailable =
    !categorizedCandidates.patch &&
    !categorizedCandidates.minor &&
    Boolean(categorizedCandidates.major);

  if (!installed || !upgradeLevel) {
    return {
      safeVersion,
      upgradeLevel,
      candidates: categorizedCandidates,
      majorOnlyFixAvailable,
    };
  }

  return {
    safeVersion,
    upgradeLevel,
    candidates: categorizedCandidates,
    majorOnlyFixAvailable,
  };
}

function classifyUpgradeLevel(
  installedVersion: string,
  candidateVersion: string
): SafeUpgradeLevel | undefined {
  const installed = semver.parse(installedVersion);
  const candidate = semver.parse(candidateVersion);

  if (!installed || !candidate) return undefined;
  if (candidate.major > installed.major) return "major";
  if (candidate.minor > installed.minor) return "minor";
  if (candidate.patch > installed.patch || candidate.version === installed.version) {
    return "patch";
  }

  return undefined;
}

/**
 * Get the tarball URL for a specific package version.
 * Used by the patch generation fallback path.
 */
export async function getTarballUrl(
  packageName: string,
  version: string
): Promise<string | undefined> {
  const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;

  try {
    const res = await httpClient({ url });

    if (!res.ok) return undefined;

    const data = res.data as {
      dist?: { tarball?: string };
    };
    return data.dist?.tarball;
  } catch {
    return undefined;
  }
}
