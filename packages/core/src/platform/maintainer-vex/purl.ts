import semver from "semver";

/** An npm package URL (`pkg:npm/...`) reduced to what matching needs. */
export interface NpmPurl {
  name: string;
  /** Absent when the purl names the package without a version. */
  version?: string;
}

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

export function isValidPackageName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 214 && PACKAGE_NAME.test(name);
}

/**
 * Parse an npm purl. Deliberately strict: anything with qualifiers, a subpath, another ecosystem, a
 * name that is not a valid npm package name or a version that is not exact semver is not a match,
 * because a loose parse is how a document ends up vouching for a package it was not written about.
 */
export function parseNpmPurl(value: unknown): NpmPurl | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  if (!value.startsWith("pkg:npm/")) return undefined;
  if (/[?#\s]/.test(value)) return undefined;
  // The purl specification encodes a scope's `@` as `%40`; plain `@scope/name` is common and equivalent.
  let rest = value.slice("pkg:npm/".length);
  if (rest.startsWith("%40")) rest = `@${rest.slice(3)}`;
  const at = rest.lastIndexOf("@");
  const rawName = at > 0 ? rest.slice(0, at) : rest;
  const rawVersion = at > 0 ? rest.slice(at + 1) : undefined;
  const name = rawName.toLowerCase();
  if (!isValidPackageName(name)) return undefined;
  if (rawVersion === undefined) return { name };
  let version: string;
  try {
    version = decodeURIComponent(rawVersion);
  } catch {
    return undefined;
  }
  if (semver.valid(version) !== version) return undefined;
  return { name, version };
}

/** The purl for a package, with the scope's `@` encoded as the purl specification asks. */
export function npmPurl(name: string, version?: string): string {
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return version === undefined ? `pkg:npm/${encoded}` : `pkg:npm/${encoded}@${version}`;
}
