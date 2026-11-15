/**
 * A lockfile read as a dependency graph: which package versions are locked, who depends on whom,
 * and which of them the project's manifests ask for. Built from the text of the lockfile alone, so
 * it works on a checkout without `node_modules` and on a lockfile read from git history.
 */
export type LockFormat = "npm" | "pnpm" | "yarn" | "bun";

export interface LockNode {
  /** Unique within the graph. */
  id: string;
  name: string;
  version: string;
  /** Ids of the nodes this one depends on. */
  deps: string[];
  /** The lockfile says installing this package runs scripts (npm `hasInstallScript`, pnpm `requiresBuild`). */
  installScript?: boolean;
}

/** The dependencies one workspace (the project itself, or a workspace package) asks for. */
export interface LockRoot {
  /** `.` for the project itself, else the workspace path or name. */
  workspace: string;
  /** Node ids of dependencies and optional dependencies. */
  prod: string[];
  /** Node ids of devDependencies. */
  dev: string[];
}

export interface LockGraph {
  format: LockFormat;
  nodes: Map<string, LockNode>;
  roots: LockRoot[];
  /** The format marks every package whose install runs scripts, so a node without the flag does not. */
  recordsInstallScripts: boolean;
}

/** The parts of `package.json` the graph needs when the lockfile does not record them. */
export interface ManifestDeps {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export const LOCKFILE_NAMES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
] as const;

export function lockFormatOf(path: string): LockFormat | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json") return "npm";
  if (name === "pnpm-lock.yaml") return "pnpm";
  if (name === "yarn.lock") return "yarn";
  if (name === "bun.lock") return "bun";
  return undefined;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** String-valued entries of an object; anything else is dropped. */
export function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}
