/**
 * `corpus/lock.json`: the pin that makes the corpus reproducible. For every package and
 * version the benchmark may serve it records the registry's own integrity hash, and for every
 * version that was left out, why. Tarballs themselves are never committed: they are fetched into
 * `.corpus-cache/`, checked against this file, and served from there.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CORPUS_DIR } from "./paths.ts";

const versionSchema = z.object({
  /** `dist.integrity` as the registry published it (`sha512-<base64>`). */
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  shasum: z.string().regex(/^[0-9a-f]{40}$/),
});

const packageSchema = z.object({
  versions: z.record(z.string(), versionSchema),
  /** Versions the registry lists but the benchmark does not serve, with the screen's reasons. */
  excluded: z.record(z.string(), z.array(z.string())).default({}),
});

export const lockSchema = z.object({
  /** Registry state is frozen at this instant: later publications are not in the corpus. */
  snapshotDate: z.string(),
  packages: z.record(z.string(), packageSchema),
});
export type CorpusLock = z.infer<typeof lockSchema>;

export const LOCK_PATH = join(CORPUS_DIR, "lock.json");

export function readLock(path: string = LOCK_PATH): CorpusLock | undefined {
  if (!existsSync(path)) return undefined;
  return lockSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)));
}

export function writeLock(lock: CorpusLock, path: string = LOCK_PATH): void {
  const stable: CorpusLock = {
    snapshotDate: lock.snapshotDate,
    packages: sorted(
      Object.fromEntries(
        Object.entries(lock.packages).map(([name, entry]) => [
          name,
          { versions: sorted(entry.versions), excluded: sorted(entry.excluded) },
        ]),
      ),
    ),
  };
  writeFileSync(path, `${JSON.stringify(stable, null, 2)}\n`);
}
