/**
 * Confines the filesystem paths a remote caller supplies (MCP, HTTP) to allowed roots.
 *
 * Which fields are paths is declared once, in the operation schemas, with the `x-path` JSON Schema
 * keyword (see `pathField` in `option-schemas.ts`); this module walks an input alongside that
 * schema, so a new path option is guarded the moment it is tagged.
 */
import { realpathSync } from "node:fs";
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

  constructor(field: string) {
    super(`Path not allowed for "${field}": outside the allowed roots`);
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

/**
 * Throws `PathNotAllowedError` when any path-valued field of `input` points outside `roots`.
/** Fields that take either a path or inline content, and what inline content looks like for each. */
function isInlineContent(key: string, value: string): boolean {
  if (key === "policy") return /^\s*(\{|---)/.test(value);
  return key === "reproductionTest";
}

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
      if (value.includes("\n")) {
        // Only fields that accept inline content may carry a newline, and only when it reads as
        // content. Anywhere else a newline hides a `..` segment from the check but not from the
        // file system, so it is refused.
        if (isInlineContent(key, value)) continue;
        throw new PathNotAllowedError(key);
      }
      // Inline YAML or JSON in `policy` is content, not a path.
      if (key === "policy" && /^\s*(\{|---)/.test(value)) continue;
      const absolute = resolve(key === "cwd" ? base : ownBase, value);
      const full = realOrResolve(absolute);
      if (!roots.some((root) => isInside(root, full))) throw new PathNotAllowedError(key);
      // `reproductionTest` is a path or a short inline script; the value is left as given.
      if (key !== "reproductionTest") out[key] = absolute;
    } else if (typeof value === "object" && value !== null) {
      out[key] = confinePaths(child, value, roots, ownBase, depth + 1);
    }
  }
  return out as T;
}
