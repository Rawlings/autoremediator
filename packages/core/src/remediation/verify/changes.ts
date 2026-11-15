import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { parseGitPorcelainLine, parsePorcelainLines } from "../../platform/rollback.js";
import { safeExeca } from "../../platform/safe-exec.js";

/** Files that a dependency change legitimately rewrites. */
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
]);

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

export type PathClass = "manifest" | "lockfile" | "patch" | "install-state" | "source" | "forbidden" | "other";

/** Which kind of file a changed path is. Forbidden paths are never acceptable to change. */
export function classifyPath(path: string): PathClass {
  const normal = path.replaceAll("\\", "/");
  const name = basename(normal);

  if (normal.startsWith(".git/") || normal.includes("/.git/")) return "forbidden";
  if (normal.startsWith("node_modules/") || normal.includes("/node_modules/")) return "forbidden";
  if (normal.startsWith(".github/workflows/")) return "forbidden";
  if (/^\.github\/autoremediator\.ya?ml$/.test(normal)) return "forbidden";
  if (normal.startsWith(".autoremediator/")) return "forbidden";

  if (name === "package.json" || name === "deno.json" || name === "deno.jsonc") return "manifest";
  if (LOCKFILES.has(name)) return "lockfile";
  if (normal.endsWith(".patch")) return "patch";
  if (normal.startsWith(".yarn/") || /^\.pnp\.[cm]?js$/.test(name)) return "install-state";
  if (SOURCE_EXTENSIONS.test(name)) return "source";
  return "other";
}

/** Paths that changed since `statusBefore`, from `git status`. Undefined outside a git repository. */
export async function changedFilesSince(
  cwd: string,
  statusBefore: readonly string[] | undefined,
  /** Paths (relative to `cwd`) to leave out, such as bookkeeping the tool itself writes. */
  ignore: readonly string[] = [],
): Promise<string[] | undefined> {
  if (statusBefore === undefined) return undefined;
  let stdout: string;
  let root: string;
  try {
    stdout = (await safeExeca("git", ["status", "--porcelain=v1", "-uall"], { cwd, stdio: "pipe" }))
      .stdout;
    root = (await safeExeca("git", ["rev-parse", "--show-prefix"], { cwd, stdio: "pipe" })).stdout.trim();
  } catch {
    return undefined;
  }

  const before = new Set(statusBefore);
  const paths: string[] = [];
  for (const line of parsePorcelainLines(stdout)) {
    if (before.has(line)) continue;
    const parsed = parseGitPorcelainLine(line);
    if (!parsed) continue;
    // Porcelain paths are relative to the repository root; report them relative to `cwd`.
    paths.push(root && parsed.filePath.startsWith(root) ? parsed.filePath.slice(root.length) : parsed.filePath);
  }
  return paths.filter((path) => !ignore.includes(path)).toSorted();
}

// ---------------------------------------------------------------------------
// Dependency declarations
// ---------------------------------------------------------------------------

export type DeclarationKind = "dependency" | "override";

export interface Declaration {
  kind: DeclarationKind;
  /** Package name, extracted from override selectors such as `parent>child` or `child@<2`. */
  name: string;
  spec: string;
}

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** `parent>child`, `child@<2.0.0` and `@scope/child@1` all name `child`. */
export function overrideTarget(selector: string): string {
  const last = selector.split(">").at(-1)?.trim() ?? selector;
  const at = last.lastIndexOf("@");
  return at > 0 ? last.slice(0, at) : last;
}

function addOverrides(into: Declaration[], overrides: unknown): void {
  if (!overrides || typeof overrides !== "object") return;
  for (const [selector, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof value === "string") {
      into.push({ kind: "override", name: overrideTarget(selector), spec: `${selector}=${value}` });
    } else if (value && typeof value === "object") {
      // npm nests overrides: { parent: { child: "1.0.0" } }
      for (const [child, nested] of Object.entries(value as Record<string, unknown>)) {
        if (typeof nested === "string") {
          into.push({ kind: "override", name: overrideTarget(child), spec: `${selector}>${child}=${nested}` });
        }
      }
    }
  }
}

/** Every dependency and override a manifest declares, as comparable entries. */
export function readDeclarations(manifestText: string | null): Declaration[] {
  if (manifestText === null) return [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestText) as Record<string, unknown>;
  } catch {
    return [];
  }
  const declarations: Declaration[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = manifest[section];
    if (!entries || typeof entries !== "object") continue;
    for (const [name, spec] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof spec === "string") declarations.push({ kind: "dependency", name, spec });
    }
  }
  addOverrides(declarations, manifest["overrides"]);
  addOverrides(declarations, manifest["resolutions"]);
  addOverrides(declarations, (manifest["pnpm"] as { overrides?: unknown } | undefined)?.overrides);
  return declarations;
}

export interface DeclarationChange {
  kind: DeclarationKind;
  name: string;
  /** Undefined when newly declared. */
  from?: string;
  /** Undefined when removed. */
  to?: string;
  file: string;
}

/** What identifies a declaration across versions of a manifest: its name, and for overrides its selector. */
const keyOf = (declaration: Declaration) =>
  declaration.kind === "override"
    ? `override\0${declaration.name}\0${declaration.spec.split("=")[0]}`
    : `dependency\0${declaration.name}`;
const valueOf = (declaration: Declaration) =>
  declaration.kind === "override" && declaration.spec.includes("=")
    ? declaration.spec.slice(declaration.spec.indexOf("=") + 1)
    : declaration.spec;

/** What changed between two manifests' declarations. */
export function diffDeclarations(file: string, before: string | null, after: string | null): DeclarationChange[] {
  const previous = new Map(readDeclarations(before).map((declaration) => [keyOf(declaration), declaration]));
  const current = new Map(readDeclarations(after).map((declaration) => [keyOf(declaration), declaration]));
  const changes: DeclarationChange[] = [];

  for (const [key, declaration] of current) {
    const old = previous.get(key);
    if (old === undefined) {
      changes.push({ kind: declaration.kind, name: declaration.name, to: valueOf(declaration), file });
    } else if (valueOf(old) !== valueOf(declaration)) {
      changes.push({ kind: declaration.kind, name: declaration.name, from: valueOf(old), to: valueOf(declaration), file });
    }
  }
  for (const [key, declaration] of previous) {
    if (!current.has(key)) {
      changes.push({ kind: declaration.kind, name: declaration.name, from: valueOf(declaration), file });
    }
  }
  return changes;
}

/** Declaration changes across every manifest the base snapshot knows, against the files now on disk. */
export function manifestChanges(
  cwd: string,
  baseFiles: ReadonlyMap<string, string | null>,
): DeclarationChange[] {
  const changes: DeclarationChange[] = [];
  for (const [file, before] of baseFiles) {
    if (classifyPath(file) !== "manifest" || basename(file) !== "package.json") continue;
    const path = join(cwd, file);
    const after = existsSync(path) ? readFileSync(path, "latin1") : null;
    if (after === before) continue;
    changes.push(...diffDeclarations(file, before, after));
  }
  return changes;
}
