/**
 * Tool: apply-patch-file
 *
 * Writes generated patch files to disk and applies them using package-manager-aware
 * patch mechanisms (native pnpm/yarn when available, patch-package compatibility otherwise).
 * Optionally validates patches by running tests.
 */
import { defineTool } from "../tool-compat.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import {
  detectPackageManager,
  getYarnMajorVersion,
  resolveInstallCommand,
  resolveTestCommand,
  type PackageManager,
} from "../../../platform/package-manager/index.js";
import { withRepoLock } from "../../../platform/repo-lock.js";
import { loadPolicy } from "../../../platform/policy.js";
import { validatePatchDiff } from "../../strategies/patch-utils.js";
import type {
  PatchArtifact,
  PatchMode,
  PatchValidationPhase,
} from "../../../platform/types.js";
import {
  applyNativePatch,
  buildPatchFileName,
  capturePackageJsonSnapshot,
  cleanupPatchArtifacts,
  computePatchIntegrity,
  configurePatchPackagePostinstall,
  countPatchHunks,
  extractPatchedFiles,
  patchModeRequiresPackageJsonSnapshot,
  resolvePatchMode,
  validatePatchWithTests,
  writePatchManifest,
  type ValidationResult,
} from "./helpers.js";

interface ApplyPatchFileResult {
  success: boolean;
  packageName: string;
  vulnerableVersion: string;
  applied: boolean;
  dryRun: boolean;
  message: string;
  patchFilePath?: string;
  manifestFilePath?: string;
  patchPath?: string;
  patchMode?: PatchMode;
  postinstallConfigured?: boolean;
  patchArtifact?: PatchArtifact;
  validation?: ValidationResult;
  validationPhases?: PatchValidationPhase[];
  error?: string;
}

