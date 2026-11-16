/**
 * Checks that the committed corpus is what the lock says it is, so nothing in it can drift or be
 * edited by hand: packuments match the lock, cached tarballs match their pins and pass the screen,
 * and every corpus task's snapshot comes from the advisory it cites.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { screenTarball } from "../screen.ts";
import { intelIsCurrent } from "./freeze.ts";
import { readLock } from "./lock.ts";
import { parsePackument } from "./packument.ts";
import { CACHE_DIR, packumentPath, tarballCachePath } from "./paths.ts";

export interface VerifyOptions {
  /** Treat a pinned tarball that is not in the cache as a problem (otherwise it is only counted). */
  requireCache?: boolean;
  tasksDir: string;
}

export interface VerifyReport {
  problems: string[];
  /** Pinned tarballs that are not cached yet. */
  uncached: number;
  versions: number;
}

export function verifyCorpus(options: VerifyOptions): VerifyReport {
  const problems: string[] = [];
  let uncached = 0;
  let versions = 0;
  const lock = readLock();
  for (const [name, entry] of Object.entries(lock?.packages ?? {})) {
    const file = packumentPath(name);
    if (!existsSync(file)) {
      problems.push(`${name}: no packument file`);
      continue;
    }
    const packument = parsePackument(JSON.parse(readFileSync(file, "utf8")));
    const stored = Object.keys(packument.versions).toSorted();
    const pinned = Object.keys(entry.versions).toSorted();
    if (stored.join() !== pinned.join()) {
      problems.push(`${name}: packument versions differ from the lock`);
    }
    for (const [version, pin] of Object.entries(entry.versions)) {
      versions += 1;
      const dist = packument.versions[version]?.["dist"] as { integrity?: string } | undefined;
      if (dist?.integrity !== pin.integrity) {
        problems.push(`${name}@${version}: packument integrity differs from the lock`);
      }
      const cached = tarballCachePath(name, version, CACHE_DIR);
      if (!existsSync(cached)) {
        uncached += 1;
        if (options.requireCache) problems.push(`${name}@${version}: not cached`);
        continue;
      }
      const data = readFileSync(cached);
      const hash = `sha512-${createHash("sha512").update(data).digest("base64")}`;
      if (hash !== pin.integrity) {
        problems.push(`${name}@${version}: cached tarball differs from its pin`);
      }
      const screen = screenTarball(data);
      if (!screen.ok) {
        problems.push(`${name}@${version}: fails the screen (${screen.violations[0]?.kind})`);
      }
    }
  }
  for (const id of readdirSync(options.tasksDir)) {
    const dir = join(options.tasksDir, id);
    const task = existsSync(join(dir, "task.json"))
      ? readFileSync(join(dir, "task.json"), "utf8")
      : "";
    if (!task.includes('"origin": "corpus"')) continue;
    if (!intelIsCurrent(dir)) problems.push(`${id}: intel.json differs from the advisory it cites`);
  }
  return { problems, uncached, versions };
}
