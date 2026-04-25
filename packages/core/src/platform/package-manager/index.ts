import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { PackageManager, RemediationConstraints } from "../types.js";
import { parsePackageManagerListOutput } from "./list-parser.js";

export type { PackageManager };

export interface PackageManagerCommands {
  install: string[];
  installPreferOffline: string[];
  installDeterministic: string[];
  installDev: (pkg: string) => string[];
  test: string[];
  list: string[];
  lockfileName: string;
}

/**
 * Detect the installed yarn major version by running `yarn --version`.
 * Returns 1 for classic yarn (1.x), or the actual major for berry (2+).
 * Falls back to 1 when the version cannot be determined.
 */
export async function getYarnMajorVersion(cwd: string): Promise<number> {
  try {
    const result = await execa("yarn", ["--version"], { cwd, stdio: "pipe" });
    const major = Number.parseInt(result.stdout.trim().split(".")[0] ?? "1", 10);
    return Number.isNaN(major) ? 1 : major;
  } catch {
    return 1;
  }
}

export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  if (existsSync(join(cwd, "deno.lock"))) return "deno";
  return "npm";
}

function withWorkspace(command: string[], pm: PackageManager, workspace?: string): string[] {
  if (!workspace) return command;

  if (pm === "pnpm") {
    // pnpm expects filters before the subcommand: pnpm --filter <selector> install
    return [command[0], "--filter", workspace, ...command.slice(1)];
  }

  if (pm === "npm") {
    return [...command, "--workspace", workspace];
  }

  // Bun, Deno, and Yarn workspace command semantics differ by version; keep default behavior.
  return command;
}

export function resolveInstallCommand(
  pm: PackageManager,
  constraints?: RemediationConstraints,
  yarnMajor?: number
): string[] {
  const installMode = constraints?.installMode ?? "deterministic";
  const preferOfflineOverride = constraints?.installPreferOffline;
  const frozenOverride = constraints?.enforceFrozenLockfile;

  // Bun: frozen-lockfile flag
  if (pm === "bun") {
    const frozen = frozenOverride ?? installMode === "deterministic";
    const command = ["bun", "install"];
    if (frozen) command.push("--frozen-lockfile");
    return withWorkspace(command, pm, constraints?.workspace);
  }

  // Deno: --frozen flag; approximate prefer-offline with --cache-only
  if (pm === "deno") {
    const frozen = frozenOverride ?? installMode === "deterministic";
    const preferOffline = preferOfflineOverride ?? installMode === "prefer-offline";
    const command = ["deno", "install"];
    if (frozen) command.push("--frozen");
    if (preferOffline && !frozen) command.push("--cache-only");
    return withWorkspace(command, pm, constraints?.workspace);
  }

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
    // Yarn Berry (v2+) uses --immutable instead of --frozen-lockfile
    const isYarnBerry = pm === "yarn" && (yarnMajor ?? 1) >= 2;
    command.push(isYarnBerry ? "--immutable" : "--frozen-lockfile");
  }

  if (includePreferOffline) {
    command.push("--prefer-offline");
  }

  return withWorkspace(command, pm, constraints?.workspace);
}

export function resolveListCommand(pm: PackageManager, constraints?: RemediationConstraints): string[] {
  if (pm === "deno") {
    // Deno inventory is built by reading deno.lock directly, not via a shell command.
    // Callers that receive an empty array should use resolveDenoInventory() instead.
    return [];
  }

  const base =
    pm === "pnpm"
      ? ["pnpm", "list", "--json", "--depth", "99"]
      : pm === "yarn"
        ? ["yarn", "list", "--json"]
        : pm === "bun"
          ? ["bun", "pm", "ls", "--all"]
          : ["npm", "list", "--json", "--all"];

  return withWorkspace(base, pm, constraints?.workspace);
}

export function resolveTestCommand(pm: PackageManager, constraints?: RemediationConstraints): string[] {
  const base =
    pm === "pnpm" ? ["pnpm", "test"] :
    pm === "yarn" ? ["yarn", "test"] :
    pm === "bun" ? ["bun", "test"] :
    pm === "deno" ? ["deno", "test"] :
    ["npm", "test"];
  return withWorkspace(base, pm, constraints?.workspace);
}

export function resolveAuditCommand(pm: PackageManager, constraints?: RemediationConstraints): string[] {
  if (pm === "deno") {
    throw new Error(
      'Deno does not support a native audit command. Use --input with a SARIF or npm-audit scan file instead.'
    );
  }
  const base = pm === "yarn" ? ["yarn", "audit", "--json"] : [pm, "audit", "--json"];
  return withWorkspace(base, pm, constraints?.workspace);
}

export function resolveWhyCommand(
  pm: PackageManager,
  packageName: string,
  constraints?: RemediationConstraints
): string[] {
  if (pm === "deno") return [];
  if (pm === "bun") {
    const base = ["bun", "pm", "why", packageName];
    return withWorkspace(base, pm, constraints?.workspace);
  }
  const base = pm === "npm" ? ["npm", "explain", packageName] : [pm, "why", packageName];
  return withWorkspace(base, pm, constraints?.workspace);
}

export function resolveDedupeCommand(pm: PackageManager, constraints?: RemediationConstraints): string[] {
  if (pm === "bun" || pm === "deno") return [];
  const base = [pm, "dedupe"];
  return withWorkspace(base, pm, constraints?.workspace);
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

  if (pm === "bun") {
    return {
      install: ["bun", "install"],
      installPreferOffline: ["bun", "install"],
      installDeterministic: resolveInstallCommand("bun", { installMode: "deterministic" }),
      installDev: (pkg: string) => ["bun", "add", "-d", pkg],
      test: ["bun", "test"],
      list: ["bun", "pm", "ls", "--all"],
      lockfileName: "bun.lockb",
    };
  }

  if (pm === "deno") {
    return {
      install: ["deno", "install"],
      installPreferOffline: ["deno", "install", "--cache-only"],
      installDeterministic: resolveInstallCommand("deno", { installMode: "deterministic" }),
      installDev: (pkg: string) => ["deno", "add", pkg],
      test: ["deno", "test"],
      list: [],
      lockfileName: "deno.lock",
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
  return parsePackageManagerListOutput(pm, stdout);
}