/**
 * Building the real-data corpus for a project: resolve its dependency tree, then for every package
 * in it store the registry's published metadata and verified, screened tarballs.
 *
 * The tree is resolved with `npm install --package-lock-only --ignore-scripts`: npm reads metadata
 * and writes a lockfile, and downloads and runs nothing. Tarballs are then fetched by this code,
 * checked against the registry's own integrity hash, screened (`screen.ts`) and only then written to
 * the cache. A version that fails the screen is left out of the corpus, and the reason is recorded;
 * if it is one the project itself needs, curation stops.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import semver from "semver";
import { z } from "zod";

import { run } from "../exec.ts";
import { screenTarball } from "../screen.ts";
import {
  assertAllowedUrl,
  fetchJson,
  MAX_TARBALL_BYTES,
  registryUrl,
  type FetchBytes,
} from "./fetch.ts";
import { readLock, writeLock, type CorpusLock } from "./lock.ts";
import { parsePackument, trimPackument, versionsAsOf, type Packument } from "./packument.ts";
import { packumentPath, tarballCachePath } from "./paths.ts";

const REGISTRY = "https://registry.npmjs.org/";

const lockfileSchema = z.object({
  packages: z.record(
    z.string(),
    z.object({ version: z.string().optional(), link: z.boolean().optional() }).passthrough(),
  ),
});

export interface CurateOptions {
  snapshotDate: string;
  /** Resolve the tree as it was on this date (a "time capsule"); defaults to the snapshot date. */
  before?: string;
  get: FetchBytes;
  log: (line: string) => void;
  /** Versions to keep whatever the cap says, per package: the fixed versions the task's advisory names. */
  mustKeep?: ReadonlyMap<string, readonly string[]>;
  /** How many of the newest stable releases above the tree's own version to serve (default 30). */
  maxNewer?: number;
}

function sha512(data: Buffer): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

/**
 * `name -> versions` of every package the project's tree installs. With `pin`, the tree as it would
 * be once that package is moved to that version: a direct dependency is edited, anything else gets an
 * override. That is how the corpus ends up holding what a correct fix needs.
 */
export async function resolveTree(
  projectDir: string,
  before: string,
  pin?: { name: string; version: string },
): Promise<Map<string, string[]>> {
  const scratch = mkdtempSync(join(tmpdir(), "bench-resolve-"));
  try {
    const manifest = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const dependencies = { ...(manifest["dependencies"] as Record<string, string> | undefined) };
    const devDependencies = {
      ...(manifest["devDependencies"] as Record<string, string> | undefined),
    };
    const overrides: Record<string, string> = {};
    if (pin && pin.name in dependencies) dependencies[pin.name] = pin.version;
    else if (pin && pin.name in devDependencies) devDependencies[pin.name] = pin.version;
    else if (pin) overrides[pin.name] = pin.version;
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({
        name: "resolve",
        version: "1.0.0",
        private: true,
        dependencies,
        devDependencies,
        overrides,
      }),
    );
    writeFileSync(
      join(scratch, ".npmrc"),
      `registry=${REGISTRY}\nignore-scripts=true\naudit=false\nfund=false\n`,
    );
    const home = join(scratch, "home");
    mkdirSync(home);
    const result = await run(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--before=${before}`,
      ],
      {
        cwd: scratch,
        env: { PATH: process.env["PATH"] ?? "", HOME: home, npm_config_cache: join(home, "cache") },
        timeoutMs: 300_000,
      },
    );
    if (result.code !== 0) {
      throw new Error(`npm could not resolve the tree:\n${result.stderr.slice(-800)}`);
    }
    const lockfile = lockfileSchema.parse(
      JSON.parse(readFileSync(join(scratch, "package-lock.json"), "utf8")),
    );
    const tree = new Map<string, string[]>();
    for (const [path, entry] of Object.entries(lockfile.packages)) {
      if (path === "" || entry.link === true || entry.version === undefined) continue;
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      tree.set(name, [...new Set([...(tree.get(name) ?? []), entry.version])]);
    }
    return tree;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface Candidate {
  version: string;
  tarball: string;
  integrity?: string | undefined;
  shasum: string;
}

function candidatesOf(packument: Packument, versions: readonly string[]): Candidate[] {
  return versions.map((version) => {
    const dist = z
      .object({ tarball: z.string(), integrity: z.string().optional(), shasum: z.string() })
      .parse(packument.versions[version]?.["dist"]);
    return { version, ...dist };
  });
}

async function fetchVerified(candidate: Candidate, name: string, get: FetchBytes): Promise<Buffer> {
  assertAllowedUrl(candidate.tarball);
  const data = await get(candidate.tarball, { maxBytes: MAX_TARBALL_BYTES });
  const sha1 = createHash("sha1").update(data).digest("hex");
  if (sha1 !== candidate.shasum) {
    throw new Error(`${name}@${candidate.version}: sha1 differs from the registry's dist.shasum`);
  }
  if (candidate.integrity !== undefined && sha512(data) !== candidate.integrity) {
    throw new Error(
      `${name}@${candidate.version}: sha512 differs from the registry's dist.integrity`,
    );
  }
  return data;
}

