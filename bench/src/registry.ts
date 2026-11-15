/**
 * A tiny local npm registry, built from the fixture packages in `bench/registry/`.
 *
 * It serves what npm and autoremediator ask for and nothing else: packuments (`GET /<name>`) and
 * tarballs (`GET /<name>/-/<name>-<version>.tgz`). There is no uplink, so a package that is not a
 * fixture is a 404, and nothing a task does can reach the internet through it.
 *
 * Fixture layout: `registry/<name>/<version>/` is the package as published (package.json, code,
 * types, changelog); `registry/<name>/meta.json` is optional and may hold
 *   { "times": { "<version>": "<ISO date> | now-<N>h" }, "deprecated": { "<version>": "<message>" } }.
 * Versions without a time are dated 2024-03-01, i.e. long enough ago to pass any release-age gate.
 *
 * Standalone: `node bench/src/registry.ts [--port 4873]` serves the fixtures until interrupted.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";
import { z } from "zod";

import { packDirectory, type Tarball } from "./tarball.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_DIR = join(here, "..", "registry");

const OLD_ENOUGH = "2024-03-01T00:00:00.000Z";

const metaSchema = z
  .object({
    times: z.record(z.string(), z.string()).default({}),
    deprecated: z.record(z.string(), z.string()).default({}),
  })
  .strict();

interface FixtureVersion {
  version: string;
  manifest: Record<string, unknown>;
  tarball: Tarball;
  time: string;
  deprecated?: string;
}

interface FixturePackage {
  name: string;
  versions: FixtureVersion[];
}

export interface Registry {
  /** Base URL without a trailing slash, e.g. `http://127.0.0.1:41233`. */
  url: string;
  /** Requests served, by path, for the results file and for tests. */
  requests: string[];
  close: () => Promise<void>;
}

/** `now-3h` -> three hours before `now`; anything else is an ISO date and is kept. */
export function resolveTime(spec: string, now: number): string {
  const relative = /^now-(\d+)h$/.exec(spec);
  if (!relative) {
    if (Number.isNaN(Date.parse(spec))) throw new Error(`Invalid registry time: ${spec}`);
    return new Date(spec).toISOString();
  }
  return new Date(now - Number(relative[1]) * 3_600_000).toISOString();
}

/** Read the fixture packages. Throws on anything malformed, so a bad fixture is never half-served. */
export function loadFixturePackages(dir: string = DEFAULT_REGISTRY_DIR): FixturePackage[] {
  const packages: FixturePackage[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    const packageDir = join(dir, name);
    if (!statSync(packageDir).isDirectory()) continue;

    const metaPath = join(packageDir, "meta.json");
    const meta = metaSchema.parse(
      existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {},
    );

    const versions: FixtureVersion[] = [];
    for (const version of readdirSync(packageDir).filter((entry) => semver.valid(entry))) {
      const versionDir = join(packageDir, version);
      const manifest = JSON.parse(readFileSync(join(versionDir, "package.json"), "utf8")) as Record<
        string,
        unknown
      >;
      if (manifest["name"] !== name || manifest["version"] !== version) {
        throw new Error(`${versionDir}/package.json must declare ${name}@${version}`);
      }
      versions.push({
        version,
        manifest,
        tarball: packDirectory(versionDir),
        time: meta.times[version] ?? OLD_ENOUGH,
        ...(meta.deprecated[version] ? { deprecated: meta.deprecated[version] } : {}),
      });
    }
    if (versions.length === 0) throw new Error(`Fixture package ${name} has no versions`);
    versions.sort((a, b) => semver.compare(a.version, b.version));
    packages.push({ name, versions });
  }
  return packages;
}

/** The full packument npm and autoremediator read (publish times, scripts and tarball metadata). */
export function buildPackument(
  fixture: FixturePackage,
  baseUrl: string,
  now: number = Date.now(),
): Record<string, unknown> {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = {};
  for (const entry of fixture.versions) {
    const scripts = entry.manifest["scripts"] as Record<string, string> | undefined;
    const installScript = ["preinstall", "install", "postinstall"].some((key) => scripts?.[key]);
    versions[entry.version] = {
      ...entry.manifest,
      _id: `${fixture.name}@${entry.version}`,
      ...(installScript ? { hasInstallScript: true } : {}),
      ...(entry.deprecated ? { deprecated: entry.deprecated } : {}),
      dist: {
        tarball: `${baseUrl}/${fixture.name}/-/${fixture.name}-${entry.version}.tgz`,
        integrity: entry.tarball.integrity,
        shasum: entry.tarball.shasum,
      },
    };
    time[entry.version] = resolveTime(entry.time, now);
  }
  const latest = fixture.versions.findLast((entry) => !entry.deprecated) ?? fixture.versions.at(-1);
  const stamps = Object.values(time).toSorted();
  return {
    _id: fixture.name,
    name: fixture.name,
    "dist-tags": { latest: latest?.version },
    versions,
    time: { created: stamps[0], modified: stamps.at(-1), ...time },
  };
}

export async function startRegistry(
  options: { dir?: string; port?: number } = {},
): Promise<Registry> {
  const packages = new Map(
    loadFixturePackages(options.dir).map((fixture) => [fixture.name, fixture]),
  );
  const requests: string[] = [];

  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    requests.push(path);
    const host = request.headers.host ?? "127.0.0.1";
    const baseUrl = `http://${host}`;

    const send = (status: number, body: string | Buffer, type: string) => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    const notFound = () =>
      send(
        404,
        JSON.stringify({ error: "not found (bench registry has fixtures only)" }),
        "application/json",
      );

    if (request.method !== "GET") return send(405, "{}", "application/json");

    const tarball = /^\/(.+)\/-\/.+-(\d+\.\d+\.\d+[^/]*)\.tgz$/.exec(path);
    if (tarball) {
      const entry = packages.get(tarball[1] ?? "")?.versions.find((v) => v.version === tarball[2]);
      return entry ? send(200, entry.tarball.data, "application/octet-stream") : notFound();
    }

    const fixture = packages.get(path.slice(1));
    return fixture
      ? send(200, JSON.stringify(buildPackument(fixture, baseUrl)), "application/json")
      : notFound();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("registry has no port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag === -1 ? 4873 : Number(process.argv[portFlag + 1]);
  const registry = await startRegistry({ port });
  process.stdout.write(`bench registry listening on ${registry.url}\n`);
  process.stdout.write(`  use it with: npm install --registry ${registry.url}\n`);
}
