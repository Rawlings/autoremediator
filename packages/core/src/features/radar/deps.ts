/**
 * The real dependencies of radar: lockfile and `node_modules` for what is installed, the npm
 * registry for versions and tarballs (integrity-verified, read in memory, never extracted), OSV for
 * advisories, and optionally GitHub release notes. Nothing else touches the network or the disk.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";

import { httpClient, HttpError } from "../../infra/http/http-client.js";
import { loadRegistryConfig, packumentUrl } from "../../infra/http/registry-config.js";
import { assessUpgrade } from "../impact/assess.js";
import { readPackageTarball } from "../impact/tarball.js";
import { loadProjectLocks } from "../incident/project.js";
import { parseOsvVuln, queryOsvPackage } from "../intelligence/sources/osv.js";
import {
  downloadTarball,
  getTarballInfo,
  verifyTarballIntegrity,
} from "../intelligence/sources/registry.js";
import { findOccurrences } from "../scan/lock-graph/index.js";
import type { PackumentVersion } from "./signals/metadata.js";
import type {
  ByteBudget,
  GithubReleases,
  InstalledPackage,
  RadarDeps,
  RadarPackage,
  RegistryVersions,
} from "./types.js";

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const PACKUMENT_TIMEOUT_MS = 30_000;
const GITHUB_TIMEOUT_MS = 15_000;
const GITHUB_MAX_BYTES = 5 * 1024 * 1024;

export class ByteBudgetExceeded extends Error {
  constructor(limit: number, what: string) {
    super(`Download budget of ${limit} bytes is spent; not fetching ${what}`);
    this.name = "ByteBudgetExceeded";
  }
}

export function createByteBudget(limit: number): ByteBudget {
  return {
    limit,
    used: 0,
    charge(bytes) {
      this.used += bytes;
    },
    assertRoom(what) {
      if (this.used >= this.limit) throw new ByteBudgetExceeded(this.limit, what);
    },
  };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What is installed: from the lockfiles, else from `node_modules` for the direct dependencies. */
function listInstalled(cwd: string): InstalledPackage[] {
  const { locks, manifest } = loadProjectLocks(cwd);
  const found = new Map<string, InstalledPackage>();
  for (const lock of locks) {
    for (const occurrence of findOccurrences(lock.graph, () => true)) {
      if (occurrence.scope === "unreferenced" || !semver.valid(occurrence.version)) continue;
      const key = `${occurrence.name}@${occurrence.version}`;
      const existing = found.get(key);
      found.set(key, {
        name: occurrence.name,
        version: occurrence.version,
        direct: (existing?.direct ?? false) || occurrence.direct,
        scope: existing?.scope === "production" ? "production" : occurrence.scope,
      });
    }
  }
  if (found.size > 0 || locks.length > 0) return [...found.values()];

  // No lockfile: the direct dependencies as installed in node_modules.
  const names = new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
    ...Object.keys(manifest?.optionalDependencies ?? {}),
  ]);
  for (const name of names) {
    if (!PACKAGE_NAME.test(name)) continue;
    const installed = readJson(join(cwd, "node_modules", name, "package.json"));
    const version = installed?.["version"];
    if (typeof version !== "string" || !semver.valid(version)) continue;
    found.set(`${name}@${version}`, {
      name,
      version,
      direct: true,
      scope: Object.hasOwn(manifest?.dependencies ?? {}, name) ? "production" : "development",
    });
  }
  return [...found.values()];
}

interface RawPackument {
  versions?: Record<string, { deprecated?: unknown } | undefined>;
  time?: Record<string, unknown>;
  "dist-tags"?: Record<string, unknown>;
}

