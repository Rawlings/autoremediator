import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  execa: vi.fn(),
  loadPolicy: vi.fn(),
  isPackageAllowed: vi.fn(),
  detectPackageManager: vi.fn(),
  getPackageManagerCommands: vi.fn(),
  getYarnMajorVersion: vi.fn(),
  resolveDedupeCommand: vi.fn(),
  resolveInstallCommand: vi.fn(),
  resolveTestCommand: vi.fn(),
  resolveWhyCommand: vi.fn(),
  withRepoLock: vi.fn(),
}));

vi.mock("ai", () => ({
  tool: (def: unknown) => def,
}));

vi.mock("node:fs", () => ({
  readFileSync: mocked.readFileSync,
  writeFileSync: mocked.writeFileSync,
}));

vi.mock("execa", () => ({
  execa: mocked.execa,
}));

vi.mock("../../platform/policy.js", () => ({
  loadPolicy: mocked.loadPolicy,
  isPackageAllowed: mocked.isPackageAllowed,
}));

vi.mock("../../platform/package-manager.js", () => ({
  detectPackageManager: mocked.detectPackageManager,
  getPackageManagerCommands: mocked.getPackageManagerCommands,
  getYarnMajorVersion: mocked.getYarnMajorVersion,
  resolveDedupeCommand: mocked.resolveDedupeCommand,
  resolveInstallCommand: mocked.resolveInstallCommand,
  resolveTestCommand: mocked.resolveTestCommand,
  resolveWhyCommand: mocked.resolveWhyCommand,
}));

vi.mock("../../platform/repo-lock.js", () => ({
  withRepoLock: mocked.withRepoLock,
}));

import { applyPackageOverrideTool } from "./apply-package-override.js";

describe("apply-package-override", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocked.readFileSync.mockReturnValue(JSON.stringify({ name: "demo-app" }));
    mocked.loadPolicy.mockReturnValue({
      allowMajorBumps: false,
      denyPackages: [],
      allowPackages: [],
    });
    mocked.isPackageAllowed.mockReturnValue(true);
    mocked.detectPackageManager.mockReturnValue("npm");
    mocked.getPackageManagerCommands.mockReturnValue({
      installDeterministic: ["npm", "ci", "--prefer-offline"],
      installPreferOffline: ["npm", "install", "--prefer-offline"],
      test: ["npm", "test"],
    });
    mocked.resolveDedupeCommand.mockReturnValue(["npm", "dedupe"]);
    mocked.resolveInstallCommand.mockReturnValue(["npm", "ci", "--prefer-offline"]);
    mocked.resolveTestCommand.mockReturnValue(["npm", "test"]);
    mocked.resolveWhyCommand.mockReturnValue(["npm", "explain", "minimist"]);
    mocked.getYarnMajorVersion.mockResolvedValue(1);
    mocked.execa.mockResolvedValue({ stdout: "ok" });
    mocked.withRepoLock.mockImplementation(async (_cwd: string, fn: () => Promise<unknown>) => fn());
  });

  it("writes npm overrides for non-dry-run remediation", async () => {
    const result = await (applyPackageOverrideTool as any).execute({
      cwd: "/tmp/project",
      packageManager: "npm",
      packageName: "minimist",
      fromVersion: "1.2.0",
      toVersion: "1.2.8",
      dryRun: false,
      runTests: false,
    });

    expect(mocked.withRepoLock).toHaveBeenCalledTimes(1);
    expect(mocked.writeFileSync).toHaveBeenCalledWith(
      "/tmp/project/package.json",
      expect.stringContaining('"overrides": {\n    "minimist": "1.2.8"\n  }'),
      "utf8"
    );
    expect(result.strategy).toBe("override");
    expect(result.applied).toBe(true);
  });

  it("writes pnpm overrides under pnpm.overrides", async () => {
    await (applyPackageOverrideTool as any).execute({
      cwd: "/tmp/project",
      packageManager: "pnpm",
      packageName: "minimist",
      fromVersion: "1.2.0",
      toVersion: "1.2.8",
      dryRun: false,
      runTests: false,
    });

    expect(mocked.writeFileSync).toHaveBeenCalledWith(
      "/tmp/project/package.json",
      expect.stringContaining('"pnpm": {\n    "overrides": {\n      "minimist": "1.2.8"\n    }\n  }'),
      "utf8"
    );
  });

  it("writes yarn resolutions for yarn projects", async () => {
    await (applyPackageOverrideTool as any).execute({
      cwd: "/tmp/project",
      packageManager: "yarn",
      packageName: "minimist",
      fromVersion: "1.2.0",
      toVersion: "1.2.8",
      dryRun: false,
      runTests: false,
    });

    expect(mocked.writeFileSync).toHaveBeenCalledWith(
      "/tmp/project/package.json",
      expect.stringContaining('"resolutions": {\n    "minimist": "1.2.8"\n  }'),
      "utf8"
    );
  });

  it("does not acquire lock in dry-run mode", async () => {
    const result = await (applyPackageOverrideTool as any).execute({
      cwd: "/tmp/project",
      packageManager: "npm",
      packageName: "minimist",
      fromVersion: "1.2.0",
      toVersion: "1.2.8",
      dryRun: true,
      runTests: false,
    });

    expect(mocked.withRepoLock).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.strategy).toBe("override");
  });

  it("uses provided selector key for override entries", async () => {
    await (applyPackageOverrideTool as any).execute({
      cwd: "/tmp/project",
      packageManager: "npm",
      packageName: "minimist",
      selector: "@scope/parent>minimist",
      fromVersion: "1.2.0",
      toVersion: "1.2.8",
      dryRun: false,
      runTests: false,
    });

    expect(mocked.writeFileSync).toHaveBeenCalledWith(
      "/tmp/project/package.json",
      expect.stringContaining('"@scope/parent>minimist": "1.2.8"'),
      "utf8"
    );
  });
});