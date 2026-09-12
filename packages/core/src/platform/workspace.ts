import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import yaml from "yaml";

export interface WorkspacePackage {
  name: string;
  relativeDir: string;
  absoluteDir: string;
  manifestPath: string;
  manifest: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    [key: string]: unknown;
  };
}

/**
 * Finds the workspace root directory by walking up from startDir until
 * pnpm-workspace.yaml or package.json with workspaces is found.
 */
export function findWorkspaceRoot(startDir: string): string | null {
  let curr = resolve(startDir);
  while (true) {
    if (existsSync(join(curr, "pnpm-workspace.yaml"))) return curr;
    const pkgPath = join(curr, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
        if (parsed.workspaces) return curr;
      } catch {
        // Ignore JSON error
      }
    }
    const parent = resolve(curr, "..");
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

/**
 * Discovers all workspace package directories and parses their manifests.
 */
export function findWorkspacePackages(cwd: string): WorkspacePackage[] {
  const rootCwd = findWorkspaceRoot(cwd) ?? resolve(cwd);
  const packages: WorkspacePackage[] = [];
  const packageGlobs: string[] = [];

  // 1. Check pnpm-workspace.yaml
  const pnpmWorkspaceFile = join(rootCwd, "pnpm-workspace.yaml");
  if (existsSync(pnpmWorkspaceFile)) {
    try {
      const content = readFileSync(pnpmWorkspaceFile, "utf8");
      const parsed = yaml.parse(content) as { packages?: string[] } | null;
      if (Array.isArray(parsed?.packages)) {
        packageGlobs.push(...parsed.packages);
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 2. Check root package.json workspaces
  const rootPkgFile = join(rootCwd, "package.json");
  if (existsSync(rootPkgFile)) {
    try {
      const rootPkg = JSON.parse(readFileSync(rootPkgFile, "utf8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      if (Array.isArray(rootPkg.workspaces)) {
        packageGlobs.push(...rootPkg.workspaces);
      } else if (Array.isArray(rootPkg.workspaces?.packages)) {
        packageGlobs.push(...rootPkg.workspaces.packages);
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 3. Check deno.json workspace
  const denoJsonFile = join(rootCwd, "deno.json");
  if (existsSync(denoJsonFile)) {
    try {
      const denoJson = JSON.parse(readFileSync(denoJsonFile, "utf8")) as {
        workspace?: string[];
      };
      if (Array.isArray(denoJson.workspace)) {
        packageGlobs.push(...denoJson.workspace);
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (packageGlobs.length === 0) {
    return packages;
  }

  const seenDirs = new Set<string>();

  for (const glob of packageGlobs) {
    const cleanGlob = glob.trim().replace(/\/+$/, "");
    if (!cleanGlob || cleanGlob.startsWith("!")) continue;

    if (cleanGlob.endsWith("/*")) {
      const parentDir = join(rootCwd, cleanGlob.slice(0, -2));
      if (!existsSync(parentDir)) continue;
      try {
        const entries = readdirSync(parentDir);
        for (const entry of entries) {
          if (entry.startsWith(".") || entry === "node_modules") continue;
          const subDir = join(parentDir, entry);
          try {
            if (statSync(subDir).isDirectory()) {
              addWorkspacePackage(rootCwd, subDir, packages, seenDirs);
            }
          } catch {
            // Ignore stat errors
          }
        }
      } catch {
        // Ignore readdir errors
      }
    } else {
      const directDir = join(rootCwd, cleanGlob);
      if (existsSync(directDir)) {
        try {
          if (statSync(directDir).isDirectory()) {
            addWorkspacePackage(rootCwd, directDir, packages, seenDirs);
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  return packages;
}

function addWorkspacePackage(
  rootCwd: string,
  dir: string,
  out: WorkspacePackage[],
  seen: Set<string>,
): void {
  const norm = resolve(dir);
  if (seen.has(norm)) return;
  seen.add(norm);

  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return;

  try {
    const content = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(content) as WorkspacePackage["manifest"];
    out.push({
      name: manifest.name ?? relative(rootCwd, dir),
      relativeDir: relative(rootCwd, dir),
      absoluteDir: norm,
      manifestPath,
      manifest,
    });
  } catch {
    // Ignore invalid manifests
  }
}

/**
 * Finds the workspace package that directly declares the given dependency name.
 * If `filterWorkspace` is provided, restricts search to that workspace.
 */
export function findDeclaringWorkspacePackage(
  cwd: string,
  dependencyName: string,
  filterWorkspace?: string,
): WorkspacePackage | null {
  const workspaces = findWorkspacePackages(cwd);
  if (workspaces.length === 0) return null;

  const matchesFilter = (wp: WorkspacePackage): boolean => {
    if (!filterWorkspace) return true;
    const filter = filterWorkspace.trim();
    return (
      wp.name === filter ||
      wp.relativeDir === filter ||
      wp.relativeDir.replace(/\\/g, "/") === filter.replace(/\\/g, "/")
    );
  };

  for (const wp of workspaces) {
    if (!matchesFilter(wp)) continue;
    const isDeclared =
      Boolean(wp.manifest.dependencies?.[dependencyName]) ||
      Boolean(wp.manifest.devDependencies?.[dependencyName]) ||
      Boolean(wp.manifest.peerDependencies?.[dependencyName]);

    if (isDeclared) {
      return wp;
    }
  }

  return null;
}
