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
  getYarnMajorVersion: vi.fn(),
  resolveInstallCommand: vi.fn(),
  resolveTestCommand: vi.fn(),
  loadPolicy: vi.fn(),
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

vi.mock("../../platform/package-manager/index.js", () => ({
  detectPackageManager: mocked.detectPackageManager,
  getPackageManagerCommands: mocked.getPackageManagerCommands,
  getYarnMajorVersion: mocked.getYarnMajorVersion,
  resolveInstallCommand: mocked.resolveInstallCommand,
  resolveTestCommand: mocked.resolveTestCommand,
}));

vi.mock("../../platform/policy.js", () => ({
  loadPolicy: mocked.loadPolicy,
}));

vi.mock("../../platform/repo-lock.js", () => ({
  withRepoLock: mocked.withRepoLock,
}));

import { applyPatchFileTool } from "./apply-patch-file/index.js";

describe("apply-patch-file lock integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocked.mkdir.mockResolvedValue(undefined);
    mocked.writeFile.mockResolvedValue(undefined);
    mocked.readFile.mockResolvedValue(
      JSON.stringify({
        devDependencies: { "patch-package": "^8.0.0" },
        scripts: {},
      }),
    );
    mocked.rm.mockResolvedValue(undefined);
    mocked.detectPackageManager.mockReturnValue("npm");
    mocked.getPackageManagerCommands.mockReturnValue({
      installDeterministic: ["npm", "ci", "--prefer-offline"],
      installPreferOffline: ["npm", "install", "--prefer-offline"],
      installDev: (pkg: string) => ["npm", "install", "-D", pkg],
      test: ["npm", "test"],
    });
    mocked.loadPolicy.mockReturnValue({ constraints: { installMode: "deterministic" } });
    mocked.resolveInstallCommand.mockReturnValue(["npm", "ci", "--prefer-offline"]);
    mocked.resolveTestCommand.mockReturnValue(["npm", "test"]);
    mocked.execa.mockResolvedValue({ stdout: "ok", stderr: "" });
    mocked.withRepoLock.mockImplementation(async (_cwd: string, fn: () => Promise<unknown>) =>
      fn(),
    );
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
    expect(mocked.withRepoLock).toHaveBeenCalledWith("/tmp/project", expect.any(Function));
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

  it("rejects malformed patch content before writing files", async () => {
    const result = await (applyPatchFileTool as any).execute({
      packageName: "lodash",
      vulnerableVersion: "4.17.0",
      patchContent: "not a valid patch",
      patchesDir: "./patches",
      cwd: "/tmp/project",
      packageManager: "npm",
      validateWithTests: false,
      dryRun: false,
    });

    expect(result.applied).toBe(false);
    expect(result.success).toBe(false);
    expect(mocked.writeFile).not.toHaveBeenCalled();
    expect(mocked.withRepoLock).not.toHaveBeenCalled();
  });

  it("cleans up patch-package state when validation fails", async () => {
    mocked.execa
      .mockResolvedValueOnce({ stdout: "ok", stderr: "" })
      .mockRejectedValueOnce({ stdout: "FAIL lodash should work" })
      .mockResolvedValueOnce({ stdout: "rollback ok", stderr: "" });

    const result = await (applyPatchFileTool as any).execute({
      packageName: "lodash",
      vulnerableVersion: "4.17.0",
      patchContent: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
      patchesDir: "./patches",
      cwd: "/tmp/project",
      packageManager: "npm",
      validateWithTests: true,
      dryRun: false,
    });

    expect(result.applied).toBe(false);
    expect(result.success).toBe(false);
    expect(result.validation?.passed).toBe(false);
    expect(result.validation?.error).toContain("Failed tests");
    expect(mocked.rm).toHaveBeenCalledWith("/tmp/project/patches/lodash+4.17.0.patch", {
      force: true,
    });
    expect(mocked.rm).toHaveBeenCalledWith("/tmp/project/patches/lodash+4.17.0.patch.json", {
      force: true,
    });
    expect(mocked.writeFile).toHaveBeenCalledWith(
      "/tmp/project/package.json",
      expect.stringContaining('"postinstall": "patch-package"'),
      "utf8",
    );
    expect(mocked.writeFile).toHaveBeenCalledWith(
      "/tmp/project/package.json",
      JSON.stringify({
        devDependencies: { "patch-package": "^8.0.0" },
        scripts: {},
      }),
      "utf8",
    );
    expect(mocked.writeFile).toHaveBeenCalledWith(
      "/tmp/project/patches/lodash+4.17.0.patch.json",
      expect.stringContaining('"packageName": "lodash"'),
      "utf8",
    );
  });

  it("writes and runs synthesized reproduction test", async () => {
    mocked.detectPackageManager.mockReturnValue("npm");
    mocked.getPackageManagerCommands.mockReturnValue({
      install: ["npm", "install"],
      test: ["npm", "test"],
    });
    mocked.resolveInstallCommand.mockReturnValue(["npm", "install"]);
    mocked.resolveTestCommand.mockReturnValue(["npm", "test"]);
    mocked.execa.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    const result = await (applyPatchFileTool as any).execute({
      packageName: "lodash",
      vulnerableVersion: "4.17.0",
      patchContent: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
      patchesDir: "./patches",
      cwd: "/tmp/project",
      packageManager: "npm",
      reproductionTest: 'console.log("repro passed");',
      validateWithTests: false,
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(mocked.writeFile).toHaveBeenCalledWith(
      "/tmp/project/patches/lodash+4.17.0.test.cjs",
      'console.log("repro passed");',
      "utf8",
    );
    expect(result.patchArtifact.validationPhases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "reproduction-test",
          passed: true,
        }),
      ]),
    );
  });

  it("enforces dual-stage proofOfFix verification (negative pre-patch, positive post-patch)", async () => {
    mocked.detectPackageManager.mockReturnValue("npm");
    mocked.resolveInstallCommand.mockReturnValue(["npm", "install"]);
    mocked.resolveTestCommand.mockReturnValue(["npm", "test"]);

    // 1st execa call: pre-patch negative phase (must fail to reproduce exploit)
    // 2nd execa call: patch apply / install / test
    // 3rd execa call: post-patch positive phase (must succeed)
    mocked.execa
      .mockRejectedValueOnce({
        exitCode: 1,
        message: "AssertionError: bug reproduced",
        stderr: "fail",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "mitigated", stderr: "" });

    const result = await (applyPatchFileTool as any).execute({
      packageName: "lodash",
      vulnerableVersion: "4.17.0",
      patchContent: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
      patchesDir: "./patches",
      cwd: "/tmp/project",
      packageManager: "npm",
      reproductionTest: 'assert(false, "bug reproduced");',
      proofOfFix: true,
      validateWithTests: false,
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.proofOfFix).toBeDefined();
    expect(result.proofOfFix?.status).toBe("verified");
    expect(result.proofOfFix?.negativePhase.passed).toBe(true);
    expect(result.proofOfFix?.positivePhase.passed).toBe(true);
    expect(result.patchArtifact.validationPhases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "proof-of-fix-negative", passed: true }),
        expect.objectContaining({ phase: "proof-of-fix-positive", passed: true }),
      ]),
    );
  });

  it("aborts when requireProofOfFix is true and negative phase fails to reproduce bug", async () => {
    mocked.detectPackageManager.mockReturnValue("npm");
    mocked.resolveInstallCommand.mockReturnValue(["npm", "install"]);
    mocked.resolveTestCommand.mockReturnValue(["npm", "test"]);

    // Pre-patch negative phase unexpectedly succeeds (exitCode 0) -> false negative
    mocked.execa.mockResolvedValueOnce({ exitCode: 0, stdout: "passed", stderr: "" });

    const result = await (applyPatchFileTool as any).execute({
      packageName: "lodash",
      vulnerableVersion: "4.17.0",
      patchContent: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
      patchesDir: "./patches",
      cwd: "/tmp/project",
      packageManager: "npm",
      reproductionTest: 'console.log("no bug");',
      proofOfFix: true,
      requireProofOfFix: true,
      validateWithTests: false,
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.message).toContain("Proof-of-fix negative phase failed");
  });
});
