import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import semver from "semver";

import { type OpenVexDocument, type OpenVexStatement, parseOpenVex } from "./openvex.js";
import { isValidPackageName, parseNpmPurl } from "./purl.js";

/** The conventional file name, used when `package.json#vex` is `true`. */
export const DEFAULT_VEX_FILE = "vex.openvex.json";

const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGES = 100_000;
const MAX_PATH_LENGTH = 200;

/** A statement that is about the package that shipped it, reduced to what matching needs. */
export interface ShippedStatement {
  statement: OpenVexStatement;
  /** Subcomponents of the matching product; undefined when the product lists none. */
  subcomponents: Array<{ name: string; version?: string }> | undefined;
}

export interface ShippedVexDocument {
  package: { name: string; version: string };
  /** Path inside the package, as declared and validated. */
  file: string;
  /** Directory of the package that ships it (where it sits under `node_modules`). */
  dir: string;
  document: OpenVexDocument;
  /** Statements whose product is exactly this package at this version. The rest are dropped. */
  statements: ShippedStatement[];
}

export interface VexRejection {
  package: string;
  version?: string;
  path?: string;
  reason: string;
}

export interface MaintainerVexIndex {
  /** Packages found under `node_modules`. */
  scanned: number;
  documents: ShippedVexDocument[];
  rejected: VexRejection[];
  /** Installed versions per package name. */
  versions: Map<string, Set<string>>;
  /** Runtime dependency names per package name (any installed version of it). */
  edges: Map<string, Set<string>>;
  notes: string[];
}

/**
 * Validate a `package.json#vex` value. `true` means the default file. A path must stay inside the
 * package: relative, no `..`, no drive or URL, a `.json` file.
 */
export function resolveVexField(value: unknown): { path: string } | { error: string } {
  if (value === true) return { path: DEFAULT_VEX_FILE };
  if (typeof value !== "string" || value.trim() === "") {
    return { error: 'package.json "vex" must be a relative path or true' };
  }
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.length > MAX_PATH_LENGTH || path.includes("\0")) {
    return { error: 'package.json "vex" is not a usable path' };
  }
  if (isAbsolute(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/")) {
    return { error: 'package.json "vex" must be a path inside the package, not absolute or a URL' };
  }
  if (path.split("/").some((part) => part === ".." || part === "" || part === ".")) {
    return { error: 'package.json "vex" must not contain ".." or empty path segments' };
  }
  if (!path.endsWith(".json")) return { error: 'package.json "vex" must name a .json file' };
  return { path };
}

