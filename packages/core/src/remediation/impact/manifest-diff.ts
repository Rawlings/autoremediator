/**
 * Package-level changes between two versions of a package that can break a consumer regardless of
 * which functions it calls: the supported Node range, the module format, the `exports` map and
 * required peer dependencies.
 */
import semver from "semver";

import { exportsMapOf, moduleFormat } from "./package-index.js";
import type { ChangeSeverity } from "./api-diff.js";

export interface PackageLevelChange {
  category: "engines" | "module-format" | "exports-map" | "peer-dependency";
  severity: ChangeSeverity;
  reason: string;
  before?: string;
  after?: string;
  /**
   * `project-conflict`: the project's own manifest proves it cannot satisfy the new requirement.
   * `unresolved`: the change is real but depends on facts about the project we do not have.
   */
  evidence: "project-conflict" | "unresolved";
  /** `exports` subpaths present before and gone now (for intersecting with deep imports). */
  removedSubpaths?: string[];
  /** The package now has an `exports` map and the old one did not: deep imports are restricted. */
  restrictsDeepImports?: boolean;
  /** Matters only to code that `require()`s the package. */
  affectsRequire?: boolean;
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function enginesNode(manifest: Record<string, unknown>): string | undefined {
  const engines = manifest.engines;
  if (typeof engines !== "object" || engines === null) return undefined;
  const node = (engines as Record<string, unknown>).node;
  return typeof node === "string" ? node : undefined;
}

function validRange(range: string | undefined): string | undefined {
  if (range === undefined) return undefined;
  try {
    return semver.validRange(range) ?? undefined;
  } catch {
    return undefined;
  }
}

function safeSubset(sub: string, dom: string): boolean | undefined {
  try {
    return semver.subset(sub, dom);
  } catch {
    return undefined;
  }
}

function safeIntersects(a: string, b: string): boolean | undefined {
  try {
    return semver.intersects(a, b);
  } catch {
    return undefined;
  }
}

/** Whether `subpath` (`./lib/x`) is exposed by the package's `exports` map. */
export function isSubpathExported(manifest: Record<string, unknown>, subpath: string): boolean {
  const map = exportsMapOf(manifest);
  if (!map) return true;
  const candidates = new Set([subpath, subpath.replace(/\.[cm]?js$/, "")]);
  for (const key of map.keys()) {
    if (candidates.has(key)) return true;
    const star = key.indexOf("*");
    if (star !== -1) {
      const before = key.slice(0, star);
      const after = key.slice(star + 1);
      for (const candidate of candidates) {
        if (candidate.startsWith(before) && candidate.endsWith(after) && candidate.length > before.length + after.length) return true;
      }
    }
  }
  return false;
}

export function comparePackageManifests(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  project: Record<string, unknown> | undefined,
  runtimeNode: string = process.version,
): PackageLevelChange[] {
  const changes: PackageLevelChange[] = [];

  // Node range
  const oldNode = enginesNode(before);
  const newNode = enginesNode(after);
  if (newNode !== undefined && newNode !== oldNode) {
    const oldRange = validRange(oldNode ?? "*");
    const newRange = validRange(newNode);
    const narrowed = oldRange && newRange ? safeSubset(oldRange, newRange) === false : undefined;
    if (narrowed !== false) {
      const projectNode = project ? enginesNode(project) : undefined;
      const projectRange = validRange(projectNode);
      const conflict = projectRange && newRange ? safeSubset(projectRange, newRange) === false : false;
      const runtimeOk = newRange ? semver.satisfies(runtimeNode, newRange) : undefined;
      // The project's own declared range already fits inside the new one: nothing to flag.
      const projectFits = projectRange !== undefined && !conflict;
      if (!projectFits) {
        changes.push({
        category: "engines",
        severity: conflict ? "breaking" : "possibly-breaking",
        reason: conflict
          ? `engines.node narrowed to "${newNode}" and the project declares engines.node "${projectNode}", which allows versions outside it`
          : `engines.node ${oldNode === undefined ? "was unset and is now" : `changed from "${oldNode}" to`} "${newNode}"${projectNode ? "" : "; the project declares no engines.node"}${runtimeOk === undefined ? "" : runtimeOk ? `; Node ${runtimeNode} on this machine satisfies it` : `; Node ${runtimeNode} on this machine does NOT satisfy it`}`,
        before: oldNode,
        after: newNode,
        evidence: conflict ? "project-conflict" : "unresolved",
        });
      }
    }
  }

  // Module format
  const oldFormat = moduleFormat(before);
  const newFormat = moduleFormat(after);
  if (oldFormat !== newFormat) {
    if (newFormat === "esm-only") {
      changes.push({
        category: "module-format",
        severity: "possibly-breaking",
        reason: `package is now ESM-only (was ${oldFormat}): require() of it fails on Node before 20.19/22.12 and when it uses top-level await`,
        before: oldFormat,
        after: newFormat,
        evidence: "unresolved",
        affectsRequire: true,
      });
    } else if (newFormat === "cjs-only" && oldFormat !== "cjs-only") {
      changes.push({
        category: "module-format",
        severity: "possibly-breaking",
        reason: `package is now CommonJS-only (was ${oldFormat}): named ESM imports of it may no longer resolve`,
        before: oldFormat,
        after: newFormat,
        evidence: "unresolved",
      });
    }
  }

  // exports map
  const oldMap = exportsMapOf(before);
  const newMap = exportsMapOf(after);
  if (newMap && !oldMap) {
    changes.push({
      category: "exports-map",
      severity: "possibly-breaking",
      reason: `package now has an "exports" map: deep imports not listed in it (${[...newMap.keys()].slice(0, 6).join(", ")}${newMap.size > 6 ? ", ..." : ""}) stop working`,
      after: [...newMap.keys()].join(", "),
      evidence: "unresolved",
      restrictsDeepImports: true,
    });
  } else if (newMap && oldMap) {
    const removed = [...oldMap.keys()].filter((key) => !newMap.has(key) && !key.includes("*"));
    if (removed.length > 0) {
      changes.push({
        category: "exports-map",
        severity: "breaking",
        reason: `"exports" no longer lists ${removed.slice(0, 6).join(", ")}${removed.length > 6 ? ", ..." : ""}`,
        before: removed.join(", "),
        evidence: "unresolved",
        removedSubpaths: removed,
      });
    }
  }

  // Peer dependencies
  const oldPeers = stringRecord(before.peerDependencies);
  const newPeers = stringRecord(after.peerDependencies);
  const newMeta = (typeof after.peerDependenciesMeta === "object" && after.peerDependenciesMeta !== null ? after.peerDependenciesMeta : {}) as Record<string, { optional?: boolean } | undefined>;
  const projectDeps = project
    ? { ...stringRecord(project.peerDependencies), ...stringRecord(project.devDependencies), ...stringRecord(project.dependencies) }
    : {};
  for (const [peer, range] of Object.entries(newPeers).toSorted((a, b) => a[0].localeCompare(b[0]))) {
    if (newMeta[peer]?.optional === true) continue;
    const previous = oldPeers[peer];
    const projectRange = projectDeps[peer];
    const validNew = validRange(range);
    if (previous === undefined) {
      if (projectRange === undefined) {
        changes.push({
          category: "peer-dependency",
          severity: "possibly-breaking",
          reason: `new required peer dependency ${peer}@${range}${project ? ", which the project does not declare" : ""}`,
          after: `${peer}@${range}`,
          evidence: "unresolved",
        });
      } else if (validNew && validRange(projectRange) && safeIntersects(projectRange, validNew) === false) {
        changes.push({
          category: "peer-dependency",
          severity: "breaking",
          reason: `new required peer dependency ${peer}@${range} conflicts with the project's ${peer}@${projectRange}`,
          after: `${peer}@${range}`,
          evidence: "project-conflict",
        });
      }
    } else if (previous !== range) {
      const validOld = validRange(previous);
      const narrowed = validOld && validNew ? safeSubset(validOld, validNew) === false : false;
      if (!narrowed) continue;
      if (projectRange !== undefined && validRange(projectRange) && safeIntersects(projectRange, validNew ?? "*") === false) {
        changes.push({
          category: "peer-dependency",
          severity: "breaking",
          reason: `peer dependency ${peer} narrowed from ${previous} to ${range}, which the project's ${peer}@${projectRange} does not satisfy`,
          before: `${peer}@${previous}`,
          after: `${peer}@${range}`,
          evidence: "project-conflict",
        });
      } else {
        changes.push({
          category: "peer-dependency",
          severity: "possibly-breaking",
          reason: `peer dependency ${peer} narrowed from ${previous} to ${range}`,
          before: `${peer}@${previous}`,
          after: `${peer}@${range}`,
          evidence: "unresolved",
        });
      }
    }
  }
  return changes;
}
