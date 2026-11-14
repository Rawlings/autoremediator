import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { HttpError } from "./http-utils.js";

/** Option names that carry filesystem paths supplied by the caller. */
const PATH_KEYS = new Set([
  "cwd",
  "path",
  "inputPath",
  "patchFilePath",
  "patchesDir",
  "manifestFilePath",
  "manifestPath",
  "evidenceFile",
  "suppressionsFile",
  "reproductionTestPath",
  "intelligenceSnapshotPath",
  "policy",
]);

const MAX_DEPTH = 12;

/** Resolve symlinks for the deepest existing ancestor so not-yet-created paths are still checked. */
function realOrResolve(target: string): string {
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
 * Directories the HTTP server may read from and write to on behalf of callers.
 * Defaults to the server's working directory; override with AUTOREMEDIATOR_ALLOWED_ROOTS
 * (comma-separated absolute paths).
 */
export function getAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.AUTOREMEDIATOR_ALLOWED_ROOTS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const roots = configured && configured.length > 0 ? configured : [process.cwd()];
  return roots.map((root) => realOrResolve(resolve(root)));
}

/**
 * Throws a 403 HttpError when any path-valued field in a request body points outside the
 * allowed roots. Relative paths resolve against the request's own `cwd` when present.
 */
export function assertPathsConfined(
  body: unknown,
  roots: string[] = getAllowedRoots(),
  base: string = process.cwd(),
  depth = 0,
): void {
  if (depth > MAX_DEPTH || typeof body !== "object" || body === null) return;

  if (Array.isArray(body)) {
    for (const entry of body) assertPathsConfined(entry, roots, base, depth + 1);
    return;
  }

  const record = body as Record<string, unknown>;
  const ownBase =
    typeof record.cwd === "string" && record.cwd.length > 0 ? resolve(base, record.cwd) : base;

  for (const [key, value] of Object.entries(record)) {
    if (PATH_KEYS.has(key) && typeof value === "string" && value.length > 0) {
      const full = realOrResolve(resolve(key === "cwd" ? base : ownBase, value));
      if (!roots.some((root) => isInside(root, full))) {
        throw new HttpError(
          403,
          `Path not allowed for "${key}": outside the server's allowed roots`,
        );
      }
    } else if (typeof value === "object" && value !== null) {
      assertPathsConfined(value, roots, ownBase, depth + 1);
    }
  }
}
