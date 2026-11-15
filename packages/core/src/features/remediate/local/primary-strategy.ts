import { loadRegistryConfig } from "../../../infra/http/registry-config.js";
import { readCooldown, withCooldown } from "../../../infra/package-manager/cooldown.js";
import type { RemediationConstraints } from "../../../infra/policy/types.js";
import type { PackageManager } from "../../../shared/types.js";
import type { VulnerablePackage } from "../../intelligence/types.js";
import { applyPackageOverrideTool } from "../../upgrade/apply-package-override/index.js";
import { applyVersionBumpTool } from "../../upgrade/apply-version-bump.js";
import type { PatchResult } from "../types.js";
import { describeSkipped, selectUpgradeTarget } from "./select-target.js";

/** Every fixed version was rejected in an earlier run: nothing to propose until a person says otherwise. */
function memoryBlocked(
  pkg: VulnerablePackage["installed"],
  target: { version: string; reason: string },
  dryRun: boolean,
  vulnerable: VulnerablePackage,
): PatchResult {
  return {
    packageName: pkg.name,
    strategy: "none",
    fromVersion: pkg.version,
    applied: false,
    dryRun,
    unresolvedReason: "constraint-blocked",
    vulnerableRange: vulnerable.affected.vulnerableRange,
    message: `Remediation memory blocks every fixed version of "${pkg.name}": ${target.reason}. Remove the entry with \`autoremediator memory remove\`, or pass --ignore-memory.`,
  };
}

