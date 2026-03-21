/**
 * npm registry API client
 *
 * Used to:
 * - Fetch the full list of published versions for a package
 * - Find the lowest semver-compatible safe upgrade from `firstPatchedVersion`
 * - Download tarballs for patch generation (fallback path)
 */
import semver from "semver";

const NPM_REGISTRY = "https://registry.npmjs.org";

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
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(
      `npm registry error ${res.status} for "${packageName}": ${await res.text()}`
    );
  }

  const data = (await res.json()) as NpmPackument;
  return Object.keys(data.versions);
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
  const versions = await fetchPackageVersions(packageName);
  if (!versions.length) return undefined;

  const installedMajor = semver.major(installedVersion);

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

  if (!candidates.length) return undefined;

  // Prefer same-major bump (semver-compatible)
  const sameMajor = candidates.find(
    (v) => semver.major(v) === installedMajor
  );
  if (sameMajor) return sameMajor;

  // Fallback: next-lowest available — caller should warn about major bump
  return candidates[0];
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
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) return undefined;

  const data = (await res.json()) as {
    dist?: { tarball?: string };
  };
  return data.dist?.tarball;
}
