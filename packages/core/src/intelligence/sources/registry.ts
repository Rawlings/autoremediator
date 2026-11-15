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

import semver from "semver";

import { createHash } from "node:crypto";

import { httpClient } from "../../platform/http-client.js";
import { type PackageManager, detectPackageManager } from "../../platform/package-manager/index.js";
import {
  type RegistryConfig,
  defaultRegistryConfig,
  packumentUrl,
} from "../../platform/registry-config.js";
import { safeExeca } from "../../platform/safe-exec.js";

const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
const TARBALL_TIMEOUT_MS = 60_000;

export type SafeUpgradeLevel = "patch" | "minor" | "major";

export interface SafeUpgradeResolution {
  safeVersion?: string;
  upgradeLevel?: SafeUpgradeLevel;
  candidates: Partial<Record<SafeUpgradeLevel, string>>;
  majorOnlyFixAvailable: boolean;
  /**
   * Every acceptable fixed version, best first: smallest upgrade level, then lowest version,
   * with deprecated releases last. Callers that reject `safeVersion` can try the next one.
   */
  ordered: string[];
}

// ---------------------------------------------------------------------------
// Raw registry types (abbreviated)
// ---------------------------------------------------------------------------

interface NpmPackument {
  name: string;
  versions: Record<string, { version: string; deprecated?: string; dist: { tarball: string } }>;
  "dist-tags": Record<string, string>;
  time: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PackageVersionInfo {
  versions: string[];
  /** Versions the maintainers have marked deprecated. */
  deprecated: Set<string>;
}

/**
 * Fetch all published versions for an npm package, noting which are deprecated.
 * Returns empty info if the package is not found or the registry is unreachable.
 */
export async function fetchPackageVersionInfo(
  packageName: string,
  registry: RegistryConfig = defaultRegistryConfig,
): Promise<PackageVersionInfo> {
  const url = packumentUrl(registry, packageName);

  try {
    const res = await httpClient({ url, headers: registry.headersFor(url) });

    if (res.status === 404) return { versions: [], deprecated: new Set() };
    if (!res.ok) {
      throw new Error(`npm registry error ${res.status} for "${packageName}": ${res.text}`);
    }

    const data = res.data as NpmPackument;
    const versions = Object.keys(data.versions);
    const deprecated = new Set(
      versions.filter((version) => Boolean(data.versions[version]?.deprecated)),
    );
    return { versions, deprecated };
  } catch (err) {
    // If httpClient throws (timeout, network error), treat as not found
    if (err instanceof Error && err.message.includes("registry error")) {
      throw err;
    }
    return { versions: [], deprecated: new Set() };
  }
}

/**
 * Fetch all published versions for an npm package.
 * Returns an empty array if the package is not found.
 */
export async function fetchPackageVersions(
  packageName: string,
  registry: RegistryConfig = defaultRegistryConfig,
): Promise<string[]> {
  return (await fetchPackageVersionInfo(packageName, registry)).versions;
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
  vulnerableRange?: string,
  registry?: RegistryConfig,
): Promise<string | undefined> {
  const resolution = await resolveSafeUpgradeVersion(
    packageName,
    installedVersion,
    firstPatchedVersion,
    vulnerableRange,
    registry,
  );

  return resolution.safeVersion;
}

export async function resolveSafeUpgradeVersion(
  packageName: string,
  installedVersion: string,
  firstPatchedVersion: string,
  vulnerableRange?: string,
  registry?: RegistryConfig,
): Promise<SafeUpgradeResolution> {
  const { versions, deprecated } = await fetchPackageVersionInfo(packageName, registry);
  const none: SafeUpgradeResolution = {
    candidates: {},
    majorOnlyFixAvailable: false,
    ordered: [],
  };
  if (!versions.length) return none;

  // Prereleases are only acceptable when the project is already on one or the advisory's fix is one.
  const allowPrerelease =
    Boolean(semver.prerelease(installedVersion)) || Boolean(semver.prerelease(firstPatchedVersion));

  // All fixed versions >= firstPatchedVersion that are not themselves in the vulnerable range
  const fixed = versions
    .filter((v) => semver.valid(v) && semver.gte(v, firstPatchedVersion))
    .filter((v) => allowPrerelease || !semver.prerelease(v))
    .filter((v) => {
      if (!vulnerableRange) return true;
      try {
        return !semver.satisfies(v, vulnerableRange, { includePrerelease: false });
      } catch {
        // If vulnerable range cannot be parsed, avoid filtering out candidates.
        return true;
      }
    })
    .toSorted(semver.compare);

  if (!fixed.length) return none;

  // Deprecated releases are a last resort: they often still carry the fix, but maintainers
  // advise against them.
  const preferred = fixed.filter((v) => !deprecated.has(v));
  const pool = preferred.length > 0 ? preferred : fixed;

  const categorizedCandidates: SafeUpgradeResolution["candidates"] = {};
  const levelRank: Record<SafeUpgradeLevel, number> = { patch: 0, minor: 1, major: 2 };
  const ranked: Array<{ version: string; rank: number }> = [];

  for (const candidate of pool) {
    const level = classifyUpgradeLevel(installedVersion, candidate);
    if (!level) continue;
    ranked.push({ version: candidate, rank: levelRank[level] });
    if (!categorizedCandidates[level]) {
      categorizedCandidates[level] = candidate;
    }
  }

  // `pool` is ascending by version, and the sort is stable, so equal ranks stay ascending.
  const ordered = [
    ...ranked.toSorted((a, b) => a.rank - b.rank).map((entry) => entry.version),
    ...(pool === fixed ? [] : fixed.filter((v) => deprecated.has(v))),
  ];

  const safeVersion = ordered[0];
  if (!safeVersion) {
    return { candidates: categorizedCandidates, majorOnlyFixAvailable: false, ordered };
  }

  return {
    safeVersion,
    upgradeLevel: classifyUpgradeLevel(installedVersion, safeVersion),
    candidates: categorizedCandidates,
    majorOnlyFixAvailable:
      !categorizedCandidates.patch &&
      !categorizedCandidates.minor &&
      Boolean(categorizedCandidates.major),
    ordered,
  };
}

export function classifyUpgradeLevel(
  installedVersion: string,
  candidateVersion: string,
): SafeUpgradeLevel | undefined {
  const installed = semver.parse(installedVersion) ?? semver.coerce(installedVersion);
  const candidate = semver.parse(candidateVersion) ?? semver.coerce(candidateVersion);

  if (!installed || !candidate) return undefined;
  if (!semver.gte(candidate.version, installed.version)) return undefined;

  if (candidate.major > installed.major) return "major";
  if (candidate.major === installed.major && candidate.minor > installed.minor) return "minor";
  if (
    candidate.major === installed.major &&
    candidate.minor === installed.minor &&
    candidate.patch >= installed.patch
  ) {
    return "patch";
  }

  return undefined;
}

export interface TarballInfo {
  url: string;
  /** Subresource-integrity string, e.g. `sha512-<base64>`. */
  integrity?: string;
  /** Legacy hex SHA-1, present on older packages without `integrity`. */
  shasum?: string;
}

/**
 * Look up where a version's tarball lives and how to verify it.
 * Returns undefined when the registry has no such package/version; throws on network failure.
 */
export async function getTarballInfo(
  packageName: string,
  version: string,
  registry: RegistryConfig = defaultRegistryConfig,
): Promise<TarballInfo | undefined> {
  const url = `${packumentUrl(registry, packageName)}/${encodeURIComponent(version)}`;
  const res = await httpClient({ url, headers: registry.headersFor(url) });

  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`npm registry error ${res.status} for "${packageName}@${version}"`);
  }

  const dist = (res.data as { dist?: { tarball?: string; integrity?: string; shasum?: string } })
    .dist;
  if (!dist?.tarball) return undefined;
  return { url: dist.tarball, integrity: dist.integrity, shasum: dist.shasum };
}

