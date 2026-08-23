import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PackageManager, RemediationConstraints } from "../types.js";

export type Ecosystem = "npm";

export interface PackageManagerDriver {
  id: PackageManager;
  ecosystem: Ecosystem;
  lockfileName: string;
  detect(cwd: string): boolean;
  resolveInstallCommand(constraints?: RemediationConstraints, yarnMajor?: number): string[];
  resolveTestCommand(constraints?: RemediationConstraints): string[];
  resolveAuditCommand(options?: { workspace?: string }): string[];
  resolveDedupeCommand?(constraints?: RemediationConstraints): string[] | undefined;
}

function withWorkspace(command: string[], pm: PackageManager, workspace?: string): string[] {
  if (!workspace) return command;
  if (pm === "pnpm") return [command[0], "--filter", workspace, ...command.slice(1)];
  if (pm === "npm") return [...command, "--workspace", workspace];
  return command;
}

export const npmDriver: PackageManagerDriver = {
  id: "npm",
  ecosystem: "npm",
  lockfileName: "package-lock.json",
  detect: (cwd) => existsSync(join(cwd, "package-lock.json")),
  resolveInstallCommand(constraints) {
    const installMode = constraints?.installMode ?? "deterministic";
    const frozenOverride = constraints?.enforceFrozenLockfile;
    const preferOfflineOverride = constraints?.installPreferOffline;
    const useCi =
      frozenOverride === true || (frozenOverride === undefined && installMode === "deterministic");
    const cmd = ["npm", useCi ? "ci" : "install"];
    if (!useCi && (preferOfflineOverride ?? installMode !== "standard")) {
      cmd.push("--prefer-offline");
    }
    return withWorkspace(cmd, "npm", constraints?.workspace);
  },
  resolveTestCommand: (constraints) =>
    withWorkspace(["npm", "test"], "npm", constraints?.workspace),
  resolveAuditCommand: (opts) => withWorkspace(["npm", "audit", "--json"], "npm", opts?.workspace),
  resolveDedupeCommand: (constraints) =>
    withWorkspace(["npm", "dedupe"], "npm", constraints?.workspace),
};

export const pnpmDriver: PackageManagerDriver = {
  id: "pnpm",
  ecosystem: "npm",
  lockfileName: "pnpm-lock.yaml",
  detect: (cwd) => existsSync(join(cwd, "pnpm-lock.yaml")),
  resolveInstallCommand(constraints) {
    const installMode = constraints?.installMode ?? "deterministic";
    const frozen = constraints?.enforceFrozenLockfile ?? installMode === "deterministic";
    const preferOffline = constraints?.installPreferOffline ?? installMode !== "standard";
    const cmd = ["pnpm", "install"];
    if (frozen) cmd.push("--frozen-lockfile");
    if (preferOffline) cmd.push("--prefer-offline");
    return withWorkspace(cmd, "pnpm", constraints?.workspace);
  },
  resolveTestCommand: (constraints) =>
    withWorkspace(["pnpm", "test"], "pnpm", constraints?.workspace),
  resolveAuditCommand: (opts) =>
    withWorkspace(["pnpm", "audit", "--json"], "pnpm", opts?.workspace),
  resolveDedupeCommand: (constraints) =>
    withWorkspace(["pnpm", "dedupe"], "pnpm", constraints?.workspace),
};

export const yarnDriver: PackageManagerDriver = {
  id: "yarn",
  ecosystem: "npm",
  lockfileName: "yarn.lock",
  detect: (cwd) => existsSync(join(cwd, "yarn.lock")),
  resolveInstallCommand(constraints, yarnMajor = 1) {
    const installMode = constraints?.installMode ?? "deterministic";
    const frozen = constraints?.enforceFrozenLockfile ?? installMode === "deterministic";
    const cmd = ["yarn", "install"];
    if (frozen) {
      if (yarnMajor >= 2) cmd.push("--immutable");
      else cmd.push("--frozen-lockfile");
    }
    return withWorkspace(cmd, "yarn", constraints?.workspace);
  },
  resolveTestCommand: (constraints) =>
    withWorkspace(["yarn", "test"], "yarn", constraints?.workspace),
  resolveAuditCommand: (opts) =>
    withWorkspace(["yarn", "audit", "--json"], "yarn", opts?.workspace),
  resolveDedupeCommand: (constraints) =>
    withWorkspace(["yarn", "dedupe"], "yarn", constraints?.workspace),
};

export const bunDriver: PackageManagerDriver = {
  id: "bun",
  ecosystem: "npm",
  lockfileName: "bun.lockb",
  detect: (cwd) => existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock")),
  resolveInstallCommand(constraints) {
    const installMode = constraints?.installMode ?? "deterministic";
    const frozen = constraints?.enforceFrozenLockfile ?? installMode === "deterministic";
    const cmd = ["bun", "install"];
    if (frozen) cmd.push("--frozen-lockfile");
    return withWorkspace(cmd, "bun", constraints?.workspace);
  },
  resolveTestCommand: (constraints) =>
    withWorkspace(["bun", "test"], "bun", constraints?.workspace),
  resolveAuditCommand: () => ["bun", "audit", "--json"],
};

export const denoDriver: PackageManagerDriver = {
  id: "deno",
  ecosystem: "npm",
  lockfileName: "deno.lock",
  detect: (cwd) => existsSync(join(cwd, "deno.lock")) || existsSync(join(cwd, "deno.json")),
  resolveInstallCommand(constraints) {
    const installMode = constraints?.installMode ?? "deterministic";
    const frozen = constraints?.enforceFrozenLockfile ?? installMode === "deterministic";
    const preferOffline = constraints?.installPreferOffline ?? installMode === "prefer-offline";
    const cmd = ["deno", "install"];
    if (frozen) cmd.push("--frozen");
    if (preferOffline && !frozen) cmd.push("--cache-only");
    return withWorkspace(cmd, "deno", constraints?.workspace);
  },
  resolveTestCommand: (constraints) =>
    withWorkspace(["deno", "test"], "deno", constraints?.workspace),
  resolveAuditCommand: () => {
    throw new Error(
      "Deno does not support a native audit command. Use --input with a SARIF or npm-audit scan file instead.",
    );
  },
};

const driverRegistry = new Map<PackageManager, PackageManagerDriver>([
  ["npm", npmDriver],
  ["pnpm", pnpmDriver],
  ["yarn", yarnDriver],
  ["bun", bunDriver],
  ["deno", denoDriver],
]);

export function getDriver(pm: PackageManager): PackageManagerDriver {
  const driver = driverRegistry.get(pm);
  if (!driver) {
    throw new Error(`Unsupported package manager: ${pm}`);
  }
  return driver;
}

export function detectPackageManagerDriver(cwd: string): PackageManagerDriver {
  if (pnpmDriver.detect(cwd)) return pnpmDriver;
  if (yarnDriver.detect(cwd)) return yarnDriver;
  if (bunDriver.detect(cwd)) return bunDriver;
  if (denoDriver.detect(cwd)) return denoDriver;
  return npmDriver;
}

export function registerPackageManagerDriver(driver: PackageManagerDriver): void {
  driverRegistry.set(driver.id, driver);
}
