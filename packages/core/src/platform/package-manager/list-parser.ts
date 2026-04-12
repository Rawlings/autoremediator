import type { PackageManager } from "./index.js";

export function parsePackageManagerListOutput(pm: PackageManager, stdout: string): Map<string, string> {
  const versions = new Map<string, string>();

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