/** Store one package: the published packument as of the snapshot, verified and screened tarballs. */
export async function curatePackage(
  name: string,
  treeVersions: readonly string[],
  options: CurateOptions,
  lock: CorpusLock,
): Promise<void> {
  const packument = parsePackument(await fetchJson(options.get, registryUrl(name)));
  const lowest = [...treeVersions].toSorted((a, b) => semver.compare(a, b))[0];
  if (lowest === undefined) throw new Error(`${name}: no version in the tree`);
  const entry = (lock.packages[name] ??= { versions: {}, excluded: {} });
  const already = new Set(Object.keys(entry.versions));
  const published = versionsAsOf(packument, options.snapshotDate);
  const newer = published
    .filter((version) => semver.gte(version, lowest) && semver.prerelease(version) === null)
    .slice(-(options.maxNewer ?? 30));
  const keep = new Set([
    ...treeVersions,
    ...already,
    ...newer,
    ...(options.mustKeep?.get(name) ?? []),
  ]);
  const wanted = published.filter((version) => keep.has(version));
  const served: string[] = [];
  for (const candidate of candidatesOf(packument, wanted)) {
    const cachePath = tarballCachePath(name, candidate.version);
    let data: Buffer | undefined = existsSync(cachePath) ? readFileSync(cachePath) : undefined;
    if (data === undefined || createHash("sha1").update(data).digest("hex") !== candidate.shasum) {
      data = await fetchVerified(candidate, name, options.get);
    }
    const screen = screenTarball(data);
    if (!screen.ok) {
      if (treeVersions.includes(candidate.version)) {
        throw new Error(
          `${name}@${candidate.version} is in the project's tree but fails the screen: ${screen.violations.map((v) => `${v.kind} ${v.path}`).join("; ")}`,
        );
      }
      entry.excluded[candidate.version] = screen.violations.map((v) => `${v.kind}: ${v.path}`);
      continue;
    }
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, data);
    delete entry.excluded[candidate.version];
    entry.versions[candidate.version] = {
      integrity: candidate.integrity ?? sha512(data),
      shasum: candidate.shasum,
    };
    served.push(candidate.version);
  }
  const target = packumentPath(name);
  mkdirSync(dirname(target), { recursive: true });
  const trimmed = trimPackument(packument, served, options.snapshotDate) as {
    versions: Record<string, { dist: Record<string, unknown> }>;
  };
  for (const version of served) {
    const dist = trimmed.versions[version]?.dist;
    if (dist) dist["integrity"] = entry.versions[version]?.integrity;
  }
  writeFileSync(target, `${JSON.stringify(trimmed, null, 2)}\n`);
  options.log(
    `  ${name}: ${served.length} versions stored, ${Object.keys(entry.excluded).length} excluded`,
  );
}

/** Curate every package in a project's resolved tree, then write the lock. */
export async function curateProject(projectDir: string, options: CurateOptions): Promise<void> {
  const before = options.before ?? options.snapshotDate;
  options.log(`resolving ${projectDir} as of ${before}`);
  const tree = await resolveTree(projectDir, before);
  for (const [name, versions] of options.mustKeep ?? []) {
    for (const version of versions) {
      options.log(`resolving the tree with ${name}@${version}`);
      for (const [found, foundVersions] of await resolveTree(projectDir, options.snapshotDate, {
        name,
        version,
      })) {
        tree.set(found, [...new Set([...(tree.get(found) ?? []), ...foundVersions])]);
      }
    }
  }
  const existing = readLock();
  if (existing && existing.snapshotDate !== options.snapshotDate) {
    throw new Error(
      `corpus/lock.json is frozen at ${existing.snapshotDate}; refusing to mix in ${options.snapshotDate}`,
    );
  }
  const lock: CorpusLock = existing ?? { snapshotDate: options.snapshotDate, packages: {} };
  for (const [name, versions] of [...tree].toSorted(([a], [b]) => a.localeCompare(b))) {
    await curatePackage(name, versions, options, lock);
  }
  writeLock(lock);
}

/** Run `work` over `items`, at most `limit` at a time. */
async function inParallel<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  });
  await Promise.all(workers);
}

/**
 * Rebuild the tarball cache from the lock on a fresh checkout: every pinned version that is not
 * cached is downloaded from the registry URL recorded in its packument, checked against the pin,
 * screened, and written. Nothing is trusted that does not match the lock.
 */
export async function restoreCorpus(options: {
  get: FetchBytes;
  log: (line: string) => void;
}): Promise<{ downloaded: number; present: number }> {
  const lock = readLock();
  if (!lock) throw new Error("corpus/lock.json does not exist: nothing to restore");
  const missing: { name: string; version: string; integrity: string }[] = [];
  let present = 0;
  for (const [name, entry] of Object.entries(lock.packages)) {
    for (const [version, pin] of Object.entries(entry.versions)) {
      if (existsSync(tarballCachePath(name, version))) present += 1;
      else missing.push({ name, version, integrity: pin.integrity });
    }
  }
  await inParallel(missing, 6, async ({ name, version, integrity }) => {
    const packument = parsePackument(JSON.parse(readFileSync(packumentPath(name), "utf8")));
    const url = z
      .string()
      .parse(
        z.object({ tarball: z.string() }).parse(packument.versions[version]?.["dist"]).tarball,
      );
    assertAllowedUrl(url);
    const data = await options.get(url, { maxBytes: MAX_TARBALL_BYTES });
    if (sha512(data) !== integrity) {
      throw new Error(
        `${name}@${version}: the registry's bytes do not match the pin in corpus/lock.json`,
      );
    }
    const screen = screenTarball(data);
    if (!screen.ok) {
      throw new Error(`${name}@${version} fails the screen: ${screen.violations[0]?.kind}`);
    }
    const target = tarballCachePath(name, version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  });
  options.log(`restored ${missing.length} tarballs, ${present} were already cached`);
  return { downloaded: missing.length, present };
}
