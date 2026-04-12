import { resolveSafeUpgradeVersion } from "../../intelligence/sources/registry.js";
import { applyVersionBumpTool } from "../tools/apply-version-bump.js";
import { applyPackageOverrideTool } from "../tools/apply-package-override/index.js";
import type { PatchResult, VulnerablePackage } from "../../platform/types.js";

export async function resolvePrimaryResult(params: {
  vulnerable: VulnerablePackage;
  cwd: string;
  packageManager: "npm" | "pnpm" | "yarn";
  dryRun: boolean;
  policy: string;
  runTests: boolean;
  constraints: {
    directDependenciesOnly?: boolean;
    preferVersionBump?: boolean;
    installMode?: "standard" | "prefer-offline" | "deterministic";
    installPreferOffline?: boolean;
    enforceFrozenLockfile?: boolean;
    workspace?: string;
  };
}): Promise<{ result: PatchResult; steps: number }> {
  const { vulnerable, cwd, packageManager, dryRun, policy, runTests, constraints } = params;
  const pkg = vulnerable.installed;
  const firstPatchedVersion = vulnerable.affected.firstPatchedVersion;

  if (pkg.type === "indirect") {
    if (constraints.directDependenciesOnly) {
      return {
        steps: 0,
        result: {
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "constraint-blocked",
          message: `Constraint blocked remediation for indirect dependency "${pkg.name}".`,
        },
      };
    }

    if (constraints.preferVersionBump) {
      return {
        steps: 0,
        result: {
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "constraint-blocked",
          message: `Constraint prefers version-bump and rejected override remediation for "${pkg.name}".`,
        },
      };
    }

    if (!firstPatchedVersion) {
      return {
        steps: 0,
        result: {
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "no-safe-version",
          message: `No firstPatchedVersion available for ${pkg.name}; cannot resolve deterministic override in local mode.`,
        },
      };
    }

    const safeUpgrade = await resolveSafeUpgradeVersion(
      pkg.name,
      pkg.version,
      firstPatchedVersion,
      vulnerable.affected.vulnerableRange
    );

    if (!safeUpgrade.safeVersion) {
      return {
        steps: 1,
        result: {
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "no-safe-version",
          message: `No safe override version found for ${pkg.name}.`,
        },
      };
    }

    const overrideResult = (await (applyPackageOverrideTool as any).execute({
      cwd,
      packageManager,
      packageName: pkg.name,
      fromVersion: pkg.version,
      toVersion: safeUpgrade.safeVersion,
      dryRun,
      policy,
      runTests,
      installMode: constraints.installMode,
      installPreferOffline: constraints.installPreferOffline,
      enforceFrozenLockfile: constraints.enforceFrozenLockfile,
      workspace: constraints.workspace,
    })) as PatchResult;

    return {
      steps: 2,
      result: overrideResult,
    };
  }

  if (!firstPatchedVersion) {
    return {
      steps: 0,
      result: {
        packageName: pkg.name,
        strategy: "none",
        fromVersion: pkg.version,
        applied: false,
        dryRun,
        unresolvedReason: "no-safe-version",
        message: `No firstPatchedVersion available for ${pkg.name}; cannot resolve deterministic upgrade in local mode.`,
      },
    };
  }

  const safeUpgrade = await resolveSafeUpgradeVersion(
    pkg.name,
    pkg.version,
    firstPatchedVersion,
    vulnerable.affected.vulnerableRange
  );

  if (!safeUpgrade.safeVersion) {
    return {
      steps: 1,
      result: {
        packageName: pkg.name,
        strategy: "none",
        fromVersion: pkg.version,
        applied: false,
        dryRun,
        unresolvedReason: "no-safe-version",
        message: `No safe upgrade version found for ${pkg.name}.`,
      },
    };
  }

  const applyResult = (await (applyVersionBumpTool as any).execute({
    cwd,
    packageManager,
    packageName: pkg.name,
    fromVersion: pkg.version,
    toVersion: safeUpgrade.safeVersion,
    dryRun,
    policy,
    runTests,
    installMode: constraints.installMode,
    installPreferOffline: constraints.installPreferOffline,
    enforceFrozenLockfile: constraints.enforceFrozenLockfile,
    workspace: constraints.workspace,
  })) as PatchResult;

  return {
    steps: 2,
    result: applyResult,
  };
}
