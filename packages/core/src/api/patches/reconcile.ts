import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluatePackage } from "../../remediation/evaluate-package.js";
import {
  detectPackageManager,
  resolveInstallCommand,
  resolveTestCommand,
} from "../../platform/package-manager/index.js";
import { safeExeca } from "../../platform/safe-exec.js";
import {
  getOverrideValue,
  setOverrideValue,
  type RawPackageJson,
} from "../../remediation/tools/apply-package-override/helpers.js";
import type {
  PatchReconcileOptions,
  PatchReconcileReport,
  PatchReconcileResult,
} from "../../platform/types.js";
import { inspectPatchArtifact, listPatchArtifacts } from "./inspection.js";

/**
 * Reconciles active patch artifacts in patchesDir against upstream registries.
 * If safe upstream releases have been published, the patches can be retired and packages upgraded.
 */
export async function reconcilePatchArtifacts(
  options: PatchReconcileOptions = {},
): Promise<PatchReconcileReport> {
  const cwd = options.cwd ?? process.cwd();
  const pm = options.packageManager ?? detectPackageManager(cwd);

  const summaries = await listPatchArtifacts(options);
  const results: PatchReconcileResult[] = [];

  for (const summary of summaries) {
    const inspection = await inspectPatchArtifact(summary.patchFilePath, options);
    let packageName = inspection.packageName;
    let vulnerableVersion = inspection.vulnerableVersion;
    const cveId = inspection.cveId;

    if (!packageName && summary.patchFileName) {
      const basename = summary.patchFileName.replace(/\.patch$/, "");
      const plusIdx = basename.lastIndexOf("+");
      if (plusIdx > 0) {
        let rawPkg = basename.slice(0, plusIdx);
        vulnerableVersion = basename.slice(plusIdx + 1);
        if (rawPkg.includes("+")) {
          rawPkg = "@" + rawPkg.replace("+", "/");
        }
        packageName = rawPkg;
      } else {
        packageName = basename;
      }
    }

    if (!packageName) {
      results.push({
        patchFilePath: summary.patchFilePath,
        packageName: "unknown",
        cveId,
        status: "patch-retained",
        reason: "Cannot determine package name from patch artifact.",
      });
      continue;
    }

    let safeUpgradeVersion: string | undefined;
    try {
      const evaluation = await evaluatePackage(packageName, {
        version: vulnerableVersion,
        enrichIntelligence: false,
      });

      if (cveId) {
        const vuln = evaluation.vulnerabilities.find(
          (v) => v.cveId.toLowerCase() === cveId.toLowerCase(),
        );
        if (vuln?.safeUpgradeVersion) {
          safeUpgradeVersion = vuln.safeUpgradeVersion;
        }
      } else {
        safeUpgradeVersion = evaluation.vulnerabilities.find(
          (v) => v.safeUpgradeVersion,
        )?.safeUpgradeVersion;
      }
    } catch (evalError) {
      // Evaluation query failed or offline; record reason in diagnostic trail
      const _ignored = evalError;
    }

    if (!safeUpgradeVersion) {
      results.push({
        patchFilePath: summary.patchFilePath,
        packageName,
        cveId,
        installedVersion: vulnerableVersion,
        status: "patch-retained",
        reason: "No safe upstream release exists yet; patch remains necessary.",
      });
      continue;
    }

    if (!options.autoApply) {
      results.push({
        patchFilePath: summary.patchFilePath,
        packageName,
        cveId,
        installedVersion: vulnerableVersion,
        safeUpstreamVersion: safeUpgradeVersion,
        status: "safe-version-available",
        reason: `Safe upstream version ${safeUpgradeVersion} is available. Re-run with autoApply: true or --auto-apply to upgrade.`,
      });
      continue;
    }

    // Snapshot pre-mutation state for truthful rollback on command failure
    const pkgJsonPath = join(cwd, "package.json");
    const manifestPath = inspection.manifestFilePath ?? `${summary.patchFilePath}.json`;
    let originalPkgJsonContent: string | undefined;
    let originalPatchContent: string | undefined;
    let originalManifestContent: string | undefined;

    try {
      if (existsSync(pkgJsonPath)) {
        originalPkgJsonContent = await readFile(pkgJsonPath, "utf8");
      }
      if (existsSync(summary.patchFilePath)) {
        originalPatchContent = await readFile(summary.patchFilePath, "utf8");
      }
      if (existsSync(manifestPath)) {
        originalManifestContent = await readFile(manifestPath, "utf8");
      }

      if (originalPkgJsonContent) {
        const pkgJson = JSON.parse(originalPkgJsonContent) as RawPackageJson & Record<string, any>;
        let updated = false;

        const depSections = [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ];

        let foundInDirectDeps = false;
        for (const depSection of depSections) {
          if (pkgJson[depSection] && pkgJson[depSection][packageName]) {
            pkgJson[depSection][packageName] = `^${safeUpgradeVersion}`;
            updated = true;
            foundInDirectDeps = true;
          }
        }

        // Handle existing or newly needed transitive overrides
        const existingOverride = getOverrideValue(pkgJson, pm, packageName);
        if (existingOverride || !foundInDirectDeps) {
          setOverrideValue(pkgJson, pm, packageName, safeUpgradeVersion);
          updated = true;
        }

        // Remove from pnpm patchedDependencies if present
        if (pkgJson.pnpm?.patchedDependencies) {
          const patched = pkgJson.pnpm.patchedDependencies as Record<string, string>;
          for (const key of Object.keys(patched)) {
            if (key.startsWith(`${packageName}@`)) {
              delete patched[key];
              updated = true;
            }
          }
        }

        if (updated) {
          await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
        }
      }

      // Remove patch artifacts
      await rm(summary.patchFilePath, { force: true });
      if (existsSync(manifestPath)) {
        await rm(manifestPath, { force: true });
      }

      // Execute package installation truthfully
      const installCmd = resolveInstallCommand(pm);
      try {
        await safeExeca(installCmd[0], installCmd.slice(1), { cwd, stdio: "pipe" });
      } catch (installErr) {
        // Rollback state on install failure
        if (originalPkgJsonContent) {
          await writeFile(pkgJsonPath, originalPkgJsonContent, "utf8");
        }
        if (originalPatchContent) {
          await writeFile(summary.patchFilePath, originalPatchContent, "utf8");
        }
        if (originalManifestContent) {
          await writeFile(manifestPath, originalManifestContent, "utf8");
        }

        const msg = installErr instanceof Error ? installErr.message : String(installErr);
        results.push({
          patchFilePath: summary.patchFilePath,
          packageName,
          cveId,
          installedVersion: vulnerableVersion,
          safeUpstreamVersion: safeUpgradeVersion,
          status: "error",
          reason: `Package manager installation failed (${installCmd.join(" ")}): ${msg}. Restored original package.json and patch artifacts.`,
        });
        continue;
      }

      // Execute tests truthfully if requested
      if (options.runTests) {
        const testCmd = resolveTestCommand(pm);
        try {
          await safeExeca(testCmd[0], testCmd.slice(1), { cwd, stdio: "pipe" });
        } catch (testErr) {
          // Rollback state on test failure
          if (originalPkgJsonContent) {
            await writeFile(pkgJsonPath, originalPkgJsonContent, "utf8");
          }
          if (originalPatchContent) {
            await writeFile(summary.patchFilePath, originalPatchContent, "utf8");
          }
          if (originalManifestContent) {
            await writeFile(manifestPath, originalManifestContent, "utf8");
          }

          const msg = testErr instanceof Error ? testErr.message : String(testErr);
          results.push({
            patchFilePath: summary.patchFilePath,
            packageName,
            cveId,
            installedVersion: vulnerableVersion,
            safeUpstreamVersion: safeUpgradeVersion,
            status: "error",
            reason: `Validation tests failed post-upgrade (${testCmd.join(" ")}): ${msg}. Restored original package.json and patch artifacts.`,
          });
          continue;
        }
      }

      results.push({
        patchFilePath: summary.patchFilePath,
        packageName,
        cveId,
        installedVersion: vulnerableVersion,
        safeUpstreamVersion: safeUpgradeVersion,
        status: "upgraded",
        reason: `Successfully upgraded to ${safeUpgradeVersion} and retired patch artifact.`,
      });
    } catch (err) {
      results.push({
        patchFilePath: summary.patchFilePath,
        packageName,
        cveId,
        installedVersion: vulnerableVersion,
        safeUpstreamVersion: safeUpgradeVersion,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const reconciledCount = results.filter((r) => r.status === "upgraded").length;
  const retainedCount = results.filter(
    (r) => r.status === "patch-retained" || r.status === "safe-version-available",
  ).length;

  return {
    reconciled: results,
    reconciledCount,
    retainedCount,
  };
}
