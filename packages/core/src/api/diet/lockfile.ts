import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

import { readManifest } from "./unused.js";

/** One installed package version. */
export interface LockNode {
  id: string;
  name: string;
  version: string;
  /** Where its package.json is, when the lockfile (npm) or the install layout (pnpm) says. */
  manifestFiles: string[];
  /** The lockfile itself marks it deprecated. */
  deprecated?: string;
  /** The lockfile itself marks it as running install scripts. */
  hasInstallScript?: boolean;
}

export interface LockEdge {
  /** The dependent: a node id, or `(project)`/a workspace package name for direct dependencies. */
  from: string;
  fromDirect: boolean;
  to: string;
  name: string;
  range?: string;
}

export interface LockGraph {
  format: "npm" | "pnpm";
  nodes: Map<string, LockNode>;
  edges: LockEdge[];
}

export interface LockfileResult {
  graph?: LockGraph;
  /** Why the lockfile could not be read. */
  unsupported?: string;
}

const nodeId = (name: string, version: string): string => `${name}@${version}`;

/** `npm:chalk@^2.4.2` (an alias) asks for the range `^2.4.2` of the real package. */
export function plainRange(spec: string | undefined): string | undefined {
  if (!spec?.startsWith("npm:")) return spec;
  const rest = spec.slice("npm:".length);
  const at = rest.lastIndexOf("@");
  return at > 0 ? rest.slice(at + 1) : undefined;
}

function ensureNode(graph: LockGraph, name: string, version: string): LockNode {
  const id = nodeId(name, version);
  let node = graph.nodes.get(id);
  if (!node) {
    node = { id, name, version, manifestFiles: [] };
    graph.nodes.set(id, node);
  }
  return node;
}

