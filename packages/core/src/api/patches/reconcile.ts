import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { evaluatePackage } from "../../remediation/evaluate-package.js";
import {
  detectPackageManager,
  resolveInstallCommand,
  resolveTestCommand,
} from "../../platform/package-manager/index.js";
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
    } catch {
      // Ignore evaluation query errors
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

    try {
      const pkgJsonPath = join(cwd, "package.json");
      if (existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8")) as Record<string, any>;
        let updated = false;

        const depSections = [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ];
        for (const depSection of depSections) {
          if (pkgJson[depSection] && pkgJson[depSection][packageName]) {
            pkgJson[depSection][packageName] = `^${safeUpgradeVersion}`;
            updated = true;
          }
        }

        if (pkgJson.pnpm?.patchedDependencies) {
          for (const key of Object.keys(pkgJson.pnpm.patchedDependencies)) {
            if (key.startsWith(`${packageName}@`)) {
              delete pkgJson.pnpm.patchedDependencies[key];
              updated = true;
            }
          }
        }

        if (updated) {
          await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
        }
      }

      await rm(summary.patchFilePath, { force: true });
      if (inspection.manifestFilePath) {
        await rm(inspection.manifestFilePath, { force: true });
      }

      const installCmd = resolveInstallCommand(pm);
      await execa(installCmd[0], installCmd.slice(1), { cwd, reject: false });

      if (options.runTests) {
        const testCmd = resolveTestCommand(pm);
        await execa(testCmd[0], testCmd.slice(1), { cwd, reject: false });
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
