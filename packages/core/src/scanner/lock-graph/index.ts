import semver from "semver";

import { parseBunLock } from "./bun.js";
import { parseNpmLock } from "./npm.js";
import { parsePnpmLock } from "./pnpm.js";
import { lockFormatOf, type LockGraph, type ManifestDeps } from "./types.js";
import { parseYarnLock } from "./yarn.js";

export { LOCKFILE_NAMES, lockFormatOf } from "./types.js";
export type { LockFormat, LockGraph, LockNode, LockRoot, ManifestDeps } from "./types.js";

/**
 * Read a lockfile as a graph. `path` is only used to tell which format it is. Throws when the
 * content is not a lockfile of that format; returns undefined for a file name that is not a lockfile.
 */
export function parseLockGraph(
  path: string,
  content: string,
  manifest?: ManifestDeps,
): LockGraph | undefined {
  const format = lockFormatOf(path);
  if (format === "npm") return parseNpmLock(content, manifest);
  if (format === "pnpm") return parsePnpmLock(content);
  if (format === "yarn") return parseYarnLock(content, manifest);
  if (format === "bun") return parseBunLock(content);
  return undefined;
}

export interface PackageOccurrence {
  name: string;
  version: string;
  nodeId: string;
  /** Asked for by a manifest of the project (or a workspace) itself. */
  direct: boolean;
  /** `unreferenced`: in the lockfile, but nothing the manifests ask for leads to it. */
  scope: "production" | "development" | "unreferenced";
  /** The workspaces that depend on it directly. */
  workspaces: string[];
  /** Shortest chain from a workspace to this package: the workspace, then `name@version` per hop. */
  via: string[];
  /** Packages that depend on it directly, as `name@version` (at most five). */
  dependents: string[];
  /** Whether installing it runs scripts, as far as the lockfile says; absent when the format does not record it. */
  installScript?: boolean;
}

/** Breadth-first search from the given nodes; `parent` points back along a shortest path. */
function reach(
  graph: LockGraph,
  starts: Array<{ id: string; workspace: string }>,
): Map<string, string> {
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const start of starts) {
    if (!graph.nodes.has(start.id) || parent.has(start.id)) continue;
    parent.set(start.id, `workspace:${start.workspace}`);
    queue.push(start.id);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    for (const dep of graph.nodes.get(id)?.deps ?? []) {
      if (parent.has(dep) || !graph.nodes.has(dep)) continue;
      parent.set(dep, id);
      queue.push(dep);
    }
  }
  return parent;
}

const label = (graph: LockGraph, id: string): string => {
  const node = graph.nodes.get(id);
  return node ? `${node.name}@${node.version}` : id;
};

/** Every locked package the predicate accepts, with how the project comes to have it. */
export function findOccurrences(
  graph: LockGraph,
  matches: (name: string, version: string) => boolean,
): PackageOccurrence[] {
  const hits = [...graph.nodes.values()].filter((node) => matches(node.name, node.version));
  if (hits.length === 0) return [];

  const prod = reach(
    graph,
    graph.roots.flatMap((root) => root.prod.map((id) => ({ id, workspace: root.workspace }))),
  );
  const dev = reach(
    graph,
    graph.roots.flatMap((root) => root.dev.map((id) => ({ id, workspace: root.workspace }))),
  );

  const dependentsOf = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    for (const dep of node.deps) {
      const list = dependentsOf.get(dep) ?? [];
      list.push(node.id);
      dependentsOf.set(dep, list);
    }
  }

  const chain = (parents: Map<string, string>, id: string): string[] => {
    const hops: string[] = [];
    let current: string | undefined = id;
    // The graph is finite and `parents` is a BFS tree, but bound the walk anyway.
    for (let guard = 0; current !== undefined && guard <= graph.nodes.size; guard += 1) {
      if (current.startsWith("workspace:") && !graph.nodes.has(current)) {
        hops.push(current.slice("workspace:".length));
        break;
      }
      hops.push(label(graph, current));
      current = parents.get(current);
    }
    return hops.toReversed();
  };

  const found: PackageOccurrence[] = [];
  for (const node of hits) {
    const scope = prod.has(node.id)
      ? "production"
      : dev.has(node.id)
        ? "development"
        : "unreferenced";
    const workspaces = graph.roots
      .filter((root) => root.prod.includes(node.id) || root.dev.includes(node.id))
      .map((root) => root.workspace);
    const occurrence: PackageOccurrence = {
      name: node.name,
      version: node.version,
      nodeId: node.id,
      direct: workspaces.length > 0,
      scope,
      workspaces,
      via:
        scope === "production"
          ? chain(prod, node.id)
          : scope === "development"
            ? chain(dev, node.id)
            : [],
      dependents: (dependentsOf.get(node.id) ?? []).slice(0, 5).map((id) => label(graph, id)),
    };
    if (node.installScript) occurrence.installScript = true;
    else if (graph.recordsInstallScripts) occurrence.installScript = false;
    found.push(occurrence);
  }
  return found.toSorted(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      semver.compare(semver.coerce(a.version) ?? "0.0.0", semver.coerce(b.version) ?? "0.0.0"),
  );
}

/** Predicate for "this package, in this range" (prereleases count). */
export function inRange(
  packageName: string,
  range: string,
): (name: string, version: string) => boolean {
  return (name, version) =>
    name === packageName &&
    semver.valid(version) !== null &&
    semver.satisfies(version, range, { includePrerelease: true });
}

/** Every distinct locked version of a package. */
export function versionsOfPackage(graph: LockGraph, packageName: string): string[] {
  return [
    ...new Set(
      [...graph.nodes.values()]
        .filter((node) => node.name === packageName)
        .map((node) => node.version),
    ),
  ];
}