export const applyPatchFileTool = defineTool({
  description:
    "Write generated patch file and apply it using package-manager-native patch flow when available, falling back to patch-package when needed.",
  parameters: z.object({
    packageName: z.string().min(1).describe("The npm package name"),
    vulnerableVersion: z
      .string()
      .describe("The vulnerable version string"),
    patchContent: z
      .string()
      .min(10)
      .optional()
      .describe("Unified diff patch content from generate-patch"),
    cveId: z.string().optional().describe("Optional CVE ID associated with this patch artifact"),
    confidence: z.number().min(0).max(1).optional().describe("Optional patch confidence score from generate-patch"),
    riskLevel: z.enum(["low", "medium", "high"]).optional().describe("Optional risk level from generate-patch"),
    patches: z
      .array(
        z.object({
          filePath: z.string().min(1),
          unifiedDiff: z.string().min(10),
        })
      )
      .optional()
      .describe("Patch list from generate-patch; first patch is applied"),
    patchesDir: z
      .string()
      .optional()
      .default("./patches")
      .describe("Directory to store patch files"),
    cwd: z.string().describe("Project root directory (for package.json)"),
    packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "deno"]).optional().describe("Package manager used by the target project (auto-detected if omitted)"),    policy: z.string().optional().describe("Optional path to .autoremediator policy file"),
    installMode: z.enum(["standard", "prefer-offline", "deterministic"]).optional(),
    installPreferOffline: z.boolean().optional(),
    enforceFrozenLockfile: z.boolean().optional(),
    workspace: z.string().optional(),
    validateWithTests: z
      .boolean()
      .optional()
      .default(true)
      .describe("Run package manager test command to validate patch doesn't break anything"),
    dryRun: z.boolean().optional().default(false).describe("If true, report but do not mutate files"),
  }).refine((value) => Boolean(value.patchContent || (value.patches && value.patches.length > 0)), {
    message: "Either patchContent or patches must be provided",
  }),
  execute: async ({
    packageName,
    vulnerableVersion,
    patchContent,
    cveId,
    confidence,
    patches,
    patchesDir,
    cwd,
    packageManager,
    policy,
    installMode,
    installPreferOffline,
    enforceFrozenLockfile,
    workspace,
    riskLevel,
    validateWithTests,
    dryRun,
  }): Promise<ApplyPatchFileResult> => {
    try {
      const pm = (packageManager ?? detectPackageManager(cwd)) as PackageManager;
      const loadedPolicy = loadPolicy(cwd, policy);
      const commandConstraints = {
        ...loadedPolicy.constraints,
        installMode: installMode ?? loadedPolicy.constraints?.installMode,
        installPreferOffline: installPreferOffline ?? loadedPolicy.constraints?.installPreferOffline,
        enforceFrozenLockfile: enforceFrozenLockfile ?? loadedPolicy.constraints?.enforceFrozenLockfile,
        workspace: workspace ?? loadedPolicy.constraints?.workspace,
      };
      const yarnMajor = pm === "yarn" ? await getYarnMajorVersion(cwd) : undefined;
      const installCommand = resolveInstallCommand(pm, commandConstraints, yarnMajor);
      const testCommand = resolveTestCommand(pm, commandConstraints);
      const selectedPatch = patchContent ?? patches?.[0]?.unifiedDiff;
      const patchFiles = extractPatchedFiles(selectedPatch ?? "");
      const hunkCount = countPatchHunks(selectedPatch ?? "");
      const validationPhases: PatchValidationPhase[] = [];

      if (!selectedPatch) {
        return {
          success: false,
          packageName,
          vulnerableVersion,
          applied: false,
          dryRun,
          message: "No patch content provided.",
          error: "No patch content provided.",
        };
      }

      const patchValidation = validatePatchDiff(selectedPatch);
      validationPhases.push({
        phase: "diff-format",
        passed: patchValidation.valid,
        error: patchValidation.valid ? undefined : patchValidation.error,
        message: patchValidation.valid ? "Patch content is a valid unified diff." : undefined,
      });

      if (!patchValidation.valid) {
        return {
          success: false,
          packageName,
          vulnerableVersion,
          applied: false,
          dryRun,
          message: patchValidation.error ?? "Patch content is not a valid unified diff.",
          validationPhases,
          error: patchValidation.error ?? "Patch content is not a valid unified diff.",
        };
      }

      const patchFileName = buildPatchFileName(packageName, vulnerableVersion);
      const patchFilePath = join(cwd, patchesDir, patchFileName);
      const manifestFilePath = `${patchFilePath}.json`;
      const generatedAt = new Date().toISOString();
      const baseArtifact: PatchArtifact = {
        schemaVersion: "1.0",
        cveId,
        packageName,
        vulnerableVersion,
        patchFilePath,
        manifestFilePath,
        patchFileName,
        patchesDir,
        confidence,
        riskLevel,
        generatedAt,
        files: patchFiles,
        hunkCount,
        applied: false,
        dryRun,
        integrity: computePatchIntegrity(selectedPatch),
        validationPhases,
      };

      if (dryRun) {
        return {
          success: true,
          packageName,
          vulnerableVersion,
          applied: false,
          dryRun: true,
          message: `[DRY RUN] Would write and configure patch at ${patchFilePath}.`,
          patchFilePath,
          manifestFilePath,
          patchPath: patchFilePath,
          patchArtifact: baseArtifact,
          validationPhases,
        };
      }

      return withRepoLock(cwd, async () => {
        const packageJsonSnapshot =
          patchModeRequiresPackageJsonSnapshot(pm)
            ? await capturePackageJsonSnapshot(cwd)
            : undefined;

        const patchesDirPath = join(cwd, patchesDir);
        await mkdir(patchesDirPath, { recursive: true });

        await writeFile(patchFilePath, selectedPatch, "utf8");
        validationPhases.push({
          phase: "patch-write",
          passed: true,
          message: `Patch file written to ${patchFilePath}.`,
        });

        let validationResult: ValidationResult | undefined;
        const patchMode = await resolvePatchMode(pm, cwd);
        const artifact: PatchArtifact = {
          ...baseArtifact,
          patchMode,
          validationPhases,
        };

        await writePatchManifest(manifestFilePath, artifact);
        validationPhases.push({
          phase: "manifest-write",
          passed: true,
          message: `Patch manifest written to ${manifestFilePath}.`,
        });
        artifact.validationPhases = validationPhases;
        await writePatchManifest(manifestFilePath, artifact);

        const applyResult =
          patchMode === "patch-package"
            ? await configurePatchPackagePostinstall(cwd, pm)
            : await applyNativePatch({
                cwd,
                packageName,
                vulnerableVersion,
                patchContent: selectedPatch,
                patchMode,
                validationPhases,
              });

        if (!applyResult.success) {
          await cleanupPatchArtifacts({
            cwd,
            patchFilePath,
            manifestFilePath,
            patchMode,
            packageJsonSnapshot,
            installCommand,
            rerunInstall: patchMode === "patch-package",
          });
          return {
            success: false,
            packageName,
            vulnerableVersion,
            applied: false,
            dryRun: false,
            message: applyResult.error,
            patchFilePath,
            manifestFilePath,
            patchPath: patchFilePath,
            patchMode,
            postinstallConfigured: patchMode === "patch-package" ? false : undefined,
            patchArtifact: {
              ...artifact,
              applied: false,
              validationPhases,
            },
            validationPhases,
            error: applyResult.error,
          };
        }

        validationPhases.push({
          phase: "apply",
          passed: true,
          message: `Patch applied using ${patchMode}.`,
        });

        if (patchMode === "patch-package") {
          try {
            const [installCmd, ...installArgs] = installCommand;
            await execa(installCmd, installArgs, {
              cwd,
              stdio: "pipe",
            });
            validationPhases.push({
              phase: "install",
              passed: true,
              message: `${installCommand.join(" ")} completed successfully.`,
            });
          } catch (err) {
            await cleanupPatchArtifacts({
              cwd,
              patchFilePath,
              manifestFilePath,
              patchMode,
              packageJsonSnapshot,
              installCommand,
              rerunInstall: true,
            });
            const error = err instanceof Error ? err.message : String(err);
            validationPhases.push({
              phase: "install",
              passed: false,
              error,
            });
            return {
              success: false,
              packageName,
              vulnerableVersion,
              applied: false,
              dryRun: false,
              message: `Failed to apply patch-package workflow for ${packageName}@${vulnerableVersion}: ${error}`,
              patchFilePath,
              manifestFilePath,
              patchPath: patchFilePath,
              patchMode,
              postinstallConfigured: false,
              patchArtifact: {
                ...artifact,
                applied: false,
                validationPhases,
              },
              validationPhases,
              error: `Failed to apply patch-package workflow for ${packageName}@${vulnerableVersion}: ${error}`,
            };
          }
        }

        if (validateWithTests) {
          validationResult = await validatePatchWithTests(cwd, testCommand);
          if (!validationResult.passed) {
            await cleanupPatchArtifacts({
              cwd,
              patchFilePath,
              manifestFilePath,
              patchMode,
              packageJsonSnapshot,
              installCommand,
              rerunInstall: patchMode === "patch-package",
            });
            const validationError = "Patch validation failed after apply; patch marked unresolved.";
            validationPhases.push({
              phase: "test",
              passed: false,
              error: validationResult.error,
            });
            return {
              success: false,
              packageName,
              vulnerableVersion,
              applied: false,
              dryRun: false,
              message: validationError,
              patchFilePath,
              manifestFilePath,
              patchPath: patchFilePath,
              patchMode,
              postinstallConfigured: false,
              patchArtifact: {
                ...artifact,
                applied: false,
                validationPhases,
              },
              validation: validationResult,
              validationPhases,
              error: validationError,
            };
          }

          validationPhases.push({
            phase: "test",
            passed: true,
            message: "Patch validation tests passed.",
          });
        }

        const finalArtifact: PatchArtifact = {
          ...artifact,
          applied: true,
          dryRun: false,
          validationPhases,
        };
        await writePatchManifest(manifestFilePath, finalArtifact);

        return {
          success: true,
          packageName,
          vulnerableVersion,
          applied: true,
          dryRun: false,
          message: `Patch applied successfully for ${packageName}@${vulnerableVersion}.`,
          patchFilePath,
          manifestFilePath,
          patchPath: patchFilePath,
          patchMode,
          postinstallConfigured: patchMode === "patch-package",
          patchArtifact: finalArtifact,
          validation: validationResult,
          validationPhases,
        };
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        success: false,
        packageName,
        vulnerableVersion,
        applied: false,
        dryRun,
        message: `Failed to apply patch file: ${message}`,
        error: `Failed to apply patch file: ${message}`,
      };
    }
  },
});