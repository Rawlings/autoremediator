import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reconcilePatchArtifacts } from "./reconcile.js";
import { safeExeca } from "../../platform/safe-exec.js";

vi.mock("../../platform/safe-exec.js", () => ({
  safeExeca: vi.fn(),
}));

vi.mock("../../remediation/evaluate-package.js", () => ({
  evaluatePackage: vi.fn().mockImplementation(async (pkg: string) => {
    if (pkg === "outdated-vuln-pkg" || pkg === "transitive-vuln-pkg") {
      return {
        packageName: pkg,
        currentVersion: "1.0.0",
        safeUpgradeVersion: "1.2.0",
        vulnerabilities: [
          {
            cveId: "CVE-2023-9999",
            safeUpgradeVersion: "1.2.0",
          },
        ],
      };
    }
    return {
      packageName: pkg,
      currentVersion: "1.0.0",
      safeUpgradeVersion: undefined,
      vulnerabilities: [],
    };
  }),
}));

describe("Feature 11: Adversarial Reconciliation Rollback (Co-located Challenge Suite)", () => {
  let tempDir: string;
  let patchesDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "challenger-reconcile-"));
    patchesDir = join(tempDir, "patches");
    mkdirSync(patchesDir, { recursive: true });
    vi.mocked(safeExeca).mockReset();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("restores exact byte-for-byte package.json and patch artifacts when pnpm install fails", async () => {
    const patchPath = join(patchesDir, "outdated-vuln-pkg+1.0.0.patch");
    const originalPatchContent =
      "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-vuln\n+patched\n";
    const manifestPath = `${patchPath}.json`;
    const originalManifestContent = JSON.stringify(
      {
        cveId: "CVE-2023-9999",
        packageName: "outdated-vuln-pkg",
        vulnerableVersion: "1.0.0",
        customField: "preserved",
      },
      null,
      4,
    );

    writeFileSync(patchPath, originalPatchContent, "utf8");
    writeFileSync(manifestPath, originalManifestContent, "utf8");

    const pkgJsonPath = join(tempDir, "package.json");
    const originalPkgJson =
      JSON.stringify(
        {
          name: "mission-critical-app",
          version: "2.5.0",
          private: true,
          dependencies: {
            "outdated-vuln-pkg": "^1.0.0",
            react: "^18.2.0",
          },
          pnpm: {
            patchedDependencies: {
              "outdated-vuln-pkg@1.0.0": "patches/outdated-vuln-pkg+1.0.0.patch",
            },
          },
        },
        null,
        2,
      ) + "\n";
    writeFileSync(pkgJsonPath, originalPkgJson, "utf8");

    // Simulate pnpm install crashing with exit code 1
    vi.mocked(safeExeca).mockRejectedValueOnce(
      new Error("Command failed with exit code 1: pnpm install --frozen-lockfile"),
    );

    const report = await reconcilePatchArtifacts({
      cwd: tempDir,
      packageManager: "pnpm",
      patchesDir: "patches",
      autoApply: true,
    });

    expect(report.reconciledCount).toBe(0);
    expect(report.reconciled).toHaveLength(1);
    expect(report.reconciled[0]!.status).toBe("error");
    expect(report.reconciled[0]!.reason).toContain("Package manager installation failed");
    expect(report.reconciled[0]!.reason).toContain(
      "Restored original package.json and patch artifacts",
    );

    // Verify exact on-disk restoration
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toBe(originalPatchContent);

    expect(existsSync(manifestPath)).toBe(true);
    expect(readFileSync(manifestPath, "utf8")).toBe(originalManifestContent);

    expect(existsSync(pkgJsonPath)).toBe(true);
    expect(readFileSync(pkgJsonPath, "utf8")).toBe(originalPkgJson);
  });

  it("restores exact on-disk state when post-upgrade test validation fails (runTests: true)", async () => {
    const patchPath = join(patchesDir, "outdated-vuln-pkg+1.0.0.patch");
    const originalPatchContent = "--- a/lib.js\n+++ b/lib.js\n@@ -1 +1 @@\n-old\n+new\n";
    const manifestPath = `${patchPath}.json`;
    const originalManifestContent = JSON.stringify({
      cveId: "CVE-2023-9999",
      packageName: "outdated-vuln-pkg",
      vulnerableVersion: "1.0.0",
    });

    writeFileSync(patchPath, originalPatchContent, "utf8");
    writeFileSync(manifestPath, originalManifestContent, "utf8");

    const pkgJsonPath = join(tempDir, "package.json");
    const originalPkgJson =
      JSON.stringify(
        {
          name: "test-app",
          dependencies: {
            "outdated-vuln-pkg": "^1.0.0",
          },
        },
        null,
        2,
      ) + "\n";
    writeFileSync(pkgJsonPath, originalPkgJson, "utf8");

    // Install succeeds (code 0), but test fails (code 1)
    vi.mocked(safeExeca)
      .mockResolvedValueOnce({ stdout: "installed successfully", stderr: "", exitCode: 0 } as any)
      .mockRejectedValueOnce(
        new Error(
          "Command failed with exit code 1: pnpm test\nAssertionError: expected true to be false",
        ),
      );

    const report = await reconcilePatchArtifacts({
      cwd: tempDir,
      packageManager: "pnpm",
      patchesDir: "patches",
      autoApply: true,
      runTests: true,
    });

    expect(report.reconciledCount).toBe(0);
    expect(report.reconciled[0]!.status).toBe("error");
    expect(report.reconciled[0]!.reason).toContain("Validation tests failed post-upgrade");
    expect(report.reconciled[0]!.reason).toContain(
      "Restored original package.json and patch artifacts",
    );

    // Verify files restored
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toBe(originalPatchContent);
    expect(existsSync(manifestPath)).toBe(true);
    expect(readFileSync(manifestPath, "utf8")).toBe(originalManifestContent);
    expect(readFileSync(pkgJsonPath, "utf8")).toBe(originalPkgJson);
  });

  it("restores pre-existing package overrides when transitive reconciliation fails", async () => {
    const patchPath = join(patchesDir, "transitive-vuln-pkg+1.0.0.patch");
    const originalPatchContent = "--- a/sub.js\n+++ b/sub.js\n@@ -1 +1 @@\n-a\n+b\n";
    writeFileSync(patchPath, originalPatchContent, "utf8");

    const pkgJsonPath = join(tempDir, "package.json");
    const originalPkgJson =
      JSON.stringify(
        {
          name: "transitive-app",
          dependencies: {
            "root-dep": "^1.0.0",
          },
          pnpm: {
            overrides: {
              "unrelated-pkg": "3.0.0",
            },
          },
        },
        null,
        2,
      ) + "\n";
    writeFileSync(pkgJsonPath, originalPkgJson, "utf8");

    vi.mocked(safeExeca).mockRejectedValueOnce(new Error("pnpm install lockfile conflict"));

    const report = await reconcilePatchArtifacts({
      cwd: tempDir,
      packageManager: "pnpm",
      patchesDir: "patches",
      autoApply: true,
    });

    expect(report.reconciledCount).toBe(0);
    expect(report.reconciled[0]!.status).toBe("error");
    expect(readFileSync(pkgJsonPath, "utf8")).toBe(originalPkgJson);
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toBe(originalPatchContent);
  });

  it("does not restore manifest if none existed prior to reconciliation", async () => {
    const patchPath = join(patchesDir, "outdated-vuln-pkg+1.0.0.patch");
    const originalPatchContent = "--- a/only-patch.js\n+++ b/only-patch.js\n@@ -1 +1 @@\n-x\n+y\n";
    writeFileSync(patchPath, originalPatchContent, "utf8");
    // Notice: no .patch.json created!

    const pkgJsonPath = join(tempDir, "package.json");
    const originalPkgJson =
      JSON.stringify(
        {
          name: "no-manifest-app",
          dependencies: {
            "outdated-vuln-pkg": "^1.0.0",
          },
        },
        null,
        2,
      ) + "\n";
    writeFileSync(pkgJsonPath, originalPkgJson, "utf8");

    vi.mocked(safeExeca).mockRejectedValueOnce(new Error("pnpm install failed"));

    const report = await reconcilePatchArtifacts({
      cwd: tempDir,
      packageManager: "pnpm",
      patchesDir: "patches",
      autoApply: true,
    });

    expect(report.reconciledCount).toBe(0);
    expect(report.reconciled[0]!.status).toBe("error");

    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toBe(originalPatchContent);
    expect(existsSync(`${patchPath}.json`)).toBe(false);
    expect(readFileSync(pkgJsonPath, "utf8")).toBe(originalPkgJson);
  });
});
