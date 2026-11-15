import { isRecord } from "../../../shared/guards.js";
import {
  stringMap,
  type LockGraph,
  type LockNode,
  type LockRoot,
  type ManifestDeps,
} from "./types.js";

interface RawEntry {
  name?: string;
  version?: string;
  link?: boolean;
  resolved?: string;
  hasInstallScript?: boolean;
  /** dependencies and optionalDependencies */
  dependencies: string[];
  peerDependencies: string[];
  devDependencies: string[];
}

const keysOf = (value: unknown): string[] => Object.keys(stringMap(value));

/** v2 and v3 lockfiles: a flat `packages` map keyed by install path. */
function fromPackages(packages: Record<string, unknown>): Map<string, RawEntry> {
  const entries = new Map<string, RawEntry>();
  for (const [key, raw] of Object.entries(packages)) {
    if (!isRecord(raw)) continue;
    entries.set(key, {
      ...(typeof raw["name"] === "string" ? { name: raw["name"] } : {}),
      ...(typeof raw["version"] === "string" ? { version: raw["version"] } : {}),
      ...(raw["link"] === true ? { link: true } : {}),
      ...(typeof raw["resolved"] === "string" ? { resolved: raw["resolved"] } : {}),
      ...(raw["hasInstallScript"] === true ? { hasInstallScript: true } : {}),
      dependencies: [...keysOf(raw["dependencies"]), ...keysOf(raw["optionalDependencies"])],
      peerDependencies: keysOf(raw["peerDependencies"]),
      devDependencies: keysOf(raw["devDependencies"]),
    });
  }
  return entries;
}

/** v1 lockfiles: a nested `dependencies` tree; flattened into the v2 path-keyed shape. */
function fromNestedTree(
  tree: Record<string, unknown>,
  prefix = "",
  out = new Map<string, RawEntry>(),
): Map<string, RawEntry> {
  for (const [name, raw] of Object.entries(tree)) {
    if (!isRecord(raw)) continue;
    const key = `${prefix}node_modules/${name}`;
    out.set(key, {
      ...(typeof raw["version"] === "string" ? { version: raw["version"] } : {}),
      dependencies: keysOf(raw["requires"]),
      peerDependencies: [],
      devDependencies: [],
    });
    if (isRecord(raw["dependencies"])) fromNestedTree(raw["dependencies"], `${key}/`, out);
  }
  return out;
}

function nameFromKey(key: string): string {
  const marker = "node_modules/";
  const at = key.lastIndexOf(marker);
  return at === -1 ? key : key.slice(at + marker.length);
}

/** Where Node looks, in order, for a dependency of the package installed at `from`. */
function searchLocations(from: string): string[] {
  const locations = [from];
  let location = from;
  while (location !== "") {
    const at = location.lastIndexOf("/node_modules/");
    // A top-level install or a workspace directory is enclosed by the project root.
    location = at === -1 ? "" : location.slice(0, at);
    locations.push(location);
  }
  return locations;
}

/** Parse `package-lock.json` / `npm-shrinkwrap.json` (lockfile versions 1, 2 and 3). */
export function parseNpmLock(content: string, manifest: ManifestDeps = {}): LockGraph {
  const data: unknown = JSON.parse(content);
  if (!isRecord(data)) throw new Error("package-lock.json is not a JSON object");

  const entries = isRecord(data["packages"])
    ? fromPackages(data["packages"])
    : isRecord(data["dependencies"])
      ? fromNestedTree(data["dependencies"])
      : new Map<string, RawEntry>();

  const resolve = (from: string, name: string): string | undefined => {
    for (const location of searchLocations(from)) {
      const candidate =
        location === "" ? `node_modules/${name}` : `${location}/node_modules/${name}`;
      const hit = entries.get(candidate);
      if (!hit) continue;
      // A workspace package is installed as a link to its source directory.
      return hit.link && hit.resolved !== undefined && entries.has(hit.resolved)
        ? hit.resolved
        : candidate;
    }
    return undefined;
  };

  const nodes = new Map<string, LockNode>();
  for (const [key, entry] of entries) {
    if (key === "" || entry.link || entry.version === undefined) continue;
    const deps = new Set<string>();
    for (const dep of [...entry.dependencies, ...entry.peerDependencies]) {
      const target = resolve(key, dep);
      if (target !== undefined) deps.add(target);
    }
    nodes.set(key, {
      id: key,
      name: entry.name ?? nameFromKey(key),
      version: entry.version,
      deps: [...deps],
      ...(entry.hasInstallScript ? { installScript: true } : {}),
    });
  }

  const rootOf = (
    workspace: string,
    location: string,
    prod: string[],
    dev: string[],
  ): LockRoot => ({
    workspace,
    prod: prod.flatMap((name) => resolve(location, name) ?? []),
    dev: dev.flatMap((name) => resolve(location, name) ?? []),
  });

  const rootEntry = entries.get("");
  const roots: LockRoot[] = [
    rootEntry
      ? rootOf(".", "", rootEntry.dependencies, rootEntry.devDependencies)
      : // Lockfile v1 does not record what the project itself asks for.
        rootOf(
          ".",
          "",
          [
            ...Object.keys(manifest.dependencies ?? {}),
            ...Object.keys(manifest.optionalDependencies ?? {}),
          ],
          Object.keys(manifest.devDependencies ?? {}),
        ),
  ];
  for (const [key, entry] of entries) {
    if (key === "" || entry.link || key.includes("node_modules/")) continue;
    roots.push(rootOf(key, key, entry.dependencies, entry.devDependencies));
  }
  return { format: "npm", nodes, roots, recordsInstallScripts: isRecord(data["packages"]) };
}