/** npm's lockfile v2/v3: `packages` keyed by install path. */
export function readNpmLockfile(root: string, text: string): LockfileResult {
  let data: {
    lockfileVersion?: number;
    packages?: Record<string, Record<string, unknown>>;
  };
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      unsupported: `package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!data.packages) {
    return {
      unsupported: `package-lock.json lockfileVersion ${data.lockfileVersion ?? 1} has no "packages" map (npm 7 or newer writes one)`,
    };
  }

  const graph: LockGraph = { format: "npm", nodes: new Map(), edges: [] };
  const entries = data.packages;
  const pathNamePattern = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/;

  // Workspace packages are in `packages` under their folder; `node_modules/<name>` links to them.
  const workspaceLinks = new Set<string>();
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.link === true) workspaceLinks.add(key);
  }
  const isProjectPackage = (key: string): boolean =>
    key === "" || (!key.includes("node_modules/") && !workspaceLinks.has(key));

  const nameOf = (key: string, entry: Record<string, unknown>): string | undefined =>
    (typeof entry.name === "string" ? entry.name : undefined) ?? pathNamePattern.exec(key)?.[1];

  const idAt = new Map<string, string>();
  for (const [key, entry] of Object.entries(entries)) {
    if (isProjectPackage(key) || entry.link === true) continue;
    const name = nameOf(key, entry);
    const version = typeof entry.version === "string" ? entry.version : undefined;
    if (!name || !version) continue;
    const node = ensureNode(graph, name, version);
    node.manifestFiles.push(join(root, key, "package.json"));
    if (typeof entry.deprecated === "string") node.deprecated = entry.deprecated;
    if (entry.hasInstallScript === true) node.hasInstallScript = true;
    idAt.set(key, node.id);
  }

  /** The install path that Node would resolve `name` to from `fromKey`: its own node_modules, then each parent's. */
  const resolveFrom = (fromKey: string, name: string): string | undefined => {
    let base = fromKey;
    for (;;) {
      const candidate = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
      if (idAt.has(candidate)) return candidate;
      if (workspaceLinks.has(candidate)) return undefined;
      if (base === "") return undefined;
      const cut = base.lastIndexOf("/node_modules/");
      base = cut === -1 ? "" : base.slice(0, cut);
    }
  };

  for (const [key, entry] of Object.entries(entries)) {
    const project = isProjectPackage(key);
    if (!project && !idAt.has(key)) continue;
    const from = project
      ? key === ""
        ? "(project)"
        : typeof entry.name === "string"
          ? entry.name
          : key
      : idAt.get(key)!;
    const ranges: Record<string, unknown> = {
      ...(entry.dependencies as object | undefined),
      ...(entry.optionalDependencies as object | undefined),
      ...(project ? (entry.devDependencies as object | undefined) : undefined),
    };
    for (const [name, range] of Object.entries(ranges)) {
      const target = resolveFrom(project ? (key === "" ? "" : key) : key, name);
      const to = target ? idAt.get(target) : undefined;
      if (!to) continue;
      graph.edges.push({
        from,
        fromDirect: project,
        to,
        name,
        range: typeof range === "string" ? plainRange(range) : undefined,
      });
    }
  }
  return { graph };
}

/** The pnpm lockfile document that holds the project (v9 can prepend one for pnpm's own install). */
function projectDocument(text: string): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  let bestSize = -1;
  for (const document of YAML.parseAllDocuments(text)) {
    const value = document.toJS() as Record<string, unknown> | null;
    if (!value || typeof value !== "object") continue;
    const size =
      Object.keys(value.snapshots ?? {}).length + Object.keys(value.packages ?? {}).length;
    if (size > bestSize) {
      best = value;
      bestSize = size;
    }
  }
  return best;
}

/** `foo@1.2.3(peer@1.0.0)` or `/foo@1.2.3(peer@1)` or `/foo/1.2.3` into name and version. */
function parsePnpmKey(raw: string): { name: string; version: string } | undefined {
  const key = raw.replace(/^\//, "").replace(/\(.*$/, "");
  const at = key.lastIndexOf("@");
  if (at > 0) return { name: key.slice(0, at), version: key.slice(at + 1) };
  return undefined;
}

/** What a pnpm dependency value resolves to: a version (maybe with a peer suffix), an alias, or a link. */
function parsePnpmValue(
  name: string,
  value: string,
): { name: string; version: string } | undefined {
  if (/^(link|file|workspace):/.test(value)) return undefined;
  const stripped = value.replace(/^npm:/, "").replace(/^\//, "").replace(/\(.*$/, "");
  if (/^\d/.test(stripped)) return { name, version: stripped };
  const aliased = parsePnpmKey(stripped);
  return aliased && /^\d/.test(aliased.version) ? aliased : undefined;
}

/** `.pnpm/<name>@<version>[_peers]` directories, indexed by `name@version`. */
function indexPnpmStore(root: string): Map<string, string> {
  const store = join(root, "node_modules", ".pnpm");
  const index = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(store);
  } catch {
    return index;
  }
  for (const entry of entries) {
    const match = /^((?:@[^@+]+\+)?[^@]+)@([^_]+)(?:_.*)?$/.exec(entry);
    if (!match?.[1] || !match[2]) continue;
    const name = match[1].replace("+", "/");
    const id = nodeId(name, match[2]);
    if (!index.has(id)) index.set(id, entry);
  }
  return index;
}

/** pnpm's lockfile v9 (`snapshots`) and v6 (`packages` with dependencies). */
export function readPnpmLockfile(root: string, text: string): LockfileResult {
  let data: Record<string, unknown> | undefined;
  try {
    data = projectDocument(text);
  } catch (error) {
    return {
      unsupported: `pnpm-lock.yaml could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!data) return { unsupported: "pnpm-lock.yaml holds no lockfile document" };
  const lockfileVersion =
    typeof data.lockfileVersion === "string" || typeof data.lockfileVersion === "number"
      ? String(data.lockfileVersion)
      : "";
  const version = Number.parseFloat(lockfileVersion);
  if (!(version >= 6)) {
    return {
      unsupported: `pnpm-lock.yaml lockfileVersion ${lockfileVersion || "(missing)"} is older than 6.0, which this analysis does not read`,
    };
  }

  const graph: LockGraph = { format: "pnpm", nodes: new Map(), edges: [] };
  const packages = (data.packages ?? {}) as Record<string, Record<string, unknown>>;
  const snapshots = (data.snapshots ?? undefined) as
    | Record<string, Record<string, unknown>>
    | undefined;
  const store = indexPnpmStore(root);

  const metaOf = new Map<string, Record<string, unknown>>();
  for (const [key, entry] of Object.entries(packages)) {
    const parsed = parsePnpmKey(key);
    if (parsed) metaOf.set(nodeId(parsed.name, parsed.version), entry);
  }

  const register = (name: string, versionText: string): LockNode => {
    const node = ensureNode(graph, name, versionText);
    if (node.manifestFiles.length === 0) {
      const directory = store.get(node.id);
      if (directory)
        node.manifestFiles.push(
          join(root, "node_modules", ".pnpm", directory, "node_modules", name, "package.json"),
        );
      const meta = metaOf.get(node.id);
      if (typeof meta?.deprecated === "string") node.deprecated = meta.deprecated;
      if (meta?.requiresBuild === true) node.hasInstallScript = true;
    }
    return node;
  };

  // Every installed version has a snapshot (v9) or a package entry (v6).
  const source = snapshots ?? packages;
  for (const key of Object.keys(source)) {
    const parsed = parsePnpmKey(key);
    if (parsed) register(parsed.name, parsed.version);
  }

  // Ranges between packages are not in the lockfile; the installed manifest of the dependent has them.
  const declaredRanges = new Map<string, Record<string, string>>();
  const rangesOf = (node: LockNode): Record<string, string> => {
    let ranges = declaredRanges.get(node.id);
    if (ranges) return ranges;
    ranges = {};
    for (const file of node.manifestFiles) {
      const manifest = readManifest(file);
      if (manifest) {
        Object.assign(ranges, manifest.dependencies, manifest.optionalDependencies);
        break;
      }
    }
    declaredRanges.set(node.id, ranges);
    return ranges;
  };

  for (const [key, entry] of Object.entries(source)) {
    const parsed = parsePnpmKey(key);
    if (!parsed) continue;
    const from = nodeId(parsed.name, parsed.version);
    const fromNode = graph.nodes.get(from);
    if (!fromNode) continue;
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      for (const [name, value] of Object.entries((entry[field] ?? {}) as Record<string, string>)) {
        const target = parsePnpmValue(name, value);
        if (!target) continue;
        const to = register(target.name, target.version).id;
        if (graph.edges.some((edge) => edge.from === from && edge.to === to && edge.name === name))
          continue;
        graph.edges.push({
          from,
          fromDirect: false,
          to,
          name,
          range: plainRange(rangesOf(fromNode)[name]),
        });
      }
    }
  }

  // Direct dependencies of the project and of each workspace package.
  const importers = (data.importers ?? { ".": data }) as Record<string, Record<string, unknown>>;
  for (const [importer, entry] of Object.entries(importers)) {
    const label =
      importer === "."
        ? "(project)"
        : (readManifest(join(root, importer, "package.json"))?.name ?? importer);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      for (const [name, value] of Object.entries((entry[field] ?? {}) as Record<string, unknown>)) {
        // v6+ writes { specifier, version }; older writes a bare version.
        const record =
          typeof value === "object" && value !== null
            ? (value as { specifier?: string; version?: string })
            : { version: String(value) };
        const target = record.version ? parsePnpmValue(name, record.version) : undefined;
        if (!target) continue;
        graph.edges.push({
          from: label,
          fromDirect: true,
          to: register(target.name, target.version).id,
          name,
          range: plainRange(record.specifier),
        });
      }
    }
  }
  return { graph };
}

