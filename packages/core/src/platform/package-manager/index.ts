import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { memoryTestCommand } from "../memory/consume.js";
import { safeExeca } from "../safe-exec.js";
import type { PackageManager, RemediationConstraints } from "../types.js";
import { type InstalledVersions, parsePackageManagerListOutput } from "./list-parser.js";

export type { PackageManager };

export interface PackageManagerCommands {
  install: string[];
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
    const result = await safeExeca("yarn", ["--version"], { cwd, stdio: "pipe" });
    const major = Number.parseInt(result.stdout.trim().split(".")[0] ?? "1", 10);
    return Number.isNaN(major) ? 1 : major;
  } catch {
    return 1;
  }
}

/** The installed pnpm major version, or undefined when it cannot be determined. */
export async function getPnpmMajorVersion(cwd: string): Promise<number | undefined> {
  try {
    const result = await safeExeca("pnpm", ["--version"], { cwd, stdio: "pipe" });
    const major = Number.parseInt(result.stdout.trim().split(".")[0] ?? "", 10);
    return Number.isNaN(major) ? undefined : major;
  } catch {
    return undefined;
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
    const [executable, ...rest] = command;
    return executable === undefined ? command : [executable, "--filter", workspace, ...rest];
  }

  if (pm === "npm") {
    return [...command, "--workspace", workspace];
  }

  // Bun, Deno, and Yarn workspace command semantics differ by version; keep default behavior.
  return command;
}

/**
 * Install command to run after a manifest change.
 *
 * The lockfile has to be able to change here, so installs are not frozen unless the caller
 * explicitly sets `enforceFrozenLockfile`. Managers that freeze implicitly when `CI` is set
 * (pnpm, Yarn Berry) are told not to. `installMode` only controls cache usage: anything other
 * than "standard" prefers the offline cache.
 */
export function resolveInstallCommand(
  pm: PackageManager,
  constraints?: RemediationConstraints,
  yarnMajor?: number,
): string[] {
  const installMode = constraints?.installMode ?? "deterministic";
  const frozen = constraints?.enforceFrozenLockfile === true;
  const workspace = constraints?.workspace;

  if (pm === "bun") {
    return withWorkspace(
      ["bun", "install", ...(frozen ? ["--frozen-lockfile"] : [])],
      pm,
      workspace,
    );
  }

  if (pm === "deno") {
    const preferOffline = constraints?.installPreferOffline ?? installMode === "prefer-offline";
    const command = ["deno", "install"];
    if (frozen) command.push("--frozen");
    else if (preferOffline) command.push("--cache-only");
    return withWorkspace(command, pm, workspace);
  }

  const command = [pm, pm === "npm" && frozen ? "ci" : "install"];

  if (frozen) {
    if (pm === "pnpm") command.push("--frozen-lockfile");
    if (pm === "yarn") command.push((yarnMajor ?? 1) >= 2 ? "--immutable" : "--frozen-lockfile");
  } else if (pm === "pnpm") {
    command.push("--no-frozen-lockfile");
  } else if (pm === "yarn" && (yarnMajor ?? 1) >= 2) {
    command.push("--no-immutable");
  }

  const preferOffline = constraints?.installPreferOffline ?? installMode !== "standard";
  if (preferOffline && pm !== "yarn") command.push("--prefer-offline");

  return withWorkspace(command, pm, workspace);
}

