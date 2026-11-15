/**
 * Confines the filesystem paths a remote caller supplies (MCP, HTTP) to allowed roots.
 *
 * Which fields are paths is declared once, in the operation schemas, with the `x-path` JSON Schema
 * keyword (see `pathField` in `option-schemas.ts`); this module walks an input alongside that
 * schema, so a new path option is guarded the moment it is tagged.
 */
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const PATH_KEYWORD = "x-path";

/** The slice of JSON Schema the guard understands. */
export interface PathGuardSchema {
  type?: string | string[];
  properties?: Record<string, PathGuardSchema>;
  items?: PathGuardSchema;
  [PATH_KEYWORD]?: boolean;
}

export class PathNotAllowedError extends Error {
  readonly field: string;

  constructor(field: string, reason = "outside the allowed roots") {
    super(`Path not allowed for "${field}": ${reason}`);
    this.name = "PathNotAllowedError";
    this.field = field;
  }
}

const MAX_DEPTH = 12;

/** Resolve symlinks for the deepest existing ancestor so not-yet-created paths are still checked. */
export function realOrResolve(target: string): string {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.toReversed());
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      tail.push(basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Directories remote callers may read from and write to. `AUTOREMEDIATOR_ALLOWED_ROOTS`
 * (comma-separated absolute paths) wins; otherwise the working directory plus any `extraRoots`
 * (for MCP, the roots the client declared).
 */
export function getAllowedRoots(
  env: NodeJS.ProcessEnv = process.env,
  extraRoots: readonly string[] = [],
): string[] {
  const configured = env["AUTOREMEDIATOR_ALLOWED_ROOTS"]
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const roots = configured && configured.length > 0 ? configured : [process.cwd(), ...extraRoots];
  return roots.map((root) => realOrResolve(resolve(root)));
}

const INLINE_POLICY = /^\s*(\{|---)/;

/** A path to an existing regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Throws `PathNotAllowedError` when any path-valued field of `input` points outside `roots`.
 */
export function assertPathsConfined(
  schema: PathGuardSchema,
  input: unknown,
  roots: string[] = getAllowedRoots(),
  base: string = process.cwd(),
): void {
  confinePaths(schema, input, roots, base);
}

/**
 * Like `assertPathsConfined`, and returns the input with every confined path replaced by the absolute
 * path that was checked. Handlers resolve relative paths against the process directory, the guard
 * against the sibling `cwd`; passing the checked absolute path on closes the gap between the two, so
 * what is used is exactly what was allowed.
 */
export function confinePaths<T>(
  schema: PathGuardSchema,
  input: T,
  roots: string[] = getAllowedRoots(),
  base: string = process.cwd(),
  depth = 0,
): T {
  if (depth > MAX_DEPTH || typeof input !== "object" || input === null) return input;

  if (Array.isArray(input)) {
    if (!schema.items) return input;
    const items = schema.items;
    return input.map((entry) => confinePaths(items, entry, roots, base, depth + 1)) as T;
  }

  const record = input as Record<string, unknown>;
  const ownBase =
    typeof record["cwd"] === "string" && record["cwd"].length > 0
      ? resolve(base, record["cwd"])
      : base;

  const out: Record<string, unknown> = { ...record };
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const value = record[key];
    if (child[PATH_KEYWORD] && typeof value === "string" && value.length > 0) {
      // Content is never accepted from a remote caller. An inline reproduction test is code that
      // would run on this machine, and an inline policy replaces the project's own. A newline in
      // any path hides a `..` segment from the check but not from the file system.
      if (key === "policy" && INLINE_POLICY.test(value)) {
        throw new PathNotAllowedError(
          key,
          "inline policy is not accepted from a remote caller; pass the path of a policy file",
        );
      }
      if (value.includes("\n")) {
        throw new PathNotAllowedError(
          key,
          key === "reproductionTest"
            ? "inline scripts are not accepted from a remote caller; pass the path of an existing file"
            : "a path cannot contain a newline",
        );
      }
      const absolute = resolve(key === "cwd" ? base : ownBase, value);
      const full = realOrResolve(absolute);
      if (!roots.some((root) => isInside(root, full))) throw new PathNotAllowedError(key);
      if (key === "reproductionTest" && !isFile(full)) {
        throw new PathNotAllowedError(
          key,
          "must be the path of an existing file inside the allowed roots; inline scripts are not accepted from a remote caller",
        );
      }
      out[key] = absolute;
    } else if (typeof value === "object" && value !== null) {
      out[key] = confinePaths(child, value, roots, ownBase, depth + 1);
    }
  }
  return out as T;
}
