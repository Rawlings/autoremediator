import semver from "semver";

import type { LockEdge, LockGraph } from "./lockfile.js";
import type {
  DuplicatePackage,
  DuplicateParent,
  DuplicatesReport,
  DuplicateVerdict,
  DuplicateVersion,
} from "./types.js";

const usableRange = (range: string | undefined): range is string =>
  range !== undefined && semver.validRange(range) !== null;

const highest = (versions: readonly string[]): string | undefined =>
  versions.toSorted((left, right) => semver.rcompare(left, right))[0];

function parentOf(graph: LockGraph, edge: LockEdge): DuplicateParent {
  if (edge.fromDirect)
    return { name: edge.from, ...(edge.range ? { range: edge.range } : {}), direct: true };
  const node = graph.nodes.get(edge.from);
  return {
    name: node?.name ?? edge.from,
    ...(node ? { version: node.version } : {}),
    ...(edge.range ? { range: edge.range } : {}),
    direct: false,
  };
}

/** Does every range admit `version`? */
const acceptedBy = (version: string, ranges: readonly string[]): boolean =>
  ranges.every((range) => semver.satisfies(version, range));

export function analyzeDuplicates(graph: LockGraph): DuplicatesReport {
  const byName = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    const versions = byName.get(node.name) ?? [];
    versions.push(node.version);
    byName.set(node.name, versions);
  }
  const requirers = new Map<string, LockEdge[]>();
  for (const edge of graph.edges) {
    const list = requirers.get(edge.to) ?? [];
    list.push(edge);
    requirers.set(edge.to, list);
  }

  const packages: DuplicatePackage[] = [];
  for (const [name, versions] of byName) {
    if (versions.length < 2) continue;
    const sorted = versions.toSorted((left, right) =>
      semver.valid(left) && semver.valid(right)
        ? semver.rcompare(left, right)
        : right.localeCompare(left),
    );

    const entries: DuplicateVersion[] = sorted.map((version) => {
      const edges = requirers.get(`${name}@${version}`) ?? [];
      const parents = edges
        .map((edge) => parentOf(graph, edge))
        .toSorted(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            (left.version ?? "").localeCompare(right.version ?? ""),
        );
      const ranges: (string | undefined)[] = edges.map((edge) => edge.range);
      let movableTo: string | undefined;
      if (edges.length > 0 && ranges.every((range) => usableRange(range))) {
        // A dedupe moves a copy up to a newer one its parents already accept, never down.
        movableTo = highest(
          sorted.filter(
            (other) =>
              semver.valid(other) &&
              semver.valid(version) &&
              semver.gt(other, version) &&
              acceptedBy(other, ranges),
          ),
        );
      }
      return { version, parents, ...(movableTo ? { movableTo } : {}) };
    });

    const allEdges = sorted.flatMap((version) => requirers.get(`${name}@${version}`) ?? []);
    const allRanges = allEdges.map((edge) => edge.range);
    const rangesKnown = allEdges.length > 0 && allRanges.every((range) => usableRange(range));
    const unified = rangesKnown
      ? highest(sorted.filter((version) => semver.valid(version) && acceptedBy(version, allRanges)))
      : undefined;

    let verdict: DuplicateVerdict;
    let summary: string;
    const moved = entries.filter((entry) => entry.movableTo);
    if (!rangesKnown) {
      verdict = "unknown-ranges";
      summary = `${sorted.length} versions; the ranges its parents ask for are not on record (install dependencies so they can be read), so a dedupe cannot be judged`;
    } else if (unified) {
      verdict = "dedupe-within-range";
      summary = `${sorted.length} versions, but every parent accepts ${unified}: a dedupe or an override to it stays within every range`;
    } else if (moved.length > 0) {
      verdict = "partly-dedupable";
      summary = `${sorted.length} versions; ${moved.length} can move to a version their parents already accept, the rest are held by a parent whose range excludes the others`;
    } else {
      verdict = "needs-override-or-upgrade";
      summary = `${sorted.length} versions, and each is held by a parent whose range excludes the others: collapsing them needs an override that leaves a parent's range, or upgrading the parent`;
    }
    packages.push({
      name,
      versions: entries,
      verdict,
      ...(unified ? { unifiedVersion: unified } : {}),
      summary,
    });
  }

  packages.sort(
    (left, right) =>
      right.versions.length - left.versions.length || left.name.localeCompare(right.name),
  );
  return {
    supported: true,
    packages,
    extraCopies: packages.reduce((total, entry) => total + entry.versions.length - 1, 0),
  };
}

/** Shortest distance from the project to each installed package, in dependency hops. */
export function dependencyDepths(graph: LockGraph): {
  maxDepth: number;
  directDependencies: number;
} {
  const children = new Map<string, string[]>();
  const direct = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.fromDirect) direct.add(edge.to);
    else children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  }
  const depth = new Map<string, number>();
  let frontier = [...direct];
  for (const id of frontier) depth.set(id, 1);
  let maxDepth = frontier.length > 0 ? 1 : 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of children.get(id) ?? []) {
        if (depth.has(child)) continue;
        const level = (depth.get(id) ?? 0) + 1;
        depth.set(child, level);
        maxDepth = Math.max(maxDepth, level);
        next.push(child);
      }
    }
    frontier = next;
  }
  return { maxDepth, directDependencies: direct.size };
}