export function resolveListCommand(
  pm: PackageManager,
  constraints?: RemediationConstraints,
): string[] {
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

/**
 * The command that runs a project's tests. With `cwd`, a project whose `package.json` has no test
 * script gets the test command its memory holds, if any (see `memoryTestCommand`); a script the
 * project defines is never overridden, and a workspace selection leaves the choice to the package
 * manager.
 */
export function resolveTestCommand(
  pm: PackageManager,
  constraints?: RemediationConstraints,
  cwd?: string,
): string[] {
  if (cwd !== undefined && !constraints?.workspace && pm !== "deno") {
    const remembered = memoryTestCommand(cwd, pm);
    if (remembered) return remembered;
  }
  const base =
    pm === "pnpm"
      ? ["pnpm", "test"]
      : pm === "yarn"
        ? ["yarn", "test"]
        : pm === "bun"
          ? ["bun", "test"]
          : pm === "deno"
            ? ["deno", "test"]
            : ["npm", "test"];
  return withWorkspace(base, pm, constraints?.workspace);
}

export function resolveTypecheckCommand(
  pm: PackageManager,
  constraints?: RemediationConstraints,
  cwd: string = process.cwd(),
): string[] {
  const pkgJsonPath = join(cwd, "package.json");
  let hasTypecheckScript = false;
  const hasTsConfig = existsSync(join(cwd, "tsconfig.json"));

  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.typecheck) {
        hasTypecheckScript = true;
      }
    } catch {
      // Ignore
    }
  }

  if (hasTypecheckScript) {
    const base = [pm, "run", "typecheck"];
    return withWorkspace(base, pm, constraints?.workspace);
  }

  if (hasTsConfig) {
    if (pm === "deno") {
      return withWorkspace(["deno", "check"], pm, constraints?.workspace);
    }
    const base = ["npx", "tsc", "--noEmit"];
    return withWorkspace(base, pm, constraints?.workspace);
  }

  return [];
}

export function resolveAuditCommand(
  pm: PackageManager,
  constraints?: RemediationConstraints,
): string[] {
  if (pm === "deno") {
    throw new Error(
      "Deno does not support a native audit command. Use --input with a SARIF or npm-audit scan file instead.",
    );
  }
  const base = pm === "yarn" ? ["yarn", "audit", "--json"] : [pm, "audit", "--json"];
  return withWorkspace(base, pm, constraints?.workspace);
}

export function resolveWhyCommand(
  pm: PackageManager,
  packageName: string,
  constraints?: RemediationConstraints,
): string[] {
  if (pm === "deno") return [];
  if (pm === "bun") {
    const base = ["bun", "pm", "why", packageName];
    return withWorkspace(base, pm, constraints?.workspace);
  }
  const base = pm === "npm" ? ["npm", "explain", packageName] : [pm, "why", packageName];
  return withWorkspace(base, pm, constraints?.workspace);
}

export function resolveDedupeCommand(
  pm: PackageManager,
  constraints?: RemediationConstraints,
): string[] {
  if (pm === "bun" || pm === "deno") return [];
  const base = [pm, "dedupe"];
  return withWorkspace(base, pm, constraints?.workspace);
}

export function getPackageManagerCommands(pm: PackageManager): PackageManagerCommands {
  if (pm === "pnpm") {
    return {
      install: ["pnpm", "install"],
      installDev: (pkg: string) => ["pnpm", "add", "-D", pkg],
      test: ["pnpm", "test"],
      list: ["pnpm", "list", "--json", "--depth", "99"],
      lockfileName: "pnpm-lock.yaml",
    };
  }

  if (pm === "yarn") {
    return {
      install: ["yarn", "install"],
      installDev: (pkg: string) => ["yarn", "add", "--dev", pkg],
      test: ["yarn", "test"],
      list: ["yarn", "list", "--json"],
      lockfileName: "yarn.lock",
    };
  }

  if (pm === "bun") {
    return {
      install: ["bun", "install"],
      installDev: (pkg: string) => ["bun", "add", "-d", pkg],
      test: ["bun", "test"],
      list: ["bun", "pm", "ls", "--all"],
      lockfileName: "bun.lockb",
    };
  }

  if (pm === "deno") {
    return {
      install: ["deno", "install"],
      installDev: (pkg: string) => ["deno", "add", pkg],
      test: ["deno", "test"],
      list: [],
      lockfileName: "deno.lock",
    };
  }

  return {
    install: ["npm", "install"],
    installDev: (pkg: string) => ["npm", "install", "--save-dev", pkg],
    test: ["npm", "test"],
    list: ["npm", "list", "--json", "--all"],
    lockfileName: "package-lock.json",
  };
}

export function parseListOutput(pm: PackageManager, stdout: string): InstalledVersions {
  return parsePackageManagerListOutput(pm, stdout);
}
