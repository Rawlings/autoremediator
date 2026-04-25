/**
 * npm registry API client
 *
 * Used to:
 * - Fetch the full list of published versions for a package
 * - Find the lowest semver-compatible safe upgrade from `firstPatchedVersion`
 * - Download tarballs for patch generation (fallback path)
 * - Query installed packages for outdated version information via the package manager
 *
 * Uses shared HTTP client for consistent error handling and timeouts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import semver from "semver";
import { httpClient } from "../../platform/http-client.js";
import { type PackageManager, detectPackageManager } from "../../platform/package-manager/index.js";


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

// ---------------------------------------------------------------------------
// Outdated package detection
// ---------------------------------------------------------------------------

export interface NpmRegistryPackageInfo {
  /** The version currently installed in node_modules */
  currentVersion: string;
  /** Latest version satisfying the declared semver range */
  wantedVersion: string;
  /** Absolute latest version published on the registry */
  latestVersion: string;
  /** True when latestVersion crosses a major boundary from currentVersion */
  isMajorBump: boolean;
  /** "direct" if listed in root package.json; "transitive" otherwise */
  dependencyScope: "direct" | "transitive";
}

interface NpmOutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
  type?: string;
}

/**
 * Reads package.json at cwd, resolves all deps against npm registry via the
 * package-manager's outdated command, and returns info keyed by package name.
 *
 * If `includeTransitive` is false (default), only direct dependencies are returned.
 * Private/unavailable packages are skipped silently.
 * Registry unavailability throws with a descriptive message.
 */
export async function queryOutdatedPackages(
  cwd: string,
  options: { includeTransitive?: boolean; packageManager?: string } = {}
): Promise<Map<string, NpmRegistryPackageInfo>> {
  const pm = (options.packageManager ?? detectPackageManager(cwd)) as PackageManager;

  // Determine the outdated command per PM
  let stdout: string;
  try {
    // npm and pnpm both use --json for machine-readable output.
    // Yarn v1 uses --json as well (NDJSON), so we attempt all the same way.
    // These commands exit with code 1 when outdated packages exist — that is expected.
    const args: string[] =
      pm === "pnpm" ? ["outdated", "--json"] : ["outdated", "--json"];
    const yarnArgs = pm === "yarn" ? ["outdated", "--json"] : undefined;
    const finalArgs = yarnArgs ?? args;

    const result = await execa(pm, finalArgs, {
      cwd,
      reject: false,
      stdio: "pipe",
    });

    // Exit code 0 = no outdated packages; 1 = outdated packages (expected).
    // Any other code or no stdout on a non-zero exit = real failure.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      if (!result.stdout) {
        throw new Error(
          `${pm} outdated --json failed (exit ${result.exitCode}): ${stderr.slice(0, 500)}`
        );
      }
    }
    stdout = typeof result.stdout === "string" ? result.stdout : "";
  } catch (err) {
    if (err instanceof Error && !err.message.includes("outdated --json failed")) {
      throw new Error(`Failed to query outdated packages: ${err.message}`);
    }
    throw err;
  }

  if (!stdout.trim()) {
    return new Map();
  }

  // Parse the npm/pnpm JSON format.
  // npm: { "packageName": { current, wanted, latest, type } }
  // pnpm v7+: may be array — handle both as best effort.
  // yarn v1: NDJSON — parse each line.
  const rawEntries: Record<string, NpmOutdatedEntry> = {};

  if (pm === "yarn") {
    // yarn outdated --json emits newline-delimited JSON objects
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string; data?: unknown };
        if (parsed.type === "table" && parsed.data) {
          const tableData = parsed.data as {
            head?: string[];
            body?: string[][];
          };
          const head = tableData.head ?? [];
          const currentIdx = head.indexOf("Current");
          const wantedIdx = head.indexOf("Wanted");
          const latestIdx = head.indexOf("Latest");
          for (const row of tableData.body ?? []) {
            const name = row[0];
            if (!name) continue;
            rawEntries[name] = {
              current: row[currentIdx] ?? "",
              wanted: row[wantedIdx] ?? "",
              latest: row[latestIdx] ?? "",
              type: row[head.indexOf("Package Type")] ?? "dependencies",
            };
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } else {
    // npm and pnpm JSON formats
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        // pnpm v7+ array format: [{ name, current, wanted, latest, dependencyType }]
        for (const entry of parsed as Array<{
          name?: string;
          packageName?: string;
          current?: string;
          wanted?: string;
          latest?: string;
          dependencyType?: string;
        }>) {
          const name = entry.name ?? entry.packageName;
          if (!name) continue;
          rawEntries[name] = {
            current: entry.current,
            wanted: entry.wanted,
            latest: entry.latest,
            type: entry.dependencyType,
          };
        }
      } else {
        // npm standard object format
        Object.assign(rawEntries, parsed as Record<string, NpmOutdatedEntry>);
      }
    } catch {
      throw new Error(`Could not parse ${pm} outdated --json output.`);
    }
  }

  // Read package.json to determine direct vs transitive deps
  let directDeps: Set<string>;
  try {
    const pkgRaw = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    directDeps = new Set([
      ...Object.keys(pkgRaw.dependencies ?? {}),
      ...Object.keys(pkgRaw.devDependencies ?? {}),
    ]);
  } catch {
    directDeps = new Set();
  }

  const result = new Map<string, NpmRegistryPackageInfo>();

  for (const [name, entry] of Object.entries(rawEntries)) {
    const currentVersion = entry.current ?? "";
    const wantedVersion = entry.wanted ?? currentVersion;
    const latestVersion = entry.latest ?? currentVersion;

    if (!currentVersion || !latestVersion) continue;

    const dependencyScope: "direct" | "transitive" = directDeps.has(name) ? "direct" : "transitive";

    // Skip transitive if not requested
    if (!options.includeTransitive && dependencyScope === "transitive") continue;

    const isMajorBump =
      semver.valid(currentVersion) !== null &&
      semver.valid(latestVersion) !== null &&
      semver.major(latestVersion) > semver.major(currentVersion);

    result.set(name, {
      currentVersion,
      wantedVersion,
      latestVersion,
      isMajorBump,
      dependencyScope,
    });
  }

  return result;
}
