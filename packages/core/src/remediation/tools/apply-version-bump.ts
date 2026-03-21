/**
 * Tool: apply-version-bump
 *
 * Updates the consumer's package.json to the safe version and runs npm install.
 * Respects --dry-run: in dry-run mode it reports what would happen but writes nothing.
 */
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
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

type DepField = "dependencies" | "devDependencies" | "peerDependencies";

export const applyVersionBumpTool = tool({
  description:
    "Update package.json to use the safe version of a vulnerable package and run the project's package manager install. In dry-run mode, only reports what would change.",
  parameters: z.object({
    cwd: z.string().describe("Absolute path to the consumer project root"),
    packageManager: z.enum(["npm", "pnpm", "yarn"]).optional().describe("Package manager used by the target project (auto-detected if omitted)"),
    packageName: z.string().describe("The npm package to upgrade"),
    fromVersion: z.string().describe("The currently installed vulnerable version"),
    toVersion: z.string().describe("The safe target version to upgrade to"),
    dryRun: z.boolean().default(false).describe("If true, report changes but do not write"),
    policy: z
      .string()
      .optional()
      .describe("Optional path to .autoremediator policy file"),
    runTests: z
      .boolean()
      .default(false)
      .describe("If true, run test validation after applying the fix"),
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
        message: `Policy blocked major bump for "${packageName}" (${fromVersion} -> ${toVersion}).`,
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
        applied: false,
        dryRun,
        message: `Could not read package.json at "${pkgPath}".`,
      };
    }

    // Locate which dependency field this package lives in
    const depField = (["dependencies", "devDependencies", "peerDependencies"] as DepField[]).find(
      (f) => pkgJson[f]?.[packageName] !== undefined
    );

    if (!depField) {
      return {
        packageName,
        strategy: "none",
        fromVersion,
        applied: false,
        dryRun,
        message: `"${packageName}" was not found in package.json dependencies (it may be a transitive dep). Cannot auto-bump.`,
      };
    }

    const currentRange = pkgJson[depField]![packageName]!;

    // Preserve the range prefix (^, ~, empty) from the existing entry
    const prefixMatch = currentRange.match(/^([~^]?)/);
    const prefix = prefixMatch?.[1] ?? "";
    const newRange = `${prefix}${toVersion}`;

    if (dryRun) {
      const installCmd = commands.installPreferOffline.join(" ");
      const testCmd = commands.test.join(" ");
      return {
        packageName,
        strategy: "version-bump",
        fromVersion,
        toVersion,
        applied: false,
        dryRun: true,
        message: `[DRY RUN] Would update ${depField}.${packageName}: "${currentRange}" -> "${newRange}", then run ${installCmd}${runTests ? ` and ${testCmd}` : ""}.`,
      };
    }

    return withRepoLock(cwd, async () => {
      // Write updated package.json
      pkgJson[depField]![packageName] = newRange;
      writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

      // Run package-manager install
      try {
        const [installCmd, ...installArgs] = commands.installPreferOffline;
        await execa(installCmd, installArgs, {
          cwd,
          stdio: "pipe",
        });
      } catch (err) {
        // Revert the package.json change on install failure
        pkgJson[depField]![packageName] = currentRange;
        writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

        const message = err instanceof Error ? err.message : String(err);
        return {
          packageName,
          strategy: "version-bump",
          fromVersion,
          toVersion,
          applied: false,
          dryRun: false,
          message: `${commands.installPreferOffline.join(" ")} failed after updating "${packageName}" to ${toVersion}. Reverted. Error: ${message}`,
        };
      }

      if (runTests) {
        try {
          const [testCmd, ...testArgs] = commands.test;
          await execa(testCmd, testArgs, {
            cwd,
            stdio: "pipe",
          });
        } catch (err) {
          // Roll back both manifest and lock state by restoring dep range and reinstalling.
          pkgJson[depField]![packageName] = currentRange;
          writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

          try {
            const [rollbackCmd, ...rollbackArgs] = commands.installPreferOffline;
            await execa(rollbackCmd, rollbackArgs, {
              cwd,
              stdio: "pipe",
            });
          } catch {
            // Ignore rollback install failure and return original test failure context.
          }

          const message = err instanceof Error ? err.message : String(err);
          return {
            packageName,
            strategy: "version-bump",
            fromVersion,
            toVersion,
            applied: false,
            dryRun: false,
            message: `${commands.test.join(" ")} failed after upgrading "${packageName}" to ${toVersion}. Rolled back to ${currentRange}. Error: ${message}`,
          };
        }
      }

      return {
        packageName,
        strategy: "version-bump",
        fromVersion,
        toVersion,
        applied: true,
        dryRun: false,
        message: `Successfully upgraded "${packageName}" from ${fromVersion} to ${toVersion}, ran ${commands.installPreferOffline.join(" ")}${runTests ? `, and passed ${commands.test.join(" ")}` : ""}.`,
      };
    });
  },
});
