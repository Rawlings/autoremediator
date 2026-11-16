/** Where the corpus lives. Committed data is in `corpus/`; tarballs are cached, never committed. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CORPUS_DIR = join(benchDir, "corpus");
export const PACKUMENT_DIR = join(CORPUS_DIR, "packuments");
export const ADVISORY_DIR = join(CORPUS_DIR, "advisories");
export const CACHE_DIR = join(benchDir, ".corpus-cache");

/** `@scope/name` -> `@scope__name`: one flat file per package. */
export function packageFileStem(name: string): string {
  return name.replace("/", "__");
}

export function packumentPath(name: string, dir: string = PACKUMENT_DIR): string {
  return join(dir, `${packageFileStem(name)}.json`);
}

export function tarballCachePath(
  name: string,
  version: string,
  cacheDir: string = CACHE_DIR,
): string {
  return join(cacheDir, packageFileStem(name), `${version}.tgz`);
}
