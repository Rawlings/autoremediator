import { defineTool } from "../tool-compat.js";
import { z } from "zod";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { safeExeca } from "../../../platform/safe-exec.js";
import semver from "semver";
import type {
  PatchResult,
  ProofOfFixPhaseResult,
  ProofOfFixVerification,
} from "../../../platform/types.js";
import {
  assembleProofOfFixVerification,
  prepareReproductionTestFile,
  runProofOfFixPhase,
} from "../../proof-of-fix/runner.js";
import { isPackageAllowed, loadPolicy } from "../../../platform/policy.js";
import { withRepoLock } from "../../../platform/repo-lock.js";
import {
  detectPackageManager,
  getYarnMajorVersion,
  resolveDedupeCommand,
  resolveInstallCommand,
  resolveTestCommand,
  type PackageManager,
} from "../../../platform/package-manager/index.js";
import {
  collectDependencyTrace,
  describeOverrideField,
  getDenoJsonImportValue,
  getOverrideValue,
  restoreDenoJsonImportValue,
  restoreOverrideValue,
  setDenoJsonImportValue,
  setOverrideValue,
  type DenoJson,
  type RawPackageJson,
} from "./helpers.js";

export const applyPackageOverrideTool = defineTool({
  description:
    "Apply a package-manager-native package.json override for a vulnerable transitive dependency and reinstall. Uses npm overrides, pnpm.overrides, yarn resolutions, bun overrides, or deno.json imports.",
  parameters: z.object({
    cwd: z.string().describe("Absolute path to the consumer project root"),
    packageManager: z
      .enum(["npm", "pnpm", "yarn", "bun", "deno"])
      .optional()
      .describe("Package manager used by the target project (auto-detected if omitted)"),
    packageName: z.string().describe("The npm package to override"),
    selector: z
      .string()
      .optional()
      .describe("Optional manager-native override selector key (for nested or scoped overrides)"),
    fromVersion: z.string().describe("The currently installed vulnerable version"),
    toVersion: z.string().describe("The safe target version to override to"),
    dryRun: z.boolean().default(false).describe("If true, report changes but do not write"),
    policy: z.string().optional().describe("Optional path to .autoremediator policy file"),
    runTests: z
      .boolean()
      .default(false)
      .describe("If true, run test validation after applying the override"),
    installMode: z.enum(["standard", "prefer-offline", "deterministic"]).optional(),
    installPreferOffline: z.boolean().optional(),
    enforceFrozenLockfile: z.boolean().optional(),
    workspace: z.string().optional(),
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
      .describe("If true, fail and rollback override if proof-of-fix verification fails"),
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
    selector,
    fromVersion,
    toVersion,
    dryRun,
    policy,
    runTests,
    installMode,
    installPreferOffline,
    enforceFrozenLockfile,
    workspace,
    reproductionTest,
    proofOfFix,
    requireProofOfFix,
    patchesDir,
  }): Promise<PatchResult> => {
    const pm = (packageManager ?? detectPackageManager(cwd)) as PackageManager;
    const pkgPath = join(cwd, "package.json");
    const denoJsonPath = join(cwd, "deno.json");
    const isDenoNative = pm === "deno" && !existsSync(pkgPath);
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
    const installCommand = resolveInstallCommand(pm, commandConstraints, yarnMajor);
    const testCommand = resolveTestCommand(pm, commandConstraints);
    const dedupeCommand = resolveDedupeCommand(pm, commandConstraints);
    const overrideSelector = selector?.trim() || packageName;

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

    // ---- Deno native path (deno.json import map, no package.json) ----
    if (isDenoNative) {
      let denoJson: DenoJson;
      try {
        denoJson = JSON.parse(readFileSync(denoJsonPath, "utf8")) as DenoJson;
      } catch {
        return {
          packageName,
          strategy: "none",
          fromVersion,
          toVersion,
          applied: false,
          dryRun,
          unresolvedReason: "package-json-not-found",
          message: `Could not read deno.json at "${denoJsonPath}".`,
        };
      }

      const existingEntry = getDenoJsonImportValue(denoJson, overrideSelector);
      if (!existingEntry) {
        return {
          packageName,
          strategy: "none",
          fromVersion,
          toVersion,
          applied: false,
          dryRun,
          unresolvedReason: "transitive-override-unsupported-deno-native",
          message: `Cannot apply transitive override for "${overrideSelector}" in a native Deno project (no package.json). Only direct dependencies declared in deno.json imports can be overridden.`,
        };
      }

      const dependencyTrace = await collectDependencyTrace(
        cwd,
        pm,
        packageName,
        commandConstraints,
      );
      const dependencyTraceSuffix = dependencyTrace ? ` Dependency trace: ${dependencyTrace}` : "";

      if (dryRun) {
        return {
          packageName,
          strategy: "override",
          fromVersion,
          toVersion,
          applied: false,
          dryRun: true,
          message: `[DRY RUN] Would update deno.json imports["${existingEntry.key}"] to "npm:${overrideSelector}@${toVersion}", then run ${installCommand.join(" ")}.${dependencyTraceSuffix}`,
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
                strategy: "override",
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

        setDenoJsonImportValue(denoJson, overrideSelector, toVersion);
        writeFileSync(denoJsonPath, JSON.stringify(denoJson, null, 2) + "\n", "utf8");

        try {
          const [installCmd, ...installArgs] = installCommand;
          await safeExeca(installCmd, installArgs, { cwd, stdio: "pipe" });
        } catch (err) {
          restoreDenoJsonImportValue(denoJson, overrideSelector, existingEntry);
          writeFileSync(denoJsonPath, JSON.stringify(denoJson, null, 2) + "\n", "utf8");
          const message = err instanceof Error ? err.message : String(err);
          return {
            packageName,
            strategy: "override",
            fromVersion,
            toVersion,
            applied: false,
            dryRun: false,
            unresolvedReason: "override-apply-failed",
            message: `${installCommand.join(" ")} failed after updating deno.json imports for "${overrideSelector}" to ${toVersion}. Reverted. Error: ${message}${dependencyTraceSuffix}`,
          };
        }

        if (runTests) {
          try {
            const [testCmd, ...testArgs] = testCommand;
            await safeExeca(testCmd, testArgs, { cwd, stdio: "pipe" });
          } catch (err) {
            restoreDenoJsonImportValue(denoJson, overrideSelector, existingEntry);
            writeFileSync(denoJsonPath, JSON.stringify(denoJson, null, 2) + "\n", "utf8");

            try {
              const [rollbackCmd, ...rollbackArgs] = installCommand;
              await safeExeca(rollbackCmd, rollbackArgs, { cwd, stdio: "pipe" });
            } catch {
              // Ignore rollback failure.
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
              message: `${testCommand.join(" ")} failed after updating deno.json imports for "${overrideSelector}" to ${toVersion}. Reverted. Error: ${message}${dependencyTraceSuffix}`,
            };
          }
        }

        let proofOfFixVerification: ProofOfFixVerification | undefined;
        if (reproTestPath && negativePhaseResult?.passed) {
          const positivePhaseResult = await runProofOfFixPhase({
            stage: "positive",
            testFilePath: reproTestPath,
            cwd,
          });

          if (!positivePhaseResult.passed) {
            restoreDenoJsonImportValue(denoJson, overrideSelector, existingEntry);
            writeFileSync(denoJsonPath, JSON.stringify(denoJson, null, 2) + "\n", "utf8");

            try {
              const [rollbackCmd, ...rollbackArgs] = installCommand;
              await safeExeca(rollbackCmd, rollbackArgs, { cwd, stdio: "pipe" });
            } catch {}

            if (prepared.isCreated && reproTestPath) {
              await rm(reproTestPath, { force: true }).catch(() => {});
            }

            return {
              packageName,
              strategy: "override",
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
              passed: true,
            },
          });
        }

        return {
          packageName,
          strategy: "override",
          fromVersion,
          toVersion,
          applied: true,
          dryRun: false,
          proofOfFix: proofOfFixVerification,
          message: `Successfully updated deno.json imports["${existingEntry.key}"] for "${overrideSelector}" from ${fromVersion} to ${toVersion}, then ran ${installCommand.join(" ")}${runTests ? ` and passed ${testCommand.join(" ")}` : ""}.${dependencyTraceSuffix}`,
        };
      });
    }

    // ---- npm / pnpm / yarn / bun / deno-npm-compat path ----
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
    const previousValue = getOverrideValue(pkgJson, pm, overrideSelector);

    const dependencyTrace = await collectDependencyTrace(cwd, pm, packageName, commandConstraints);
    const dependencyTraceSuffix = dependencyTrace ? ` Dependency trace: ${dependencyTrace}` : "";

    if (dryRun) {
      return {
        packageName,
        strategy: "override",
        fromVersion,
        toVersion,
        applied: false,
        dryRun: true,
        message: `[DRY RUN] Would set ${overrideLabel}.${overrideSelector} to "${toVersion}", then run ${installCommand.join(" ")}${runTests ? ` and ${testCommand.join(" ")}` : ""}${dedupeCommand.length > 0 ? ` and ${dedupeCommand.join(" ")} (best-effort)` : ""}.${dependencyTraceSuffix}`,
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
              strategy: "override",
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

      setOverrideValue(pkgJson, pm, overrideSelector, toVersion);
      writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

      try {
        const [installCmd, ...installArgs] = installCommand;
        await safeExeca(installCmd, installArgs, { cwd, stdio: "pipe" });
      } catch (err) {
        restoreOverrideValue(pkgJson, pm, overrideSelector, previousValue);
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
          message: `${installCommand.join(" ")} failed after applying ${overrideLabel} for "${overrideSelector}" to ${toVersion}. Reverted. Error: ${message}${dependencyTraceSuffix}`,
        };
      }

      if (runTests) {
        try {
          const [testCmd, ...testArgs] = testCommand;
          await safeExeca(testCmd, testArgs, { cwd, stdio: "pipe" });
        } catch (err) {
          restoreOverrideValue(pkgJson, pm, overrideSelector, previousValue);
          writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

          try {
            const [rollbackCmd, ...rollbackArgs] = installCommand;
            await safeExeca(rollbackCmd, rollbackArgs, { cwd, stdio: "pipe" });
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
            message: `${testCommand.join(" ")} failed after applying ${overrideLabel} for "${overrideSelector}" to ${toVersion}. Reverted. Error: ${message}${dependencyTraceSuffix}`,
          };
        }
      }

      let proofOfFixVerification: ProofOfFixVerification | undefined;
      if (reproTestPath && negativePhaseResult?.passed) {
        const positivePhaseResult = await runProofOfFixPhase({
          stage: "positive",
          testFilePath: reproTestPath,
          cwd,
        });

        if (!positivePhaseResult.passed) {
          restoreOverrideValue(pkgJson, pm, overrideSelector, previousValue);
          writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

          try {
            const [rollbackCmd, ...rollbackArgs] = installCommand;
            await safeExeca(rollbackCmd, rollbackArgs, { cwd, stdio: "pipe" });
          } catch {}

          if (prepared.isCreated && reproTestPath) {
            await rm(reproTestPath, { force: true }).catch(() => {});
          }

          return {
            packageName,
            strategy: "override",
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
            passed: true,
          },
        });
      }

      let dedupeNote = "";
      if (dedupeCommand.length > 0) {
        try {
          const [dedupeCmd, ...dedupeArgs] = dedupeCommand;
          await safeExeca(dedupeCmd, dedupeArgs, { cwd, stdio: "pipe" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          dedupeNote = ` Dedupe warning: ${dedupeCommand.join(" ")} failed (${message}).`;
        }
      }

      return {
        packageName,
        strategy: "override",
        fromVersion,
        toVersion,
        applied: true,
        dryRun: false,
        proofOfFix: proofOfFixVerification,
        message: `Successfully applied ${overrideLabel} for "${overrideSelector}" from ${fromVersion} to ${toVersion}, then ran ${installCommand.join(" ")}${runTests ? ` and passed ${testCommand.join(" ")}` : ""}.${dedupeNote}${dependencyTraceSuffix}`,
      };
    });
  },
});
