import { readFileSync } from "node:fs";

export interface LocatedFile {
  /** Package root directory (the one that holds package.json), always with `/` separators. */
  root: string;
  /** Name from the package's own package.json, else the directory name. */
  name: string;
  version: string;
  /** Path of the file relative to the root, with `/` separators. */
  file: string;
}

const MARKER = "/node_modules/";
const packageCache = new Map<string, { name: string; version: string }>();

function readManifest(root: string, dirName: string): { name: string; version: string } {
  const cached = packageCache.get(root);
  if (cached) return cached;
  let info = { name: dirName, version: "unknown" };
  try {
    const manifest = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    info = {
      name: typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : dirName,
      version:
        typeof manifest.version === "string" && manifest.version !== ""
          ? manifest.version
          : "unknown",
    };
  } catch {
    // An unreadable manifest still leaves a usable name from the directory.
  }
  packageCache.set(root, info);
  return info;
}

/**
 * Find the installed package a file belongs to: the innermost `node_modules/<name>` directory in its
 * path (the layout npm, pnpm, yarn and bun all produce after Node resolves symlinks). Files outside
 * any `node_modules`, such as the project's own code or linked workspace packages, return undefined.
 */
export function locatePackageFile(filename: string): LocatedFile | undefined {
  const path = filename.includes("\\") ? filename.replaceAll("\\", "/") : filename;
  const at = path.lastIndexOf(MARKER);
  if (at === -1) return undefined;
  const afterMarker = at + MARKER.length;
  const first = path.indexOf("/", afterMarker);
  if (first === -1) return undefined;
  let dirEnd = first;
  if (path.startsWith("@", afterMarker)) {
    dirEnd = path.indexOf("/", first + 1);
    if (dirEnd === -1) return undefined;
  }
  const root = path.slice(0, dirEnd);
  const dirName = path.slice(afterMarker, dirEnd);
  const info = readManifest(root, dirName);
  return { root, name: info.name, version: info.version, file: path.slice(dirEnd + 1) };
}

/** The package a bare specifier names: `lodash/fp` is `lodash`, `@scope/pkg/x` is `@scope/pkg`. */
export function rootPackageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}