async function fetchVersions(
  name: string,
  cwd: string,
  budget: ByteBudget,
): Promise<RegistryVersions | undefined> {
  if (!PACKAGE_NAME.test(name)) throw new Error(`Invalid package name: ${name}`);
  budget.assertRoom(`${name} metadata`);
  const registry = loadRegistryConfig(cwd);
  const url = packumentUrl(registry, name);
  const request = async (abbreviated: boolean) =>
    httpClient({
      url,
      headers: {
        ...registry.headersFor(url),
        Accept: abbreviated ? "application/vnd.npm.install-v1+json" : "application/json",
      },
      timeout: PACKUMENT_TIMEOUT_MS,
    });

  let note: string | undefined;
  let response;
  try {
    response = await request(false);
  } catch (error) {
    // The full document (which has publish times) can exceed the HTTP client's size cap.
    if (!(error instanceof HttpError) || !/too large|exceeds/i.test(error.message)) throw error;
    response = await request(true);
    note =
      "publish times were unavailable (registry document too large); timing signals were skipped";
  }
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry error ${response.status} for "${name}"`);
  const bytes = response.text.length;
  budget.charge(bytes);
  const data = response.data as RawPackument;
  const times = data.time ?? {};
  const versions = Object.entries(data.versions ?? {})
    .filter(([version]) => semver.valid(version) && !semver.prerelease(version))
    .map(([version, entry]): PackumentVersion => {
      const result: PackumentVersion = { version };
      const published = times[version];
      if (typeof entry?.deprecated === "string" && entry.deprecated !== "") {
        result.deprecated = entry.deprecated;
      }
      if (typeof published === "string") result.publishedAt = published;
      return result;
    });
  const latest = data["dist-tags"]?.["latest"];
  return {
    versions,
    ...(typeof latest === "string" ? { latest } : {}),
    bytes,
    ...(note ? { note } : {}),
  };
}

async function loadPackage(
  name: string,
  version: string,
  cwd: string,
  budget: ByteBudget,
): Promise<RadarPackage> {
  if (!PACKAGE_NAME.test(name)) throw new Error(`Invalid package name: ${name}`);
  if (!semver.valid(version)) throw new Error(`Not an exact version: ${version}`);
  budget.assertRoom(`${name}@${version}`);
  const registry = loadRegistryConfig(cwd);
  const info = await getTarballInfo(name, version, registry);
  if (!info) throw new Error(`${name}@${version} was not found on the registry`);
  const bytes = await downloadTarball(info, registry);
  budget.charge(bytes.byteLength);
  const integrity = verifyTarballIntegrity(bytes, info);
  if (!integrity.ok) {
    throw new Error(
      `Refusing ${name}@${version}: tarball failed verification (${integrity.reason})`,
    );
  }
  const { files, manifest, docs } = readPackageTarball(bytes, undefined, { includeDocs: true });
  return {
    name,
    version,
    files,
    manifest,
    integrityVerified: integrity.verified,
    docs: docs ?? new Map(),
  };
}

async function queryAdvisories(name: string, version: string) {
  const vulns = await queryOsvPackage(name, version);
  const found = new Map<string, { id: string; fixedIn?: string; range?: string }>();
  for (const vuln of vulns) {
    const details = parseOsvVuln(vuln);
    const affected = details.affectedPackages.find((entry) => entry.name === name);
    if (!affected || found.has(details.id)) continue;
    found.set(details.id, {
      id: details.id,
      ...(affected.firstPatchedVersion ? { fixedIn: affected.firstPatchedVersion } : {}),
      ...(affected.vulnerableRange ? { range: affected.vulnerableRange } : {}),
    });
  }
  return [...found.values()];
}

/**
 * Unauthenticated GitHub releases. Never sends a token. Stops and says so when the rate limit is
 * reached, and does not try again for the rest of the run.
 */
function createGithubFetcher(): RadarDeps["fetchGithubReleases"] {
  let exhausted: string | undefined;
  return async ({ owner, repo }): Promise<GithubReleases> => {
    if (exhausted) return { releases: [], note: exhausted };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "autoremediator-radar",
          },
          signal: controller.signal,
        },
      );
      const remaining = Number.parseInt(response.headers.get("x-ratelimit-remaining") ?? "", 10);
      const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
      if (response.status === 403 || response.status === 429 || remaining === 0) {
        exhausted = `GitHub rate limit reached${
          Number.isFinite(reset) ? ` (resets ${new Date(reset * 1000).toISOString()})` : ""
        }; release notes were not read for the remaining packages`;
        if (response.status === 403 || response.status === 429)
          return { releases: [], note: exhausted };
      } else if (Number.isFinite(remaining) && remaining <= 2) {
        exhausted =
          "GitHub rate limit nearly spent; release notes were not read for the remaining packages";
      }
      if (response.status === 404)
        return { releases: [], note: `${owner}/${repo} has no releases on GitHub` };
      if (!response.ok)
        return { releases: [], note: `GitHub answered ${response.status} for ${owner}/${repo}` };
      const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (declared > GITHUB_MAX_BYTES)
        return { releases: [], note: `GitHub releases for ${owner}/${repo} are too large` };
      const text = await response.text();
      if (text.length > GITHUB_MAX_BYTES)
        return { releases: [], note: `GitHub releases for ${owner}/${repo} are too large` };
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return { releases: [] };
      const releases = parsed.flatMap((entry: unknown) => {
        const record =
          typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
        const tag = record["tag_name"];
        const body = record["body"];
        return typeof tag === "string" && typeof body === "string" ? [{ tag, body }] : [];
      });
      return { releases, ...(exhausted ? { note: exhausted } : {}) };
    } catch (error) {
      return {
        releases: [],
        note: `GitHub releases for ${owner}/${repo} could not be read (${error instanceof Error ? error.name : "error"})`,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createDefaultRadarDeps(): RadarDeps {
  return {
    listInstalled,
    fetchVersions,
    loadPackage,
    queryAdvisories,
    fetchGithubReleases: createGithubFetcher(),
    assess: (name, from, to, cwd, load) =>
      assessUpgrade(name, from, to, { cwd }, { loadPackage: (n, v) => load(n, v) }),
  };
}