/** Check tarball bytes against the registry-advertised digest. Missing digests cannot be checked. */
export function verifyTarballIntegrity(
  bytes: Uint8Array,
  info: Pick<TarballInfo, "integrity" | "shasum">,
): { ok: true; verified: boolean } | { ok: false; reason: string } {
  if (info.integrity) {
    // An SRI string may list several digests; any one matching is enough.
    const entries: Array<{ algorithm: string; digest: string }> = [];
    for (const entry of info.integrity.split(/\s+/)) {
      const dash = entry.indexOf("-");
      if (dash <= 0) continue;
      const algorithm = entry.slice(0, dash);
      if (["sha512", "sha384", "sha256"].includes(algorithm)) {
        entries.push({ algorithm, digest: entry.slice(dash + 1) });
      }
    }
    if (entries.length > 0) {
      const matches = entries.some(
        ({ algorithm, digest }) => createHash(algorithm).update(bytes).digest("base64") === digest,
      );
      return matches ? { ok: true, verified: true } : { ok: false, reason: "integrity mismatch" };
    }
  }
  if (info.shasum) {
    const matches = createHash("sha1").update(bytes).digest("hex") === info.shasum.toLowerCase();
    return matches ? { ok: true, verified: true } : { ok: false, reason: "shasum mismatch" };
  }
  return { ok: true, verified: false };
}

