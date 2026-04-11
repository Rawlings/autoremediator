import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  execa: vi.fn(),
  loadPolicy: vi.fn(),
  isPackageAllowed: vi.fn(),
  detectPackageManager: vi.fn(),
  getPackageManagerCommands: vi.fn(),
  resolveInstallCommand: vi.fn(),
  resolveTestCommand: vi.fn(),
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
  resolveInstallCommand: mocked.resolveInstallCommand,
  resolveTestCommand: mocked.resolveTestCommand,
}));

vi.mock("../../platform/repo-lock.js", () => ({
  withRepoLock: mocked.withRepoLock,
}));

import { applyVersionBumpTool } from "./apply-version-bump.js";

describe("apply-version-bump lock integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocked.readFileSync.mockReturnValue(
      JSON.stringify({ dependencies: { lodash: "^4.17.0" } })
    );
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
    mocked.resolveInstallCommand.mockReturnValue(["npm", "ci", "--prefer-offline"]);
    mocked.resolveTestCommand.mockReturnValue(["npm", "test"]);
    mocked.execa.mockResolvedValue({ stdout: "ok" });
    mocked.withRepoLock.mockImplementation(async (_cwd: string, fn: () => Promise<unknown>) => fn());
  });

  it("uses withRepoLock for non-dry-run mutation path", async () => {
    const result = await (applyVersionBumpTool as any).execute({
      cwd: "/tmp/project",
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      dryRun: false,
      runTests: false,
    });

    expect(mocked.withRepoLock).toHaveBeenCalledTimes(1);
    expect(mocked.withRepoLock).toHaveBeenCalledWith(
      "/tmp/project",
      expect.any(Function)
    );
    expect(result.applied).toBe(true);
  });

  it("does not acquire lock in dry-run mode", async () => {
    const result = await (applyVersionBumpTool as any).execute({
      cwd: "/tmp/project",
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      dryRun: true,
      runTests: false,
    });

    expect(mocked.withRepoLock).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
  });
});
