import { parseLockfileDependencies } from "../../scanner/lockfile-diff.js";
import type { BisectedPackage, BisectSkippedChange } from "./types.js";

export interface LockfileChanges {
  /** Packages with exactly one locked version on each side, and the two differ. */
  updates: BisectedPackage[];
  skipped: BisectSkippedChange[];
}

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export interface ManifestLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Names the project itself depends on (not peers: they are not installed from the root). */
export function directDependencyNames(manifest: ManifestLike | undefined): Set<string> {
  const names = new Set<string>();
  for (const section of SECTIONS) {
    for (const name of Object.keys(manifest?.[section] ?? {})) names.add(name);
  }
  return names;
}

/**
 * Which locked packages changed between two lockfiles, as the pairs that can be tried one at a
 * time. A package that is added, removed, or present in several versions cannot be pinned back
 * and forth by name, so it is listed under `skipped` with the reason instead of being guessed at.
 */
export function lockfileChanges(
  lockfileName: string,
  goodContent: string,
  badContent: string,
  direct: ReadonlySet<string>,
): LockfileChanges {
  const before = parseLockfileDependencies(lockfileName, goodContent);
  const after = parseLockfileDependencies(lockfileName, badContent);
  const updates: BisectedPackage[] = [];
  const skipped: BisectSkippedChange[] = [];

  for (const name of [...new Set([...before.keys(), ...after.keys()])].toSorted()) {
    const was = [...(before.get(name) ?? [])].toSorted();
    const now = [...(after.get(name) ?? [])].toSorted();
    if (was.length === now.length && was.every((version, index) => version === now[index])) continue;

    const [from] = was;
    const [to] = now;
    if (was.length === 1 && now.length === 1 && from !== undefined && to !== undefined) {
      updates.push({
        packageName: name,
        fromVersion: from,
        toVersion: to,
        dependencyScope: direct.has(name) ? "direct" : "transitive",
      });
      continue;
    }

    const reason =
      was.length === 0
        ? "added at the bad ref"
        : now.length === 0
          ? "removed at the bad ref"
          : "several versions are locked, so a single pin cannot stand for it";
    skipped.push({ packageName: name, fromVersions: was, toVersions: now, reason });
  }
  return { updates, skipped };
}
