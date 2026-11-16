/**
 * The corpus side of the benchmark's local registry. It serves packuments exactly as the
 * registry published them (limited to the snapshot date, tarball URLs pointed at this server) and
 * tarballs exactly as published, after checking each against `corpus/lock.json`. A package or
 * version that is not in the lock is not served, and neither is a tarball whose bytes no longer
 * match the pin: the caller gets an error and the miss is recorded, never a silent substitute.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { LOCK_PATH, readLock, type CorpusLock } from "./lock.ts";
import { CACHE_DIR, packumentPath, PACKUMENT_DIR, tarballCachePath } from "./paths.ts";

export type TarballResult = { ok: true; data: Buffer } | { ok: false; reason: string };

export interface Corpus {
  has: (name: string) => boolean;
  packument: (name: string, baseUrl: string) => Record<string, unknown> | undefined;
  tarball: (name: string, version: string) => TarballResult;
}

const storedPackument = z
  .object({ versions: z.record(z.string(), z.record(z.string(), z.unknown())) })
  .passthrough();

function integrityOf(data: Buffer): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

export function loadCorpus(
  options: { lockPath?: string; packumentDir?: string; cacheDir?: string } = {},
): Corpus | undefined {
  const lock: CorpusLock | undefined = readLock(options.lockPath ?? LOCK_PATH);
  if (!lock) return undefined;
  const verified = new Map<string, Buffer>();

  return {
    has: (name) => lock.packages[name] !== undefined,

    packument(name, baseUrl) {
      const file = packumentPath(name, options.packumentDir ?? PACKUMENT_DIR);
      if (lock.packages[name] === undefined || !existsSync(file)) return undefined;
      const stored = storedPackument.parse(JSON.parse(readFileSync(file, "utf8")));
      const base = name.slice(name.lastIndexOf("/") + 1);
      for (const [version, manifest] of Object.entries(stored.versions)) {
        const dist = z.record(z.string(), z.unknown()).parse(manifest["dist"]);
        manifest["dist"] = { ...dist, tarball: `${baseUrl}/${name}/-/${base}-${version}.tgz` };
      }
      return stored;
    },

    tarball(name, version) {
      const pinned = lock.packages[name]?.versions[version];
      if (!pinned) return { ok: false, reason: `${name}@${version} is not in the corpus lock` };
      const key = `${name}@${version}`;
      const known = verified.get(key);
      if (known) return { ok: true, data: known };
      const path = tarballCachePath(name, version, options.cacheDir ?? CACHE_DIR);
      if (!existsSync(path)) {
        return {
          ok: false,
          reason: `${key} is pinned but not cached: run \`pnpm bench:corpus fetch\``,
        };
      }
      const data = readFileSync(path);
      if (integrityOf(data) !== pinned.integrity) {
        return { ok: false, reason: `${key} does not match its pin in corpus/lock.json` };
      }
      verified.set(key, data);
      return { ok: true, data };
    },
  };
}