export async function resolvePrimaryResult(params: {
  vulnerable: VulnerablePackage;
  cwd: string;
  packageManager: PackageManager;
  dryRun: boolean;
  policy: string;
  runTests: boolean;
  constraints: RemediationConstraints;
  proofOfFix?: boolean | string;
  requireProofOfFix?: boolean;
  reproductionTest?: string;
  patchesDir?: string;
  /** Offline intelligence runs skip the advisory lookup on candidate versions. */
  offlineIntelligence?: boolean;
  /** Versions of this package remediation memory says were rejected, with why. */
  rejectedVersions?: ReadonlyMap<string, string>;
}): Promise<{ result: PatchResult }> {
  const {
    vulnerable,
    cwd,
    packageManager,
    dryRun,
    policy,
    runTests,
    constraints,
    proofOfFix,
    requireProofOfFix = constraints.requireProofOfFix,
    reproductionTest,
    patchesDir,
    offlineIntelligence,
    rejectedVersions,
  } = params;
  const pkg = vulnerable.installed;
  const firstPatchedVersion = vulnerable.affected.firstPatchedVersion;
  const registry = loadRegistryConfig(cwd);
  const cooldown = readCooldown(cwd, packageManager);

  if (pkg.type === "transitive") {
    if (constraints.directDependenciesOnly) {
      return {
        result: {
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "constraint-blocked",
          message: `Constraint blocked remediation for transitive dependency "${pkg.name}".`,
        },
      };
    }

    if (constraints.preferVersionBump) {
      return {
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
        result: {
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "no-safe-version",
          vulnerableRange: vulnerable.affected.vulnerableRange,
          message: `No firstPatchedVersion available for ${pkg.name}; cannot resolve deterministic override in local mode.`,
        },
      };
    }

    const target = await selectUpgradeTarget({
      packageName: pkg.name,
      installedVersion: pkg.version,
      firstPatchedVersion,
      vulnerableRange: vulnerable.affected.vulnerableRange,
      registry,
      supplyChainPolicy: withCooldown(constraints.supplyChainPolicy, cooldown, pkg.name),
      offline: offlineIntelligence,
      rejected: rejectedVersions,
    });

    if (target.status === "memory-blocked")
      return { result: memoryBlocked(pkg, target, dryRun, vulnerable) };

    if (target.status === "no-safe-version") {
      return {
        result: {
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "no-safe-version",
          vulnerableRange: vulnerable.affected.vulnerableRange,
          message: `No safe override version found for ${pkg.name}.`,
        },
      };
    }

    if (target.status === "trust-blocked") {
      return {
        result: {
          packageName: pkg.name,
          strategy: "none",
          fromVersion: pkg.version,
          applied: false,
          dryRun,
          unresolvedReason: "policy-blocked",
          vulnerableRange: vulnerable.affected.vulnerableRange,
          message: `Supply chain trust gate blocked "${pkg.name}@${target.version}": ${target.reason}`,
        },
      };
    }

    const overrideResult = await applyPackageOverrideTool.execute({
      cwd,
      packageManager,
      packageName: pkg.name,
      fromVersion: pkg.version,
      toVersion: target.version,
      dryRun,
      policy,
      runTests,
      installMode: constraints.installMode,
      installPreferOffline: constraints.installPreferOffline,
      enforceFrozenLockfile: constraints.enforceFrozenLockfile,
      workspace: constraints.workspace,
      proofOfFix,
      requireProofOfFix,
      reproductionTest,
      patchesDir,
    });

    return {
      result: {
        ...overrideResult,
        vulnerableRange: vulnerable.affected.vulnerableRange,
        message: `${overrideResult.message}${describeSkipped(target.skipped)}`,
      },
    };
  }

  if (!firstPatchedVersion) {
    return {
      result: {
        packageName: pkg.name,
        strategy: "none",
        fromVersion: pkg.version,
        applied: false,
        dryRun,
        unresolvedReason: "no-safe-version",
        vulnerableRange: vulnerable.affected.vulnerableRange,
        message: `No firstPatchedVersion available for ${pkg.name}; cannot resolve deterministic upgrade in local mode.`,
      },
    };
  }

  const target = await selectUpgradeTarget({
    packageName: pkg.name,
    installedVersion: pkg.version,
    firstPatchedVersion,
    vulnerableRange: vulnerable.affected.vulnerableRange,
    registry,
    supplyChainPolicy: withCooldown(constraints.supplyChainPolicy, cooldown, pkg.name),
    offline: offlineIntelligence,
    rejected: rejectedVersions,
  });

  if (target.status === "memory-blocked")
    return { result: memoryBlocked(pkg, target, dryRun, vulnerable) };

  if (target.status === "no-safe-version") {
    return {
      result: {
        packageName: pkg.name,
        strategy: "none",
        fromVersion: pkg.version,
        applied: false,
        dryRun,
        unresolvedReason: "no-safe-version",
        vulnerableRange: vulnerable.affected.vulnerableRange,
        message: `No safe upgrade version found for ${pkg.name}.`,
      },
    };
  }

  if (target.status === "trust-blocked") {
    return {
      result: {
        packageName: pkg.name,
        strategy: "none",
        fromVersion: pkg.version,
        applied: false,
        dryRun,
        unresolvedReason: "policy-blocked",
        vulnerableRange: vulnerable.affected.vulnerableRange,
        message: `Supply chain trust gate blocked "${pkg.name}@${target.version}": ${target.reason}`,
      },
    };
  }

  const applyResult = await applyVersionBumpTool.execute({
    cwd,
    packageManager,
    packageName: pkg.name,
    fromVersion: pkg.version,
    toVersion: target.version,
    dryRun,
    policy,
    runTests,
    typecheck: constraints.typecheck,
    installMode: constraints.installMode,
    installPreferOffline: constraints.installPreferOffline,
    enforceFrozenLockfile: constraints.enforceFrozenLockfile,
    workspace: constraints.workspace,
    breakingChangeRefactor: constraints.enableBreakingChangeRefactor,
    proofOfFix,
    requireProofOfFix,
    reproductionTest,
    patchesDir,
  });

  return {
    result: {
      ...applyResult,
      vulnerableRange: vulnerable.affected.vulnerableRange,
      message: `${applyResult.message}${describeSkipped(target.skipped)}`,
    },
  };
}