export const LOCKFILES = [
  { file: "package-lock.json", format: "npm" },
  { file: "npm-shrinkwrap.json", format: "npm" },
  { file: "pnpm-lock.yaml", format: "pnpm" },
  { file: "yarn.lock", format: "yarn" },
  { file: "bun.lock", format: "bun" },
  { file: "bun.lockb", format: "bun" },
  { file: "deno.lock", format: "deno" },
] as const;

/** Find and read the lockfile at `root`. */
export function readLockfile(root: string): {
  file?: string;
  format?: string;
  result: LockfileResult;
} {
  for (const lock of LOCKFILES) {
    const path = join(root, lock.file);
    if (!existsSync(path)) continue;
    if (lock.format === "npm")
      return {
        file: lock.file,
        format: "npm",
        result: readNpmLockfile(root, readFileSync(path, "utf8")),
      };
    if (lock.format === "pnpm")
      return {
        file: lock.file,
        format: "pnpm",
        result: readPnpmLockfile(root, readFileSync(path, "utf8")),
      };
    return {
      file: lock.file,
      format: lock.format,
      result: {
        unsupported: `${lock.file} is a ${lock.format} lockfile, which duplicate and install-script analysis does not read yet (npm and pnpm are supported)`,
      },
    };
  }
  return { result: { unsupported: "no lockfile found" } };
}
