import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import semver from "semver";
import { z } from "zod";

import {
  detectPackageManager,
  getYarnMajorVersion,
  resolveDedupeCommand,
  resolveInstallCommand,
  resolveTestCommand,
  resolveTypecheckCommand,
} from "../../platform/package-manager/index.js";
import { isPackageAllowed, loadPolicy } from "../../platform/policy.js";
import { withRepoLock } from "../../platform/repo-lock.js";
import { safeExecaCommand } from "../../platform/safe-exec-command.js";
import { runCommandCheck } from "../verify/command-check.js";
import { serializeManifest } from "./manifest-format.js";
import { LONG_RUNNING_TIMEOUT_MS } from "../../platform/timeouts.js";
import type {
  PatchResult,
  ProofOfFixPhaseResult,
  ProofOfFixVerification,
} from "../../platform/types.js";
import { findDeclaringWorkspacePackage } from "../../platform/workspace.js";
import {
  assembleProofOfFixVerification,
  prepareReproductionTestFile,
  runProofOfFixPhase,
} from "../proof-of-fix/runner.js";
import { findPackageCallSites } from "../refactor/call-site-finder.js";
import { refactorConsumerCallSites, revertRefactorSnapshots } from "../refactor/codemods.js";
/**
 * Tool: apply-version-bump
 *
 * Updates the consumer's package.json to the safe version and runs npm install.
 * Respects --dry-run: in dry-run mode it reports what would happen but writes nothing.
 */
import { defineTool } from "./tool-compat.js";

interface RawPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

type DepField = "dependencies" | "devDependencies" | "peerDependencies";

