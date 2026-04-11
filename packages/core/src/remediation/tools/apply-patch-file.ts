/**
 * Tool: apply-patch-file
 *
 * Writes generated patch files to disk and applies them using package-manager-aware
 * patch mechanisms (native pnpm/yarn when available, patch-package compatibility otherwise).
 * Optionally validates patches by running tests.
 */
import { tool } from "ai";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  detectPackageManager,
  getPackageManagerCommands,
  getYarnMajorVersion,
  resolveInstallCommand,
  resolveTestCommand,
  type PackageManager,
} from "../../platform/package-manager.js";
import { withRepoLock } from "../../platform/repo-lock.js";
import { loadPolicy } from "../../platform/policy.js";
import { validatePatchDiff } from "../strategies/patch-utils.js";
import type {
  PatchArtifact,
  PatchMode,
  PatchRiskLevel,
  PatchValidationPhase,
} from "../../platform/types.js";

/**
 * Validation result object.
 */
interface ValidationResult {
  passed: boolean;
  error?: string;
  output?: string;
  failedTests?: string[];
}

/**
 * Tool result interface.
 */
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

/**
 * Raw package.json structure for type safety.
 */
interface RawPackageJson {
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export const applyPatchFileTool = tool({
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
    packageManager: z.enum(["npm", "pnpm", "yarn"]).optional().describe("Package manager used by the target project (auto-detected if omitted)"),
    policy: z.string().optional().describe("Optional path to .autoremediator policy file"),
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
          patchModeRequiresPackageJsonSnapshot(pm, cwd)
            ? await capturePackageJsonSnapshot(cwd)
            : undefined;

        // Step 1: Create patches directory if it doesn't exist
        const patchesDirPath = join(cwd, patchesDir);
        await mkdir(patchesDirPath, { recursive: true });

        // Step 2: Write patch file with proper naming convention
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

        // Step 3: Apply patch via native package-manager workflow when available.
        // npm always uses patch-package, yarn v1 falls back to patch-package.
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

        // Step 4: Validate with tests if requested
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

interface PackageJsonSnapshot {
  path: string;
  content: string;
}

async function resolvePatchMode(packageManager: PackageManager, cwd: string): Promise<PatchMode> {
  if (packageManager === "npm") return "patch-package";
  if (packageManager === "pnpm") return "native-pnpm";

  // Yarn v1 does not provide native patch commands; use patch-package compatibility path.
  const major = await getYarnMajorVersion(cwd);
  return major >= 2 ? "native-yarn" : "patch-package";
}

function patchModeRequiresPackageJsonSnapshot(packageManager: PackageManager, cwd: string): boolean {
  if (packageManager === "npm") return true;
  if (packageManager === "pnpm") return false;

  return true;
}

function buildPatchFileName(packageName: string, vulnerableVersion: string): string {
  const safeName = packageName.replace(/^@/, "").replace(/\//g, "+");
  return `${safeName}+${vulnerableVersion}.patch`;
}

async function configurePatchPackagePostinstall(cwd: string, packageManager: PackageManager): Promise<{ success: true } | { success: false; error: string }> {
  const pkgJsonPath = join(cwd, "package.json");
  let pkgJson: RawPackageJson;

  try {
    pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8")) as RawPackageJson;
  } catch {
    return {
      success: false,
      error: `Could not read package.json at ${pkgJsonPath}`,
    };
  }

  const devDependencies = pkgJson.devDependencies ?? {};
  if (!devDependencies["patch-package"]) {
    try {
      const commands = getPackageManagerCommands(packageManager);
      const [cmd, ...args] = commands.installDev("patch-package");
      await execa(cmd, args, {
        cwd,
        stdio: "pipe",
      });
    } catch (err) {
      return {
        success: false,
        error: `Failed to install patch-package: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!pkgJson.scripts) {
    pkgJson.scripts = {};
  }

  const patchApplyCmd = "patch-package";
  const currentPostinstall = pkgJson.scripts.postinstall || "";

  if (currentPostinstall && !currentPostinstall.includes("patch-package")) {
    pkgJson.scripts.postinstall = `${currentPostinstall} && ${patchApplyCmd}`;
  } else if (!currentPostinstall) {
    pkgJson.scripts.postinstall = patchApplyCmd;
  }

  await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
  return { success: true };
}

async function capturePackageJsonSnapshot(cwd: string): Promise<PackageJsonSnapshot | undefined> {
  const path = join(cwd, "package.json");

  try {
    const content = await readFile(path, "utf8");
    return { path, content };
  } catch {
    return undefined;
  }
}

async function cleanupPatchArtifacts(params: {
  cwd: string;
  patchFilePath: string;
  manifestFilePath?: string;
  patchMode: PatchMode;
  packageJsonSnapshot?: PackageJsonSnapshot;
  installCommand: string[];
  rerunInstall: boolean;
}): Promise<void> {
  const {
    cwd,
    patchFilePath,
    manifestFilePath,
    patchMode,
    packageJsonSnapshot,
    installCommand,
    rerunInstall,
  } = params;

  await rm(patchFilePath, { force: true }).catch(() => undefined);
  if (manifestFilePath) {
    await rm(manifestFilePath, { force: true }).catch(() => undefined);
  }

  if (patchMode === "patch-package" && packageJsonSnapshot) {
    await writeFile(packageJsonSnapshot.path, packageJsonSnapshot.content, "utf8").catch(() => undefined);
  }

  if (!rerunInstall) return;

  try {
    const [installCmd, ...installArgs] = installCommand;
    await execa(installCmd, installArgs, {
      cwd,
      stdio: "pipe",
    });
  } catch {
    // Ignore cleanup install failures and preserve the original remediation error.
  }
}

async function applyNativePatch(params: {
  cwd: string;
  packageName: string;
  vulnerableVersion: string;
  patchContent: string;
  patchMode: "native-pnpm" | "native-yarn";
  validationPhases: PatchValidationPhase[];
}): Promise<{ success: true } | { success: false; error: string }> {
  const { cwd, packageName, vulnerableVersion, patchContent, patchMode, validationPhases } = params;
  const packageSpec = `${packageName}@${vulnerableVersion}`;

  const createCommand = patchMode === "native-pnpm" ? "pnpm" : "yarn";
  const createArgs = ["patch", packageSpec];

  let patchDir: string;
  try {
    const createResult = await execa(createCommand, createArgs, {
      cwd,
      stdio: "pipe",
    });
    patchDir = extractPatchDirectory(`${createResult.stdout}\n${createResult.stderr}`);
  } catch (err) {
    validationPhases.push({
      phase: "apply",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: `Failed to create native patch workspace for ${packageSpec}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!patchDir) {
    validationPhases.push({
      phase: "apply",
      passed: false,
      error: `Could not determine native patch directory for ${packageSpec}.`,
    });
    return {
      success: false,
      error: `Could not determine native patch directory for ${packageSpec}.`,
    };
  }

  const tempPatchDir = await mkdtemp(join(tmpdir(), "autoremediator-native-patch-"));
  const tempPatchFile = join(tempPatchDir, "change.patch");

  try {
    await writeFile(tempPatchFile, patchContent, "utf8");
    await execa("patch", ["-p1", "-i", tempPatchFile], {
      cwd: patchDir,
      stdio: "pipe",
    });

    const commitCommand = patchMode === "native-pnpm" ? "pnpm" : "yarn";
    const commitArgs =
      patchMode === "native-pnpm"
        ? ["patch-commit", patchDir]
        : ["patch-commit", "-s", patchDir];

    await execa(commitCommand, commitArgs, {
      cwd,
      stdio: "pipe",
    });
  } catch (err) {
    validationPhases.push({
      phase: "apply",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: `Failed to apply native patch for ${packageSpec}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    await rm(tempPatchDir, { recursive: true, force: true });
  }

  return { success: true };
}

async function writePatchManifest(manifestFilePath: string, artifact: PatchArtifact): Promise<void> {
  await writeFile(manifestFilePath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

function extractPatchedFiles(patchContent: string): string[] {
  return Array.from(
    new Set(
      patchContent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("+++ b/"))
        .map((line) => line.slice("+++ b/".length))
    )
  );
}

function countPatchHunks(patchContent: string): number {
  return patchContent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("@@ ")).length;
}

function extractPatchDirectory(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (existsSync(line)) {
      return line;
    }

    const tokens = line.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ""));
    for (const token of tokens) {
      if (token.startsWith("/") && existsSync(token)) {
        return token;
      }
    }
  }

  return "";
}

/**
 * Validate patch by running tests in the project.
 */
async function validatePatchWithTests(cwd: string, testCommand: string[]): Promise<ValidationResult> {
  try {
    const [cmd, ...args] = testCommand;

    // Run package manager test command with a timeout
    const result = await execa(cmd, args, {
      cwd,
      timeout: 60000, // 60 second timeout
      stdio: "pipe",
    });

    return {
      passed: true,
      output: result.stdout,
    };
  } catch (err) {
    // Extract useful error information
    const errorOutput =
      typeof err === "object" && err !== null && "stdout" in err
        ? String((err as Record<string, unknown>).stdout ?? "")
        : "";
    const failedTests = extractFailedTests(errorOutput);

    return {
      passed: false,
      error:
        failedTests.length > 0
          ? `Failed tests: ${failedTests.join(", ")}`
          : "Package-manager test validation failed.",
      output: errorOutput,
      failedTests,
    };
  }
}

/**
 * Parse test output to extract names of failed tests.
 * (Basic implementation; real implementation would parse different test runners)
 */
function extractFailedTests(output: string): string[] {
  const failedTests: string[] = [];

  // Common test failure patterns
  const patterns = [
    /✖\s+(.+?)(?:\n|$)/g, // Mocha style
    /●\s+(.+)(?:\n|$)/g, // Jest style
    /^FAIL\s+(.+?)(?:\n|$)/gm, // Generic FAIL
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      if (match[1]) {
        failedTests.push(match[1].trim());
      }
    }
  }

  return failedTests.slice(0, 5); // Return first 5 failures
}
