import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";

import { sha256 } from "../../../shared/hash.js";
import { DEFAULT_VEX_FILE, resolveVexField } from "../index.js";

export type PackageJsonEdit = { content: string; vexPath: string } | { conflict: string };

function detectIndent(text: string): string {
  return /^( +|\t)"/m.exec(text)?.[1] ?? "  ";
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${source}$`);
}

/** Would npm pack include `path` given the `files` list? Directories include everything under them. */
export function filesCover(files: readonly unknown[], path: string): boolean {
  for (const entry of files) {
    if (typeof entry !== "string") continue;
    const normalized = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    if (normalized === "" || normalized.startsWith("!")) continue;
    if (normalized === path || path.startsWith(`${normalized}/`)) return true;
    if (
      /[*?]/.test(normalized) &&
      (globToRegExp(normalized).test(path) || globToRegExp(`${normalized}/**`).test(path))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Declare the VEX file in `package.json` (`vex`) and make sure it ships (`files`). Keeps the
 * author's key order and indentation, never changes a valid `vex` they already declared, and
 * refuses a file it cannot parse or a `vex`/`files` that is not what npm expects.
 */
export function editPackageJson(
  existing: string,
  defaultPath: string = DEFAULT_VEX_FILE,
): PackageJsonEdit {
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { conflict: "is not a JSON object, so it was left alone" };
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    return { conflict: "is not valid JSON, so it was left alone" };
  }

  let vexPath = defaultPath;
  const declared = Object.hasOwn(manifest, "vex");
  if (declared) {
    const field = resolveVexField(manifest["vex"]);
    if ("error" in field) return { conflict: `${field.error}, so it was left alone` };
    vexPath = field.path;
  }
  const files = manifest["files"];
  if (files !== undefined && !Array.isArray(files)) {
    return { conflict: 'has a "files" that is not a list, so it was left alone' };
  }
  const needsFiles = Array.isArray(files) && !filesCover(files, vexPath);
  if (declared && !needsFiles) return { content: existing, vexPath };

  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(manifest)) {
    entries.push([key, key === "files" && needsFiles ? [...(value as unknown[]), vexPath] : value]);
    if (key === "files" && !declared) entries.push(["vex", vexPath]);
  }
  if (!declared && !entries.some(([key]) => key === "vex")) entries.push(["vex", vexPath]);
  const trailing = existing.endsWith("\n") ? "\n" : "";
  return {
    content: `${JSON.stringify(Object.fromEntries(entries), null, detectIndent(existing))}${trailing}`,
    vexPath,
  };
}

const BUMP_RANK = { patch: 1, minor: 2, major: 3 } as const;
type Bump = keyof typeof BUMP_RANK;

/** The highest bump the pending changesets ask for this package; undefined when there are none. */
export function pendingBump(cwd: string, packageName: string): Bump | undefined {
  const directory = join(cwd, ".changeset");
  let names: string[];
  try {
    // Changesets that `maintain` itself wrote are patches by construction and say nothing about the author's plans.
    names = readdirSync(directory).filter(
      (name) =>
        name.endsWith(".md") && name.toLowerCase() !== "readme.md" && !name.startsWith("maintain-"),
    );
  } catch {
    return undefined;
  }
  let highest: Bump | undefined;
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(directory, name), "utf8");
    } catch {
      continue;
    }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (!front) continue;
    for (const line of front.split(/\r?\n/)) {
      const match = /^\s*["']?([^"':]+)["']?\s*:\s*["']?(major|minor|patch)["']?\s*$/.exec(line);
      if (match?.[1] === packageName) {
        const bump = match[2] as Bump;
        if (highest === undefined || BUMP_RANK[bump] > BUMP_RANK[highest]) highest = bump;
      }
    }
  }
  return highest;
}

export interface NextVersion {
  version?: string;
  note?: string;
}

/**
 * The version the next release will carry, which the VEX document must name because consumers only
 * use statements about the exact version they install. With changesets that is the current version
 * plus the highest pending bump (at least a patch, which `maintain` adds); without, the next patch.
 */
export function nextVersionOf(
  cwd: string,
  packageName: string,
  current: string,
  override: string | undefined,
  usesChangesets: boolean,
): NextVersion {
  if (override !== undefined) {
    if (semver.valid(override) !== override) {
      throw new Error(`nextVersion "${override}" is not an exact semantic version.`);
    }
    return { version: override };
  }
  if (existsSync(join(cwd, ".changeset", "pre.json"))) {
    return {
      note: "Changesets is in pre-release mode, so the next version cannot be predicted: pass --next-version to write the OpenVEX statements.",
    };
  }
  const pending = usesChangesets ? pendingBump(cwd, packageName) : undefined;
  const bump: Bump = pending ?? "patch";
  const version = semver.inc(current, bump);
  if (!version)
    return { note: `Cannot compute the next version from ${current}; pass --next-version.` };
  const why = pending
    ? `a ${pending} bump is already pending in .changeset`
    : `a patch after ${current}`;
  return {
    version,
    note: `Next release assumed to be ${version} (${why}); pass --next-version if that is wrong.`,
  };
}

/** Deterministic changeset file name for a set of advisories, so running again updates the same file. */
export function changesetName(advisories: readonly string[]): string {
  const ids = advisories.toSorted().map((id) => id.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"));
  const readable = ids.length <= 2 ? ids.join("-and-") : `${ids[0]}-and-${ids.length - 1}-more`;
  const digest = sha256(ids.join(",")).slice(0, 6);
  return `maintain-${readable}-${digest}`.slice(0, 80);
}

export function renderChangeset(packageName: string, lines: readonly string[]): string {
  return `---\n"${packageName}": patch\n---\n\n${lines.join("\n")}\n`;
}
