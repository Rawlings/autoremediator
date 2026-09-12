import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcilePatchArtifacts } from "./reconcile.js";

vi.mock("../../remediation/evaluate-package.js", () => ({
  evaluatePackage: vi.fn().mockImplementation(async (pkg: string) => {
    if (pkg === "outdated-vuln-pkg") {
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

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 }),
}));

describe("reconcilePatchArtifacts", () => {
  let dir: string;
  let patchesDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autoremediator-reconcile-test-"));
    patchesDir = join(dir, "patches");
    mkdirSync(patchesDir, { recursive: true });
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
  });
});
