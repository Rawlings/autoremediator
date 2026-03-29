import { tool } from "ai";
import { z } from "zod";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { execa } from "execa";
import semver from "semver";
import type { PatchResult } from "../../platform/types.js";
import { isPackageAllowed, loadPolicy } from "../../platform/policy.js";
import { withRepoLock } from "../../platform/repo-lock.js";
import {
  detectPackageManager,
  getPackageManagerCommands,
  type PackageManager,
} from "../../platform/package-manager.js";

interface RawPackageJson {
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const applyPackageOverrideTool = tool({
  description:
    "Apply a package-manager-native package.json override for a vulnerable transitive dependency and reinstall. Uses npm overrides, pnpm.overrides, or yarn resolutions.",
  parameters: z.object({
    cwd: z.string().describe("Absolute path to the consumer project root"),
    packageManager: z.enum(["npm", "pnpm", "yarn"]).optional().describe("Package manager used by the target project (auto-detected if omitted)"),
    packageName: z.string().describe("The npm package to override"),
    fromVersion: z.string().describe("The currently installed vulnerable version"),
    toVersion: z.string().describe("The safe target version to override to"),
    dryRun: z.boolean().default(false).describe("If true, report changes but do not write"),
    policy: z.string().optional().describe("Optional path to .autoremediator policy file"),
    runTests: z.boolean().default(false).describe("If true, run test validation after applying the override"),
  }),
  execute: async ({
    cwd,
    packageManager,
    packageName,
    fromVersion,
    toVersion,
    dryRun,
    policy,
    runTests,
  }): Promise<PatchResult> => {
    const pm = (packageManager ?? detectPackageManager(cwd)) as PackageManager;
    const commands = getPackageManagerCommands(pm);
    const pkgPath = join(cwd, "package.json");
    const loadedPolicy = loadPolicy(cwd, policy);

    if (!isPackageAllowed(loadedPolicy, packageName)) {
      return {
        packageName,
        strategy: "none",
        fromVersion,
        toVersion,
        applied: false,
        dryRun,
        unresolvedReason: "policy-blocked",
        message: `Policy blocked changes for package "${packageName}".`,
      };
    }

    const isMajorBump =
      semver.valid(fromVersion) &&
      semver.valid(toVersion) &&
      semver.major(toVersion) > semver.major(fromVersion);

    if (isMajorBump && !loadedPolicy.allowMajorBumps) {
      return {
        packageName,
        strategy: "none",
        fromVersion,
        toVersion,
        applied: false,
        dryRun,
        unresolvedReason: "major-bump-required",
        message: `Policy blocked major override for "${packageName}" (${fromVersion} -> ${toVersion}).`,
      };
    }

    let pkgJson: RawPackageJson;
    try {
      pkgJson = JSON.parse(readFileSync(pkgPath, "utf8")) as RawPackageJson;
    } catch {
      return {
        packageName,
        strategy: "none",
        fromVersion,
        toVersion,
        applied: false,
        dryRun,
        unresolvedReason: "package-json-not-found",
        message: `Could not read package.json at "${pkgPath}".`,
      };
    }

    const overrideLabel = describeOverrideField(pm);
    const previousValue = getOverrideValue(pkgJson, pm, packageName);

    if (dryRun) {
      return {
        packageName,
        strategy: "override",
        fromVersion,
        toVersion,
        applied: false,
        dryRun: true,
        message: `[DRY RUN] Would set ${overrideLabel}.${packageName} to "${toVersion}", then run ${commands.installPreferOffline.join(" ")}${runTests ? ` and ${commands.test.join(" ")}` : ""}.`,
      };
    }

    return withRepoLock(cwd, async () => {
      setOverrideValue(pkgJson, pm, packageName, toVersion);
      writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

      try {
        const [installCmd, ...installArgs] = commands.installPreferOffline;
        await execa(installCmd, installArgs, { cwd, stdio: "pipe" });
      } catch (err) {
        restoreOverrideValue(pkgJson, pm, packageName, previousValue);
        writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
        const message = err instanceof Error ? err.message : String(err);
        return {
          packageName,
          strategy: "override",
          fromVersion,
          toVersion,
          applied: false,
          dryRun: false,
          unresolvedReason: "override-apply-failed",
          message: `${commands.installPreferOffline.join(" ")} failed after applying ${overrideLabel} for "${packageName}" to ${toVersion}. Reverted. Error: ${message}`,
        };
      }

      if (runTests) {
        try {
          const [testCmd, ...testArgs] = commands.test;
          await execa(testCmd, testArgs, { cwd, stdio: "pipe" });
        } catch (err) {
          restoreOverrideValue(pkgJson, pm, packageName, previousValue);
          writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

          try {
            const [rollbackCmd, ...rollbackArgs] = commands.installPreferOffline;
            await execa(rollbackCmd, rollbackArgs, { cwd, stdio: "pipe" });
          } catch {
            // Ignore rollback install failure and return original test failure context.
          }

          const message = err instanceof Error ? err.message : String(err);
          return {
            packageName,
            strategy: "override",
            fromVersion,
            toVersion,
            applied: false,
            dryRun: false,
            unresolvedReason: "validation-failed",
            message: `${commands.test.join(" ")} failed after applying ${overrideLabel} for "${packageName}" to ${toVersion}. Reverted. Error: ${message}`,
          };
        }
      }

      return {
        packageName,
        strategy: "override",
        fromVersion,
        toVersion,
        applied: true,
        dryRun: false,
        message: `Successfully applied ${overrideLabel} for "${packageName}" from ${fromVersion} to ${toVersion}, then ran ${commands.installPreferOffline.join(" ")}${runTests ? ` and passed ${commands.test.join(" ")}` : ""}.`,
      };
    });
  },
});

function describeOverrideField(packageManager: PackageManager): string {
  if (packageManager === "npm") return "overrides";
  if (packageManager === "pnpm") return "pnpm.overrides";
  return "resolutions";
}

function getOverrideValue(
  pkgJson: RawPackageJson,
  packageManager: PackageManager,
  packageName: string
): string | undefined {
  if (packageManager === "npm") return pkgJson.overrides?.[packageName];
  if (packageManager === "pnpm") return pkgJson.pnpm?.overrides?.[packageName];
  return pkgJson.resolutions?.[packageName];
}

function setOverrideValue(
  pkgJson: RawPackageJson,
  packageManager: PackageManager,
  packageName: string,
  version: string
): void {
  if (packageManager === "npm") {
    pkgJson.overrides = { ...(pkgJson.overrides ?? {}), [packageName]: version };
    return;
  }

  if (packageManager === "pnpm") {
    pkgJson.pnpm = {
      ...(pkgJson.pnpm ?? {}),
      overrides: {
        ...(pkgJson.pnpm?.overrides ?? {}),
        [packageName]: version,
      },
    };
    return;
  }

  pkgJson.resolutions = { ...(pkgJson.resolutions ?? {}), [packageName]: version };
}

function restoreOverrideValue(
  pkgJson: RawPackageJson,
  packageManager: PackageManager,
  packageName: string,
  previousValue?: string
): void {
  if (packageManager === "npm") {
    pkgJson.overrides = restoreRecord(pkgJson.overrides, packageName, previousValue);
    return;
  }

  if (packageManager === "pnpm") {
    pkgJson.pnpm = {
      ...(pkgJson.pnpm ?? {}),
      overrides: restoreRecord(pkgJson.pnpm?.overrides, packageName, previousValue),
    };
    if (!pkgJson.pnpm.overrides) {
      delete pkgJson.pnpm.overrides;
    }
    if (Object.keys(pkgJson.pnpm).length === 0) {
      delete pkgJson.pnpm;
    }
    return;
  }

  pkgJson.resolutions = restoreRecord(pkgJson.resolutions, packageName, previousValue);
}

function restoreRecord(
  record: Record<string, string> | undefined,
  key: string,
  previousValue?: string
): Record<string, string> | undefined {
  const nextRecord = { ...(record ?? {}) };

  if (previousValue === undefined) {
    delete nextRecord[key];
  } else {
    nextRecord[key] = previousValue;
  }

  return Object.keys(nextRecord).length > 0 ? nextRecord : undefined;
}