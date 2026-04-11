import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  getPackageManagerCommands,
  resolveInstallCommand,
} from "./package-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("package-manager commands", () => {
  it("returns deterministic install command for npm", () => {
    const commands = getPackageManagerCommands("npm");
    expect(commands.installDeterministic).toEqual(["npm", "ci", "--prefer-offline"]);
  });

  it("returns deterministic install command for pnpm", () => {
    const commands = getPackageManagerCommands("pnpm");
    expect(commands.installDeterministic).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
    ]);
  });

  it("returns deterministic install command for yarn", () => {
    const commands = getPackageManagerCommands("yarn");
    expect(commands.installDeterministic).toEqual(["yarn", "install", "--frozen-lockfile"]);
  });

  it("allows standard install mode override", () => {
    const command = resolveInstallCommand("npm", { installMode: "standard" });
    expect(command).toEqual(["npm", "install"]);
  });

  it("allows disabling prefer-offline on deterministic pnpm installs", () => {
    const command = resolveInstallCommand("pnpm", {
      installMode: "deterministic",
      installPreferOffline: false,
    });

    expect(command).toEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  it("allows disabling frozen lockfile for yarn installs", () => {
    const command = resolveInstallCommand("yarn", {
      installMode: "deterministic",
      enforceFrozenLockfile: false,
    });

    expect(command).toEqual(["yarn", "install"]);
  });

  it("allows forcing frozen lockfile for npm install mode", () => {
    const command = resolveInstallCommand("npm", {
      installMode: "standard",
      enforceFrozenLockfile: true,
    });

    expect(command).toEqual(["npm", "ci"]);
  });
});

describe("detectPackageManager", () => {
  it("prefers pnpm when lockfile exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ar-pm-"));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    expect(detectPackageManager(cwd)).toBe("pnpm");
  });

  it("uses yarn when yarn lockfile exists and pnpm lockfile does not", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ar-pm-"));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, "yarn.lock"), "# yarn lockfile\n", "utf8");

    expect(detectPackageManager(cwd)).toBe("yarn");
  });

  it("defaults to npm when no lockfile exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ar-pm-"));
    tempDirs.push(cwd);

    expect(detectPackageManager(cwd)).toBe("npm");
  });
});
