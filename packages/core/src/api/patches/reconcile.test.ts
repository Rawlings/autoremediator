import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcilePatchArtifacts } from "./reconcile.js";

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

const mockSafeExeca = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

vi.mock("../../platform/safe-exec.js", () => ({
  safeExeca: (...args: unknown[]) => mockSafeExeca(...args),
}));

describe("reconcilePatchArtifacts", () => {
  let dir: string;
  let patchesDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autoremediator-reconcile-test-"));
    patchesDir = join(dir, "patches");
    mkdirSync(patchesDir, { recursive: true });
    mockSafeExeca.mockReset();
    mockSafeExeca.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("identifies safe version available when patch can be retired", async () => {
    const patchPath = join(patchesDir, "outdated-vuln-pkg+1.0.0.patch");
    writeFileSync(patchPath, "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-bad\n+good\n");
    writeFileSync(
      `${patchPath}.json`,
      JSON.stringify({
        cveId: "CVE-2023-9999",
        packageName: "outdated-vuln-pkg",
        vulnerableVersion: "1.0.0",
        patchMode: "pnpm-patch",
      }),
    );

    const report = await reconcilePatchArtifacts({
      cwd: dir,
      patchesDir: "patches",
      autoApply: false,
    });

    expect(report.reconciledCount).toBe(0);
    expect(report.retainedCount).toBe(1);
    expect(report.reconciled[0]).toMatchObject({
      packageName: "outdated-vuln-pkg",
      status: "safe-version-available",
      safeUpstreamVersion: "1.2.0",
    });
  });

  it("auto-applies upstream upgrade and removes patch artifacts", async () => {
    const patchPath = join(patchesDir, "outdated-vuln-pkg+1.0.0.patch");
    writeFileSync(patchPath, "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-bad\n+good\n");
    writeFileSync(
      `${patchPath}.json`,
      JSON.stringify({
        cveId: "CVE-2023-9999",
        packageName: "outdated-vuln-pkg",
        vulnerableVersion: "1.0.0",
        patchMode: "pnpm-patch",
      }),
    );

    const pkgJsonPath = join(dir, "package.json");
    writeFileSync(
      pkgJsonPath,
      JSON.stringify({
        name: "test-app",
        dependencies: {
          "outdated-vuln-pkg": "^1.0.0",
        },
      }),
    );

    const report = await reconcilePatchArtifacts({
      cwd: dir,
      patchesDir: "patches",
      autoApply: true,
    });

    expect(report.reconciledCount).toBe(1);
    expect(report.reconciled[0]?.status).toBe("upgraded");
    expect(report.reconciled[0]?.safeUpstreamVersion).toBe("1.2.0");

    expect(existsSync(patchPath)).toBe(false);
    expect(existsSync(`${patchPath}.json`)).toBe(false);

    const updatedPkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    expect(updatedPkgJson.dependencies["outdated-vuln-pkg"]).toBe("^1.2.0");
  });

  it("rolls back package.json and patch artifacts when package manager install fails", async () => {
    const patchPath = join(patchesDir, "outdated-vuln-pkg+1.0.0.patch");
    const originalPatchContent = "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-bad\n+good\n";
    writeFileSync(patchPath, originalPatchContent);
    const originalManifestContent = JSON.stringify({
      cveId: "CVE-2023-9999",
      packageName: "outdated-vuln-pkg",
      vulnerableVersion: "1.0.0",
    });
    writeFileSync(`${patchPath}.json`, originalManifestContent);

    const pkgJsonPath = join(dir, "package.json");
    const originalPkgJson = JSON.stringify(
      {
        name: "test-app",
        dependencies: {
          "outdated-vuln-pkg": "^1.0.0",
        },
      },
      null,
      2,
    );
    writeFileSync(pkgJsonPath, originalPkgJson);

    // Mock install failure
    mockSafeExeca.mockRejectedValueOnce(new Error("Command failed with exit code 1: pnpm install"));

    const report = await reconcilePatchArtifacts({
      cwd: dir,
      patchesDir: "patches",
      autoApply: true,
    });

    expect(report.reconciledCount).toBe(0);
    expect(report.reconciled[0]?.status).toBe("error");
    expect(report.reconciled[0]?.reason).toContain("Package manager installation failed");

    // Verify rollback restored patch and package.json
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toBe(originalPatchContent);
    expect(existsSync(`${patchPath}.json`)).toBe(true);
    expect(readFileSync(pkgJsonPath, "utf8")).toBe(originalPkgJson);
  });

  it("rolls back package.json and patch artifacts when validation tests fail", async () => {
    const patchPath = join(patchesDir, "outdated-vuln-pkg+1.0.0.patch");
    const originalPatchContent = "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-bad\n+good\n";
    writeFileSync(patchPath, originalPatchContent);
    writeFileSync(
      `${patchPath}.json`,
      JSON.stringify({
        cveId: "CVE-2023-9999",
        packageName: "outdated-vuln-pkg",
        vulnerableVersion: "1.0.0",
      }),
    );

    const pkgJsonPath = join(dir, "package.json");
    const originalPkgJson = JSON.stringify(
      {
        name: "test-app",
        dependencies: {
          "outdated-vuln-pkg": "^1.0.0",
        },
      },
      null,
      2,
    );
    writeFileSync(pkgJsonPath, originalPkgJson);

    // Install succeeds, but test fails
    mockSafeExeca
      .mockResolvedValueOnce({ stdout: "installed", exitCode: 0 })
      .mockRejectedValueOnce(new Error("Command failed with exit code 1: pnpm test"));

    const report = await reconcilePatchArtifacts({
      cwd: dir,
      patchesDir: "patches",
      autoApply: true,
      runTests: true,
    });

    expect(report.reconciledCount).toBe(0);
    expect(report.reconciled[0]?.status).toBe("error");
    expect(report.reconciled[0]?.reason).toContain("Validation tests failed post-upgrade");

    // Verify rollback restored files
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(pkgJsonPath, "utf8")).toBe(originalPkgJson);
  });

  it("handles transitive dependencies by setting package-manager native overrides", async () => {
    const patchPath = join(patchesDir, "transitive-vuln-pkg+1.0.0.patch");
    writeFileSync(patchPath, "--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-bad\n+good\n");
    writeFileSync(
      `${patchPath}.json`,
      JSON.stringify({
        cveId: "CVE-2023-9999",
        packageName: "transitive-vuln-pkg",
        vulnerableVersion: "1.0.0",
      }),
    );

    const pkgJsonPath = join(dir, "package.json");
    writeFileSync(
      pkgJsonPath,
      JSON.stringify({
        name: "test-app",
        dependencies: {
          "some-top-level-pkg": "^2.0.0",
        },
      }),
    );

    const report = await reconcilePatchArtifacts({
      cwd: dir,
      packageManager: "npm",
      patchesDir: "patches",
      autoApply: true,
    });

    expect(report.reconciledCount).toBe(1);
    expect(report.reconciled[0]?.status).toBe("upgraded");

    const updatedPkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    expect(updatedPkgJson.overrides["transitive-vuln-pkg"]).toBe("1.2.0");
  });
});