export const applyVersionBumpTool = defineTool({
  description:
    "Update package.json to use the safe version of a vulnerable package and run the project's package manager install. In dry-run mode, only reports what would change.",
  inputSchema: z.object({
    cwd: z.string().describe("Absolute path to the consumer project root"),
    packageManager: z
      .enum(["npm", "pnpm", "yarn", "bun", "deno"])
      .optional()
      .describe("Package manager used by the target project (auto-detected if omitted)"),
    packageName: z.string().describe("The npm package to upgrade"),
    fromVersion: z.string().describe("The currently installed vulnerable version"),
    toVersion: z.string().describe("The safe target version to upgrade to"),
    dryRun: z.boolean().default(false).describe("If true, report changes but do not write"),
    policy: z.string().optional().describe("Optional path to .autoremediator policy file"),
    runTests: z
      .boolean()
      .default(false)
      .describe("If true, run test validation after applying the fix"),
    typecheck: z
      .boolean()
      .default(false)
      .describe("If true, run typecheck validation after applying the fix"),
    installMode: z.enum(["standard", "prefer-offline", "deterministic"]).optional(),
    installPreferOffline: z.boolean().optional(),
    enforceFrozenLockfile: z.boolean().optional(),
    workspace: z.string().optional(),
    breakingChangeRefactor: z
      .boolean()
      .optional()
      .describe(
        "If true, attempt agentic call-site refactoring when validation fails after major upgrade",
      ),
    reproductionTest: z
      .string()
      .optional()
      .describe("Optional reproduction test script verifying fix"),
    proofOfFix: z
      .union([z.boolean(), z.string()])
      .optional()
      .describe("If true or script path/content, enforce dual-stage exploit reproduction"),
    requireProofOfFix: z
      .boolean()
      .optional()
      .describe("If true, fail and rollback version bump if proof-of-fix verification fails"),
    patchesDir: z
      .string()
      .optional()
      .default("./patches")
      .describe("Directory containing patch/reproduction artifacts"),
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
    typecheck,
    installMode,
    installPreferOffline,
    enforceFrozenLockfile,
    workspace,
    breakingChangeRefactor,
    reproductionTest,
    proofOfFix,
    requireProofOfFix,
    patchesDir,
  }): Promise<PatchResult> => {
    const pm = packageManager ?? detectPackageManager(cwd);

    let pkgPath = join(cwd, "package.json");
    const loadedPolicy = loadPolicy(cwd, policy);
    const commandConstraints = {
      ...loadedPolicy.constraints,
      installMode: installMode ?? loadedPolicy.constraints?.installMode,
      installPreferOffline: installPreferOffline ?? loadedPolicy.constraints?.installPreferOffline,
      enforceFrozenLockfile:
        enforceFrozenLockfile ?? loadedPolicy.constraints?.enforceFrozenLockfile,
      workspace: workspace ?? loadedPolicy.constraints?.workspace,
    };
    const yarnMajor = pm === "yarn" ? await getYarnMajorVersion(cwd) : undefined;

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
        message: `Policy blocked major bump for "${packageName}" (${fromVersion} -> ${toVersion}).`,
      };
    }

    pkgPath = join(cwd, "package.json");
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
        unresolvedReason: "package-json-not-found",
        message: `Could not read package.json at "${pkgPath}".`,
      };
    }

    // Locate which dependency field this package lives in
    let depField = (["dependencies", "devDependencies", "peerDependencies"] as DepField[]).find(
      (f) => pkgJson[f]?.[packageName] !== undefined,
    );

    if (!depField) {
      // Check monorepo child workspaces
      const declaringWorkspace = findDeclaringWorkspacePackage(cwd, packageName, workspace);
      if (declaringWorkspace) {
        pkgPath = declaringWorkspace.manifestPath;
        pkgJson = declaringWorkspace.manifest;
        depField = (["dependencies", "devDependencies", "peerDependencies"] as DepField[]).find(
          (f) => pkgJson[f]?.[packageName] !== undefined,
        );
        commandConstraints.workspace = workspace ?? declaringWorkspace.name;
      }
    }

    if (!depField) {
      return {
        packageName,
        strategy: "none",
        fromVersion,
        applied: false,
        dryRun,
        unresolvedReason: "transitive-dependency",
        message: `"${packageName}" was not found in package.json dependencies (it may be a transitive dependency). Cannot auto-bump.`,
      };
    }

    const currentRange = pkgJson[depField]![packageName]!;

    // Preserve the range prefix (^, ~, empty) from the existing entry
    const prefixMatch = /^([~^]?)/.exec(currentRange);
    const prefix = prefixMatch?.[1] ?? "";
    // A downgrade (pinning a release back) must be exact: the package manager keeps a locked newer
    // version that the old range still allows, so `^1.0.0` would change nothing.
    const isDowngrade =
      semver.valid(fromVersion) && semver.valid(toVersion) && semver.lt(toVersion, fromVersion);
    const newRange = isDowngrade ? toVersion : `${prefix}${toVersion}`;

    const effectiveInstallCommand = resolveInstallCommand(pm, commandConstraints, yarnMajor);
    const effectiveTestCommand = resolveTestCommand(pm, commandConstraints);
    const effectiveTypecheckCommand = resolveTypecheckCommand(pm, commandConstraints, cwd);
    const effectiveDedupeCommand = resolveDedupeCommand(pm, commandConstraints);
    const shouldTypecheck = typecheck || Boolean(commandConstraints.typecheck);

    if (dryRun) {
      const installCmd = effectiveInstallCommand.join(" ");
      const testCmd = effectiveTestCommand.join(" ");
      return {
        packageName,
        strategy: "version-bump",
        fromVersion,
        toVersion,
        applied: false,
        dryRun: true,
        message: `[DRY RUN] Would update ${depField}.${packageName}: "${currentRange}" -> "${newRange}", then run ${installCmd}${runTests ? ` and ${testCmd}` : ""}${effectiveDedupeCommand.length > 0 ? ` and ${effectiveDedupeCommand.join(" ")} (best-effort)` : ""}.`,
      };
    }

    return withRepoLock(cwd, async () => {
      const prepared = await prepareReproductionTestFile({
        cwd,
        packageName,
        vulnerableVersion: fromVersion,
        patchesDir,
        proofOfFix,
        reproductionTest,
      });
      const reproTestPath = prepared.testFilePath;
      const isProofActive = Boolean(reproTestPath || proofOfFix || requireProofOfFix);

      let negativePhaseResult: ProofOfFixPhaseResult | undefined;
      if (isProofActive) {
        if (!reproTestPath) {
          if (requireProofOfFix) {
            return {
              packageName,
              strategy: "none",
              fromVersion,
              toVersion,
              applied: false,
              dryRun,
              unresolvedReason: "policy-blocked",
              message:
                "Proof-of-fix verification required, but no reproduction test or script was supplied.",
            };
          }
        } else {
          negativePhaseResult = await runProofOfFixPhase({
            stage: "negative",
            testFilePath: reproTestPath,
            cwd,
          });

          if (!negativePhaseResult.passed) {
            if (prepared.isCreated && reproTestPath) {
              await rm(reproTestPath, { force: true }).catch(() => {});
            }
            return {
              packageName,
              strategy: "version-bump",
              fromVersion,
              toVersion,
              applied: false,
              dryRun: false,
              unresolvedReason: requireProofOfFix ? "policy-blocked" : "proof-of-fix-failed",
              message: `Proof-of-fix negative phase failed: ${negativePhaseResult.error}`,
            };
          }
        }
      }

      // Write updated package.json, keeping the file's own formatting; a failed upgrade puts the
      // original bytes back, so nothing about it shows up in a diff.
      const originalManifest = readFileSync(pkgPath, "utf8");
      pkgJson[depField]![packageName] = newRange;
      writeFileSync(pkgPath, serializeManifest(originalManifest, pkgJson), "utf8");

      // Run package-manager install
      try {
        await safeExecaCommand(effectiveInstallCommand, {
          timeoutMs: LONG_RUNNING_TIMEOUT_MS,
          cwd,
          stdio: "pipe",
        });
      } catch (err) {
        // Revert the package.json change on install failure
        writeFileSync(pkgPath, originalManifest, "utf8");

        const message = err instanceof Error ? err.message : String(err);
        return {
          packageName,
          strategy: "version-bump",
          fromVersion,
          toVersion,
          applied: false,
          dryRun: false,
          unresolvedReason: "install-failed",
          message: `${effectiveInstallCommand.join(" ")} failed after updating "${packageName}" to ${toVersion}. Reverted. Error: ${message}`,
        };
      }

      const shouldAttemptRefactor = Boolean(
        breakingChangeRefactor ?? loadedPolicy.constraints?.enableBreakingChangeRefactor,
      );

      async function runValidationSteps(): Promise<{
        passed: boolean;
        error?: string;
        isTypecheck?: boolean;
      }> {
        if (runTests) {
          const outcome = await runCommandCheck(effectiveTestCommand, cwd);
          if (!outcome.passed) return { passed: false, error: outcome.output };
        }
        if (shouldTypecheck && effectiveTypecheckCommand.length > 0) {
          const outcome = await runCommandCheck(effectiveTypecheckCommand, cwd);
          if (!outcome.passed) return { passed: false, isTypecheck: true, error: outcome.output };
        }
        return { passed: true };
      }

      let validationResult = await runValidationSteps();
      let refactoredFilesList: string[] | undefined;

      if (!validationResult.passed && shouldAttemptRefactor) {
        const callSites = findPackageCallSites(cwd, packageName);
        if (callSites.length > 0) {
          const refactorAttempt = await refactorConsumerCallSites({
            cwd,
            packageName,
            fromVersion,
            toVersion,
            diagnosticError: validationResult.error || "",
            callSites,
          });

          if (refactorAttempt.applied) {
            const postRefactorValidation = await runValidationSteps();
            if (postRefactorValidation.passed) {
              validationResult = { passed: true };
              refactoredFilesList = refactorAttempt.refactoredFiles;
            } else {
              revertRefactorSnapshots(refactorAttempt.snapshots);
            }
          }
        }
      }

      if (!validationResult.passed) {
        writeFileSync(pkgPath, originalManifest, "utf8");

        try {
          await safeExecaCommand(effectiveInstallCommand, {
            timeoutMs: LONG_RUNNING_TIMEOUT_MS,
            cwd,
            stdio: "pipe",
          });
        } catch {}

        const failureMessage = validationResult.error || "Unknown validation error";
        const failurePrefix = validationResult.isTypecheck
          ? `TypeCheck validation failed (${effectiveTypecheckCommand.join(" ")})`
          : `${effectiveTestCommand.join(" ")} failed`;

        return {
          packageName,
          strategy: "version-bump",
          fromVersion,
          toVersion,
          applied: false,
          dryRun: false,
          unresolvedReason: shouldAttemptRefactor
            ? "breaking-change-unresolved"
            : "validation-failed",
          message: `${failurePrefix} after upgrading "${packageName}" to ${toVersion}. Rolled back to ${currentRange}. Error: ${failureMessage}`,
        };
      }

      let proofOfFixVerification: ProofOfFixVerification | undefined;
      if (reproTestPath && negativePhaseResult?.passed) {
        const positivePhaseResult = await runProofOfFixPhase({
          stage: "positive",
          testFilePath: reproTestPath,
          cwd,
        });

        if (!positivePhaseResult.passed) {
          writeFileSync(pkgPath, originalManifest, "utf8");

          try {
            await safeExecaCommand(effectiveInstallCommand, {
              timeoutMs: LONG_RUNNING_TIMEOUT_MS,
              cwd,
              stdio: "pipe",
            });
          } catch {}

          if (prepared.isCreated && reproTestPath) {
            await rm(reproTestPath, { force: true }).catch(() => {});
          }

          return {
            packageName,
            strategy: "version-bump",
            fromVersion,
            toVersion,
            applied: false,
            dryRun: false,
            unresolvedReason: requireProofOfFix ? "policy-blocked" : "proof-of-fix-failed",
            message: `Proof-of-fix positive phase failed: ${positivePhaseResult.error}`,
          };
        }

        proofOfFixVerification = assembleProofOfFixVerification({
          reproductionTestPath: reproTestPath,
          negativePhase: negativePhaseResult,
          positivePhase: positivePhaseResult,
          regressionPhase: {
            executed: runTests,
            passed: validationResult.passed,
          },
        });
      }

      if (refactoredFilesList && refactoredFilesList.length > 0) {
        return {
          packageName,
          strategy: "breaking-change-refactor",
          fromVersion,
          toVersion,
          applied: true,
          dryRun: false,
          refactoredFiles: refactoredFilesList,
          proofOfFix: proofOfFixVerification,
          message: `Upgraded "${packageName}" from ${fromVersion} to ${toVersion} and refactored ${refactoredFilesList.length} call-site file(s) across breaking API changes.`,
        };
      }

      let dedupeNote = "";

      if (effectiveDedupeCommand.length > 0) {
        try {
          await safeExecaCommand(effectiveDedupeCommand, {
            timeoutMs: LONG_RUNNING_TIMEOUT_MS,
            cwd,
            stdio: "pipe",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          dedupeNote = ` Dedupe warning: ${effectiveDedupeCommand.join(" ")} failed (${message}).`;
        }
      }

      return {
        packageName,
        strategy: "version-bump",
        fromVersion,
        toVersion,
        applied: true,
        dryRun: false,
        proofOfFix: proofOfFixVerification,
        message: `Successfully upgraded "${packageName}" from ${fromVersion} to ${toVersion} in ${depField}, then ran ${effectiveInstallCommand.join(" ")}${runTests ? ` and passed ${effectiveTestCommand.join(" ")}` : ""}.${dedupeNote}`,
      };
    });
  },
});
