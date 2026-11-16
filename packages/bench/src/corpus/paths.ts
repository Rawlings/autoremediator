/** Where the corpus lives. Committed data is in `corpus/`; tarballs are cached, never committed. */
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CORPUS_DIR = join(benchDir, "corpus");
export const PACKUMENT_DIR = join(CORPUS_DIR, "packuments");
export const ADVISORY_DIR = join(CORPUS_DIR, "advisories");
export const CACHE_DIR = join(benchDir, ".corpus-cache");

const PACKAGE_NAME = /^(?:@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/** An npm package name: one or two path segments of safe characters, none starting with a dot. */
export function isPackageName(name: string): boolean {
  return name.length <= 214 && PACKAGE_NAME.test(name);
}

export function isVersion(version: string): boolean {
  return version.length <= 128 && VERSION.test(version);
}

/** `@scope/name` -> `@scope__name`: one flat file per package. */
export function packageFileStem(name: string): string {
  return name.replaceAll("/", "__");
}

/** `file` inside `dir`, or a throw if resolving it would leave `dir`. */
function within(dir: string, file: string): string {
  const root = resolve(dir);
  const target = resolve(root, file);
  if (!target.startsWith(root + sep)) throw new Error(`${file} resolves outside ${dir}`);
  return target;
}

export function packumentPath(name: string, dir: string = PACKUMENT_DIR): string {
  if (!isPackageName(name)) throw new Error(`Not a package name: ${name}`);
  return within(dir, `${packageFileStem(name)}.json`);
}

export function tarballCachePath(
  name: string,
  version: string,
  cacheDir: string = CACHE_DIR,
): string {
  if (!isPackageName(name)) throw new Error(`Not a package name: ${name}`);
  if (!isVersion(version)) throw new Error(`Not a version: ${version}`);
  return within(cacheDir, join(packageFileStem(name), `${version}.tgz`));
}