function readJsonObject(path: string, maxBytes: number): Record<string, unknown> | undefined {
  try {
    if (statSync(path).size > maxBytes) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function dependencyNames(manifest: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const value = manifest[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    for (const name of Object.keys(value)) if (isValidPackageName(name)) names.add(name);
  }
  return [...names];
}

/**
 * Read a document a package declares, safely: the file must be a regular file whose real path stays
 * inside the package's real directory (a symlink out is refused), and no larger than the size cap.
 */
export function readVexFile(
  packageDir: string,
  declared: string,
): { content: string } | { error: string } {
  let realDir: string;
  let realFile: string;
  try {
    realDir = realpathSync(packageDir);
    realFile = realpathSync(join(packageDir, declared));
  } catch {
    return { error: "is declared but the file does not exist" };
  }
  if (realFile !== realDir && !realFile.startsWith(realDir + sep)) {
    return { error: "resolves outside the package" };
  }
  const stat = lstatSync(realFile);
  if (!stat.isFile()) return { error: "is not a regular file" };
  if (stat.size > 1024 * 1024) return { error: "is larger than 1024 KiB" };
  try {
    return { content: readFileSync(realFile, "utf8") };
  } catch {
    return { error: "could not be read" };
  }
}

/**
 * Keep only the statements about this very package at this very version. The product must be a
 * purl that names the installed `name@version`; a document shipped in one version cannot vouch
 * for another.
 */
export function statementsFor(
  document: OpenVexDocument,
  pkg: { name: string; version: string },
): ShippedStatement[] {
  const kept: ShippedStatement[] = [];
  for (const statement of document.statements) {
    for (const product of statement.products) {
      const purl = parseNpmPurl(product.identifiers?.purl) ?? parseNpmPurl(product["@id"]);
      if (!purl || purl.name !== pkg.name || purl.version !== pkg.version) continue;
      let subcomponents: ShippedStatement["subcomponents"];
      if (product.subcomponents !== undefined) {
        subcomponents = [];
        for (const sub of product.subcomponents) {
          const parsed = parseNpmPurl(sub.identifiers?.purl) ?? parseNpmPurl(sub["@id"]);
          if (parsed) subcomponents.push(parsed);
        }
        // Subcomponents were listed but none is an npm package we can name: the statement is
        // about something else, and must not be read as a claim about the package as a whole.
        if (subcomponents.length === 0) continue;
      }
      kept.push({ statement, subcomponents });
      break;
    }
  }
  return kept;
}

interface Walk {
  seen: Set<string>;
  packages: number;
  truncated: boolean;
}

function* packageDirs(nodeModules: string, walk: Walk): Generator<string> {
  const pending = [nodeModules];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let names: string[];
    try {
      names = readdirSync(current).toSorted();
    } catch {
      continue;
    }
    const candidates: string[] = [];
    for (const name of names) {
      if (name === ".bin") continue;
      if (name === ".pnpm") {
        let stores: string[] = [];
        try {
          stores = readdirSync(join(current, ".pnpm")).toSorted();
        } catch {
          // No pnpm store here.
        }
        for (const store of stores) pending.push(join(current, ".pnpm", store, "node_modules"));
        continue;
      }
      if (name.startsWith(".")) continue;
      if (name.startsWith("@")) {
        try {
          for (const inner of readdirSync(join(current, name)).toSorted()) {
            candidates.push(join(current, name, inner));
          }
        } catch {
          // Not a readable scope directory.
        }
        continue;
      }
      candidates.push(join(current, name));
    }
    for (const candidate of candidates) {
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (walk.seen.has(real)) continue;
      walk.seen.add(real);
      if (walk.packages >= MAX_PACKAGES) {
        walk.truncated = true;
        return;
      }
      walk.packages += 1;
      yield real;
      const nested = join(real, "node_modules");
      if (existsSync(nested)) pending.push(nested);
    }
  }
}

/**
 * Read every OpenVEX document that installed packages ship, as declared by `package.json#vex`.
 * Everything found is untrusted: a package that cannot be read or whose document is invalid is
 * recorded under `rejected` with the reason, and never stops the scan.
 */
export function readInstalledMaintainerVex(cwd: string): MaintainerVexIndex {
  const index: MaintainerVexIndex = {
    scanned: 0,
    documents: [],
    rejected: [],
    versions: new Map(),
    edges: new Map(),
    notes: [],
  };
  const nodeModules = join(cwd, "node_modules");
  if (!existsSync(nodeModules)) {
    index.notes.push(
      "No node_modules directory: install dependencies to read the VEX documents they ship.",
    );
    return index;
  }

  const walk: Walk = { seen: new Set(), packages: 0, truncated: false };
  for (const dir of packageDirs(nodeModules, walk)) {
    const manifest = readJsonObject(join(dir, "package.json"), MAX_PACKAGE_JSON_BYTES);
    if (!manifest) continue;
    const name = manifest["name"];
    const version = manifest["version"];
    if (
      !isValidPackageName(name) ||
      typeof version !== "string" ||
      semver.valid(version) !== version
    ) {
      continue;
    }
    index.scanned += 1;
    if (!index.versions.has(name)) index.versions.set(name, new Set());
    index.versions.get(name)!.add(version);
    const edges = index.edges.get(name) ?? new Set<string>();
    for (const dependency of dependencyNames(manifest)) edges.add(dependency);
    index.edges.set(name, edges);

    if (!Object.hasOwn(manifest, "vex")) continue;
    const reject = (reason: string, path?: string) =>
      index.rejected.push({ package: name, version, ...(path ? { path } : {}), reason });

    const field = resolveVexField(manifest["vex"]);
    if ("error" in field) {
      reject(field.error);
      continue;
    }
    const file = readVexFile(dir, field.path);
    if ("error" in file) {
      reject(`${field.path} ${file.error}`, field.path);
      continue;
    }
    const parsed = parseOpenVex(file.content);
    if ("error" in parsed) {
      reject(`${field.path} ${parsed.error}`, field.path);
      continue;
    }
    const statements = statementsFor(parsed.document, { name, version });
    if (statements.length === 0) {
      reject(
        `${field.path} has no statement about ${name}@${version} (a document only speaks for the exact version it ships in)`,
        field.path,
      );
      continue;
    }
    index.documents.push({
      package: { name, version },
      file: field.path,
      dir,
      document: parsed.document,
      statements,
    });
  }
  if (walk.truncated) {
    index.notes.push(`Stopped after ${MAX_PACKAGES} packages; later ones were not read.`);
  }
  return index;
}

/** Does `from` depend, directly or through installed packages, on `target` (by name)? */
export function dependsOn(index: MaintainerVexIndex, from: string, target: string): boolean {
  const visited = new Set<string>([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of index.edges.get(queue[head]!) ?? []) {
      if (next === target) return true;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
