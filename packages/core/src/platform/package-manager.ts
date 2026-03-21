import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface PackageManagerCommands {
  install: string[];
  installPreferOffline: string[];
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

export function getPackageManagerCommands(pm: PackageManager): PackageManagerCommands {
  if (pm === "pnpm") {
    return {
      install: ["pnpm", "install"],
      installPreferOffline: ["pnpm", "install", "--prefer-offline"],
      installDev: (pkg: string) => ["pnpm", "add", "-D", pkg],
      test: ["pnpm", "test"],
      list: ["pnpm", "list", "--json", "--depth=0"],
      lockfileName: "pnpm-lock.yaml",
    };
  }

  if (pm === "yarn") {
    return {
      install: ["yarn", "install"],
      installPreferOffline: ["yarn", "install"],
      installDev: (pkg: string) => ["yarn", "add", "--dev", pkg],
      test: ["yarn", "test"],
      list: ["yarn", "list", "--json", "--depth=0"],
      lockfileName: "yarn.lock",
    };
  }

  return {
    install: ["npm", "install"],
    installPreferOffline: ["npm", "install", "--prefer-offline"],
    installDev: (pkg: string) => ["npm", "install", "--save-dev", pkg],
    test: ["npm", "test"],
    list: ["npm", "list", "--json", "--depth=0"],
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
  const dependencies = (root as { dependencies?: Record<string, { version?: string }> } | undefined)
    ?.dependencies;

  for (const [name, entry] of Object.entries(dependencies ?? {})) {
    const version = entry?.version;
    if (typeof version === "string" && version) {
      versions.set(name, version);
    }
  }

  return versions;
}