import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageManager } from "./index.js";

export function parsePackageManagerListOutput(pm: PackageManager, stdout: string): Map<string, string> {
  const versions = new Map<string, string>();

  if (pm === "bun") {
    return parseBunListOutput(stdout, versions);
  }

  if (!stdout.trim()) return versions;

  if (pm === "yarn") {
    return parseYarnListOutput(stdout, versions);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return versions;
  }

  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  collectDependencyTree(
    (root as { dependencies?: Record<string, DependencyTree> } | undefined)?.dependencies,
    versions
  );

  return versions;
}

type DependencyTree = {
  version?: string;
  dependencies?: Record<string, DependencyTree>;
};

function parseYarnListOutput(stdout: string, versions: Map<string, string>): Map<string, string> {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type?: string; data?: { trees?: Array<{ name?: string }> } };
      if (obj.type !== "tree") continue;

      for (const tree of obj.data?.trees ?? []) {
        const raw = tree.name ?? "";
        const at = raw.lastIndexOf("@");
        if (at <= 0) continue;

        const name = raw.slice(0, at);
        const version = raw.slice(at + 1);
        if (name && version) {
          versions.set(name, version);
        }
      }
    } catch {
      // Ignore non-json lines from yarn output.
    }
  }

  return versions;
}

function collectDependencyTree(
  tree: Record<string, DependencyTree> | undefined,
  versions: Map<string, string>
): void {
  if (!tree) return;

  for (const [name, entry] of Object.entries(tree)) {
    if (!entry || typeof entry !== "object") continue;
    const version = entry.version;
    if (typeof version === "string" && version) {
      versions.set(name, version);
    }
    collectDependencyTree(entry.dependencies, versions);
  }
}

/**
 * Parse `bun pm ls --all` text output.
 * Each dependency line ends with `name@version`; leading tree-drawing characters
 * (├──, └──, │, spaces) are stripped before splitting on the last `@`.
 */
function parseBunListOutput(stdout: string, versions: Map<string, string>): Map<string, string> {
  const lines = stdout
    .split("\n")
    .map((line) => line.replace(/^[\s│├└─]+/, "").trim())
    .filter(Boolean);

  for (const line of lines) {
    const at = line.lastIndexOf("@");
    if (at <= 0) continue;
    const name = line.slice(0, at);
    const version = line.slice(at + 1);
    if (name && version) {
      versions.set(name, version);
    }
  }

  return versions;
}

/**
 * Read `deno.lock` JSON from disk and extract installed npm package versions.
 * Supports both deno.lock v3 (packages.npm map) and v4 (packages object with npm: prefix keys).
 */
export function resolveDenoInventory(cwd: string): Map<string, string> {
  const versions = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(join(cwd, "deno.lock"), "utf8");
  } catch {
    return versions;
  }

  let lock: unknown;
  try {
    lock = JSON.parse(raw);
  } catch {
    return versions;
  }

  if (!lock || typeof lock !== "object") return versions;
  const lockObj = lock as Record<string, unknown>;

  // deno.lock v3: { version: "3", packages: { npm: { "pkg@version": ... } } }
  const packages = lockObj["packages"];
  if (packages && typeof packages === "object") {
    const pkgsObj = packages as Record<string, unknown>;

    // v3 format: packages.npm keys are "name@version"
    const npmMap = pkgsObj["npm"];
    if (npmMap && typeof npmMap === "object") {
      for (const key of Object.keys(npmMap as object)) {
        extractNameVersion(key, versions);
      }
      return versions;
    }

    // v4 format: packages keys may be "npm:name@version"
    for (const key of Object.keys(pkgsObj)) {
      const stripped = key.startsWith("npm:") ? key.slice(4) : key;
      extractNameVersion(stripped, versions);
    }
  }

  return versions;
}

function extractNameVersion(spec: string, versions: Map<string, string>): void {
  // Handle scoped packages: "@scope/name@version" — lastIndexOf('@') after index 0
  const at = spec.lastIndexOf("@");
  if (at <= 0) return;
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (name && version) {
    versions.set(name, version);
  }
}