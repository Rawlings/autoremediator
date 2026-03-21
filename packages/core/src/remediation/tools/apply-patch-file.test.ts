import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  execa: vi.fn(),
  detectPackageManager: vi.fn(),
  getPackageManagerCommands: vi.fn(),
  withRepoLock: vi.fn(),
}));

vi.mock("ai", () => ({
  tool: (def: unknown) => def,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocked.mkdir,
  mkdtemp: mocked.mkdtemp,
  readFile: mocked.readFile,
  rm: mocked.rm,
  writeFile: mocked.writeFile,
}));

vi.mock("execa", () => ({
  execa: mocked.execa,
}));

vi.mock("../../platform/package-manager.js", () => ({
  detectPackageManager: mocked.detectPackageManager,
  getPackageManagerCommands: mocked.getPackageManagerCommands,
}));

vi.mock("../../platform/repo-lock.js", () => ({
  withRepoLock: mocked.withRepoLock,
}));

import { applyPatchFileTool } from "./apply-patch-file.js";

describe("apply-patch-file lock integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocked.mkdir.mockResolvedValue(undefined);
    mocked.writeFile.mockResolvedValue(undefined);
    mocked.readFile.mockResolvedValue(
      JSON.stringify({
        devDependencies: { "patch-package": "^8.0.0" },
        scripts: {},
      })
    );
    mocked.rm.mockResolvedValue(undefined);
    mocked.detectPackageManager.mockReturnValue("npm");
    mocked.getPackageManagerCommands.mockReturnValue({
      installDev: (pkg: string) => ["npm", "install", "-D", pkg],
      test: ["npm", "test"],
    });
    mocked.execa.mockResolvedValue({ stdout: "ok", stderr: "" });
    mocked.withRepoLock.mockImplementation(async (_cwd: string, fn: () => Promise<unknown>) => fn());
  });

  it("uses withRepoLock for non-dry-run patch application", async () => {
    const result = await (applyPatchFileTool as any).execute({
      packageName: "lodash",
      vulnerableVersion: "4.17.0",
      patchContent: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
      patchesDir: "./patches",
      cwd: "/tmp/project",
      packageManager: "npm",
      validateWithTests: false,
      dryRun: false,
    });

    expect(mocked.withRepoLock).toHaveBeenCalledTimes(1);
    expect(mocked.withRepoLock).toHaveBeenCalledWith(
      "/tmp/project",
      expect.any(Function)
    );
    expect(result.applied).toBe(true);
  });

  it("does not acquire lock in dry-run mode", async () => {
    const result = await (applyPatchFileTool as any).execute({
      packageName: "lodash",
      vulnerableVersion: "4.17.0",
      patchContent: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
      patchesDir: "./patches",
      cwd: "/tmp/project",
      packageManager: "npm",
      validateWithTests: false,
      dryRun: true,
    });

    expect(mocked.withRepoLock).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
  });
});
