import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectPackageManager,
  getYarnMajorVersion,
  resolveDedupeCommand,
  getPackageManagerCommands,
  resolveAuditCommand,
  resolveInstallCommand,
  resolveWhyCommand,
} from "./package-manager.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Lazily import the mocked execa so tests can control its return value.
import { execa } from "execa";

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

  it("scopes npm install commands to workspace when provided", () => {
    const command = resolveInstallCommand("npm", {
      installMode: "standard",
      workspace: "web-app",
    });

    expect(command).toEqual(["npm", "install", "--workspace", "web-app"]);
  });

  it("scopes pnpm install commands with filter when workspace is provided", () => {
    const command = resolveInstallCommand("pnpm", {
      installMode: "deterministic",
      workspace: "@apps/web",
    });

    expect(command).toEqual([
      "pnpm",
      "--filter",
      "@apps/web",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
    ]);
  });

  it("scopes npm audit command to workspace when provided", () => {
    const command = resolveAuditCommand("npm", {
      workspace: "web-app",
    });

    expect(command).toEqual(["npm", "audit", "--json", "--workspace", "web-app"]);
  });

  it("scopes pnpm audit command with filter when workspace is provided", () => {
    const command = resolveAuditCommand("pnpm", {
      workspace: "@apps/web",
    });

    expect(command).toEqual(["pnpm", "--filter", "@apps/web", "audit", "--json"]);
  });

  it("resolves npm explain command for dependency path diagnostics", () => {
    const command = resolveWhyCommand("npm", "minimist");
    expect(command).toEqual(["npm", "explain", "minimist"]);
  });

  it("resolves pnpm why command with workspace filter", () => {
    const command = resolveWhyCommand("pnpm", "minimist", { workspace: "@apps/web" });
    expect(command).toEqual(["pnpm", "--filter", "@apps/web", "why", "minimist"]);
  });

  it("resolves npm dedupe command with workspace", () => {
    const command = resolveDedupeCommand("npm", { workspace: "web-app" });
    expect(command).toEqual(["npm", "dedupe", "--workspace", "web-app"]);
  });

  it("uses --frozen-lockfile for yarn classic (v1) deterministic install", () => {
    const command = resolveInstallCommand("yarn", { installMode: "deterministic" }, 1);
    expect(command).toEqual(["yarn", "install", "--frozen-lockfile"]);
  });

  it("uses --immutable for yarn berry (v2+) deterministic install", () => {
    const command = resolveInstallCommand("yarn", { installMode: "deterministic" }, 2);
    expect(command).toEqual(["yarn", "install", "--immutable"]);
  });

  it("uses --immutable for yarn berry v4 deterministic install", () => {
    const command = resolveInstallCommand("yarn", { installMode: "deterministic" }, 4);
    expect(command).toEqual(["yarn", "install", "--immutable"]);
  });

  it("defaults to --frozen-lockfile when yarnMajor is not provided", () => {
    const command = resolveInstallCommand("yarn", { installMode: "deterministic" });
    expect(command).toEqual(["yarn", "install", "--frozen-lockfile"]);
  });
});

describe("getYarnMajorVersion", () => {
  afterEach(() => {
    vi.mocked(execa).mockReset();
  });

  it("returns 1 for yarn classic v1", async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: "1.22.19", stderr: "" } as never);
    const major = await getYarnMajorVersion("/fake/cwd");
    expect(major).toBe(1);
  });

  it("returns 2 for yarn berry v2", async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: "2.4.3", stderr: "" } as never);
    const major = await getYarnMajorVersion("/fake/cwd");
    expect(major).toBe(2);
  });

  it("returns 4 for yarn berry v4", async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: "4.0.2", stderr: "" } as never);
    const major = await getYarnMajorVersion("/fake/cwd");
    expect(major).toBe(4);
  });

  it("falls back to 1 when yarn --version fails", async () => {
    vi.mocked(execa).mockRejectedValue(new Error("yarn not found"));
    const major = await getYarnMajorVersion("/fake/cwd");
    expect(major).toBe(1);
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
