import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RemediationConstraints } from "./types.js";

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface PackageManagerCommands {
  install: string[];
  installPreferOffline: string[];
  installDeterministic: string[];
  installDev: (pkg: string) => string[];
  test: string[];
  list: string[];
  lockfileName: string;
}

export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function addFlag(command: string[], flag: string): string[] {
  if (command.includes(flag)) return command;
  return [...command, flag];
}

export function resolveInstallCommand(
  pm: PackageManager,
  constraints?: RemediationConstraints
): string[] {
  const installMode = constraints?.installMode ?? "deterministic";
  const preferOfflineOverride = constraints?.installPreferOffline;
  const frozenOverride = constraints?.enforceFrozenLockfile;

  const includePreferOffline =
    pm !== "yarn" && (preferOfflineOverride ?? installMode !== "standard");

  let includeFrozenLockfile =
    pm !== "npm" && (frozenOverride ?? installMode === "deterministic");

  if (frozenOverride === false) {
    includeFrozenLockfile = false;
  }

  const useNpmCi =
    pm === "npm" &&
    (frozenOverride === true || (frozenOverride === undefined && installMode === "deterministic"));

  const command: string[] = [
    pm,
    pm === "npm" ? (useNpmCi ? "ci" : "install") : "install",
  ];

  if (includeFrozenLockfile) {
    command.push("--frozen-lockfile");
  }

  if (includePreferOffline) {
    command.push("--prefer-offline");
  }

  return command;
}

export function getPackageManagerCommands(pm: PackageManager): PackageManagerCommands {
  if (pm === "pnpm") {
    return {
      install: ["pnpm", "install"],
      installPreferOffline: ["pnpm", "install", "--prefer-offline"],
      installDeterministic: resolveInstallCommand("pnpm", { installMode: "deterministic" }),
      installDev: (pkg: string) => ["pnpm", "add", "-D", pkg],
      test: ["pnpm", "test"],
      list: ["pnpm", "list", "--json", "--depth", "99"],
      lockfileName: "pnpm-lock.yaml",
    };
  }

  if (pm === "yarn") {
    return {
      install: ["yarn", "install"],
      installPreferOffline: ["yarn", "install"],
      installDeterministic: resolveInstallCommand("yarn", { installMode: "deterministic" }),
      installDev: (pkg: string) => ["yarn", "add", "--dev", pkg],
      test: ["yarn", "test"],
      list: ["yarn", "list", "--json"],
      lockfileName: "yarn.lock",
    };
  }

  return {
    install: ["npm", "install"],
    installPreferOffline: ["npm", "install", "--prefer-offline"],
    installDeterministic: resolveInstallCommand("npm", { installMode: "deterministic" }),
    installDev: (pkg: string) => ["npm", "install", "--save-dev", pkg],
    test: ["npm", "test"],
    list: ["npm", "list", "--json", "--all"],
    lockfileName: "package-lock.json",
  };
}

export function parseListOutput(pm: PackageManager, stdout: string): Map<string, string> {
  const versions = new Map<string, string>();

  if (!stdout.trim()) return versions;

  if (pm === "yarn") {
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return versions;
  }

  const root = Array.isArray(parsed) ? parsed[0] : parsed;

  type DependencyTree = {
    version?: string;
    dependencies?: Record<string, DependencyTree>;
  };

  function collectDependencies(tree?: Record<string, DependencyTree>): void {
    if (!tree) return;

    for (const [name, entry] of Object.entries(tree)) {
      if (!entry || typeof entry !== "object") continue;
      const version = entry.version;
      if (typeof version === "string" && version) {
        versions.set(name, version);
      }
      collectDependencies(entry.dependencies);
    }
  }

  collectDependencies((root as { dependencies?: Record<string, DependencyTree> } | undefined)?.dependencies);

  return versions;
}