/** Download a tarball, sending registry credentials only if configured for that exact URL. */
export async function downloadTarball(
  info: TarballInfo,
  registry: RegistryConfig = defaultRegistryConfig,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TARBALL_TIMEOUT_MS);
  try {
    const res = await fetch(info.url, {
      headers: registry.headersFor(info.url),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} downloading ${info.url}`);
    }
    const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    if (declared > MAX_TARBALL_BYTES) {
      throw new Error(`Tarball too large (${declared} bytes)`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_TARBALL_BYTES) {
      throw new Error(`Tarball too large (${bytes.byteLength} bytes)`);
    }
    return bytes;
  } finally {
    clearTimeout(timer);
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
  options: { includeTransitive?: boolean; packageManager?: string } = {},
): Promise<Map<string, NpmRegistryPackageInfo>> {
  const pm = (options.packageManager ?? detectPackageManager(cwd)) as PackageManager;

  // Determine the outdated command per PM
  let stdout: string;
  try {
    // npm and pnpm both use --json for machine-readable output.
    // Yarn v1 uses --json as well (NDJSON), so we attempt all the same way.
    // These commands exit with code 1 when outdated packages exist — that is expected.
    const args: string[] = pm === "pnpm" ? ["outdated", "--json"] : ["outdated", "--json"];
    const yarnArgs = pm === "yarn" ? ["outdated", "--json"] : undefined;
    const finalArgs = yarnArgs ?? args;

    const result = await safeExeca(pm, finalArgs, {
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
          `${pm} outdated --json failed (exit ${result.exitCode}): ${stderr.slice(0, 500)}`,
        );
      }
    }
    stdout = typeof result.stdout === "string" ? result.stdout : "";
  } catch (err) {
    if (err instanceof Error && !err.message.includes("outdated --json failed")) {
      throw new Error(`Failed to query outdated packages: ${err.message}`, { cause: err });
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

// ---------------------------------------------------------------------------
// Release timeline (freshness)
// ---------------------------------------------------------------------------

export interface PackageTimeline {
  /** Every published version, in the registry's order. */
  versions: string[];
  /** Versions the maintainers have marked deprecated. */
  deprecated: Set<string>;
  /** Publish time of each version (ISO date), where the registry gives one. */
  published: Map<string, string>;
}

/**
 * The published versions of a package with when each was published, from its packument's `time`.
 * Returns undefined when the package is not on the registry. Throws on a registry error, so a
 * caller can tell "does not exist" from "could not be read".
 */
export async function fetchPackageTimeline(
  packageName: string,
  registry: RegistryConfig = defaultRegistryConfig,
): Promise<PackageTimeline | undefined> {
  const url = packumentUrl(registry, packageName);
  const res = await httpClient({ url, headers: registry.headersFor(url) });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`npm registry error ${res.status} for "${packageName}": ${res.text}`);
  }
  const data = res.data as Partial<NpmPackument>;
  const versions = Object.keys(data.versions ?? {});
  const published = new Map<string, string>();
  for (const version of versions) {
    const at = data.time?.[version];
    if (typeof at === "string" && !Number.isNaN(Date.parse(at))) published.set(version, at);
  }
  return {
    versions,
    deprecated: new Set(versions.filter((version) => Boolean(data.versions?.[version]?.deprecated))),
    published,
  };
}
