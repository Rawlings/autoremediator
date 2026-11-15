import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  findOccurrences,
  LOCKFILE_NAMES,
  parseLockGraph,
  type LockGraph,
  type ManifestDeps,
  type PackageOccurrence,
} from "../scan/lock-graph/index.js";
import type { Occurrence } from "./types.js";

const MAX_LOCKFILE_BYTES = 200 * 1024 * 1024;

export interface ProjectLock {
  /** File name, relative to the project directory. */
  path: string;
  graph: LockGraph;
}

export interface ProjectLocks {
  manifest: (ManifestDeps & { scripts?: Record<string, unknown> }) | undefined;
  locks: ProjectLock[];
  notes: string[];
}

/** Read `package.json` and every lockfile at the root of `cwd`; unreadable ones become notes, not errors. */
export function loadProjectLocks(cwd: string): ProjectLocks {
  const notes: string[] = [];
  let manifest: ProjectLocks["manifest"];
  try {
    manifest = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as ProjectLocks["manifest"];
  } catch {
    notes.push(
      "package.json could not be read; direct and development dependencies cannot be told apart for yarn and bun lockfiles.",
    );
  }

  const locks: ProjectLock[] = [];
  for (const name of LOCKFILE_NAMES) {
    const path = join(cwd, name);
    let size: number;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (size > MAX_LOCKFILE_BYTES) {
      notes.push(`${name} is larger than ${MAX_LOCKFILE_BYTES / 1024 / 1024} MB and was not read.`);
      continue;
    }
    try {
      const graph = parseLockGraph(name, readFileSync(path, "utf8"), manifest);
      if (graph) locks.push({ path: name, graph });
    } catch (error) {
      notes.push(
        `${name} could not be parsed (${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}); it is not included.`,
      );
    }
  }
  if (existsSync(join(cwd, "bun.lockb"))) {
    notes.push(
      "bun.lockb (the binary bun lockfile) cannot be read. Run `bun install --save-text-lockfile` to produce a bun.lock this tool can analyse.",
    );
  }
  if (locks.length === 0 && notes.length === 0) {
    notes.push(
      "No lockfile was found in the project directory, so what is locked could not be read. Commit the lockfile, or check node_modules.",
    );
  }
  return { manifest, locks, notes };
}

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/** `package.json` of an installed copy, from npm's or pnpm's layout, when it is exactly this version. */
function installedManifest(
  cwd: string,
  name: string,
  version: string,
): Record<string, unknown> | undefined {
  // The name may come from a lockfile; it must not be able to walk out of node_modules.
  if (!PACKAGE_NAME.test(name) || /[\\/]/.test(version)) return undefined;
  const candidates = [
    join(cwd, "node_modules", name, "package.json"),
    join(
      cwd,
      "node_modules",
      ".pnpm",
      `${name.replace("/", "+")}@${version}`,
      "node_modules",
      name,
      "package.json",
    ),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      if (parsed["version"] === version) return parsed;
    } catch {
      // Not installed there; try the next layout.
    }
  }
  return undefined;
}

/**
 * Does installing this version run scripts? The lockfile says when its format records it; else the
 * installed copy's own `package.json` (an install script, or a `binding.gyp` that npm builds
 * implicitly); else it is not known.
 */
export function installScriptOf(
  cwd: string,
  name: string,
  version: string,
  fromLock: boolean | undefined,
): boolean | "unknown" {
  if (fromLock === true) return true;
  const manifest = installedManifest(cwd, name, version);
  if (manifest) {
    const scripts =
      typeof manifest["scripts"] === "object" && manifest["scripts"] !== null
        ? (manifest["scripts"] as Record<string, unknown>)
        : {};
    if (["preinstall", "install", "postinstall"].some((hook) => typeof scripts[hook] === "string"))
      return true;
    if (manifest["gypfile"] === true || existsSync(join(cwd, "node_modules", name, "binding.gyp")))
      return true;
    return false;
  }
  return fromLock ?? "unknown";
}

export function declaredRange(
  manifest: ProjectLocks["manifest"],
  name: string,
): string | undefined {
  return (
    manifest?.dependencies?.[name] ??
    manifest?.devDependencies?.[name] ??
    manifest?.optionalDependencies?.[name]
  );
}

/** Occurrences of the packages `matches` accepts, over every lockfile of the project. */
export function occurrencesIn(
  cwd: string,
  locks: ProjectLock[],
  matches: (name: string, version: string) => boolean,
): Array<Occurrence & { name: string }> {
  return locks.flatMap(({ path, graph }) =>
    findOccurrences(graph, matches).map((found: PackageOccurrence) => ({
      name: found.name,
      version: found.version,
      lockfile: path,
      direct: found.direct,
      scope: found.scope,
      workspaces: found.workspaces,
      via: found.via,
      dependents: found.dependents,
      installScript: installScriptOf(cwd, found.name, found.version, found.installScript),
    })),
  );
}
