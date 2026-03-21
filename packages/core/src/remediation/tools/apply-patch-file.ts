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
  type PackageManager,
} from "../../platform/package-manager.js";
import { withRepoLock } from "../../platform/repo-lock.js";

/**
 * Validation result object.
 */
interface ValidationResult {
  passed: boolean;
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
  patchPath?: string;
  patchMode?: "patch-package" | "native-pnpm" | "native-yarn";
  postinstallConfigured?: boolean;
  validation?: ValidationResult;
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
    patches,
    patchesDir,
    cwd,
    packageManager,
    validateWithTests,
    dryRun,
  }): Promise<ApplyPatchFileResult> => {
    try {
      const pm = (packageManager ?? detectPackageManager(cwd)) as PackageManager;
      const selectedPatch = patchContent ?? patches?.[0]?.unifiedDiff;

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

      const patchFileName = buildPatchFileName(packageName, vulnerableVersion);
      const patchFilePath = join(cwd, patchesDir, patchFileName);

      if (dryRun) {
        return {
          success: true,
          packageName,
          vulnerableVersion,
          applied: false,
          dryRun: true,
          message: `[DRY RUN] Would write and configure patch at ${patchFilePath}.`,
          patchFilePath,
          patchPath: patchFilePath,
        };
      }

      return withRepoLock(cwd, async () => {
        // Step 1: Create patches directory if it doesn't exist
        const patchesDirPath = join(cwd, patchesDir);
        await mkdir(patchesDirPath, { recursive: true });

        // Step 2: Write patch file with proper naming convention
        await writeFile(patchFilePath, selectedPatch, "utf8");

        let validationResult: ValidationResult | undefined;
        const patchMode = await resolvePatchMode(pm, cwd);

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
              });

        if (!applyResult.success) {
          return {
            success: false,
            packageName,
            vulnerableVersion,
            applied: false,
            dryRun: false,
            message: applyResult.error,
            patchFilePath,
            patchPath: patchFilePath,
            patchMode,
            postinstallConfigured: patchMode === "patch-package" ? false : undefined,
            error: applyResult.error,
          };
        }

        // Step 4: Validate with tests if requested
        if (validateWithTests) {
          validationResult = await validatePatchWithTests(cwd, pm);
          if (!validationResult.passed) {
            const validationError = "Patch validation failed after apply; patch marked unresolved.";
            return {
              success: false,
              packageName,
              vulnerableVersion,
              applied: false,
              dryRun: false,
              message: validationError,
              patchFilePath,
              patchPath: patchFilePath,
              patchMode,
              postinstallConfigured: patchMode === "patch-package",
              validation: validationResult,
              error: validationError,
            };
          }
        }

        return {
          success: true,
          packageName,
          vulnerableVersion,
          applied: true,
          dryRun: false,
          message: `Patch applied successfully for ${packageName}@${vulnerableVersion}.`,
          patchFilePath,
          patchPath: patchFilePath,
          patchMode,
          postinstallConfigured: patchMode === "patch-package",
          validation: validationResult,
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

type PatchMode = "patch-package" | "native-pnpm" | "native-yarn";

async function resolvePatchMode(packageManager: PackageManager, cwd: string): Promise<PatchMode> {
  if (packageManager === "npm") return "patch-package";
  if (packageManager === "pnpm") return "native-pnpm";

  // Yarn v1 does not provide native patch commands; use patch-package compatibility path.
  try {
    const result = await execa("yarn", ["--version"], {
      cwd,
      stdio: "pipe",
    });
    const version = result.stdout.trim();
    const major = Number.parseInt(version.split(".")[0] || "0", 10);
    return major >= 2 ? "native-yarn" : "patch-package";
  } catch {
    return "patch-package";
  }
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

async function applyNativePatch(params: {
  cwd: string;
  packageName: string;
  vulnerableVersion: string;
  patchContent: string;
  patchMode: "native-pnpm" | "native-yarn";
}): Promise<{ success: true } | { success: false; error: string }> {
  const { cwd, packageName, vulnerableVersion, patchContent, patchMode } = params;
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
    return {
      success: false,
      error: `Failed to create native patch workspace for ${packageSpec}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!patchDir) {
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
async function validatePatchWithTests(cwd: string, packageManager: PackageManager): Promise<ValidationResult> {
  try {
    const commands = getPackageManagerCommands(packageManager);
    const [cmd, ...args] = commands.test;

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
      err instanceof Error && "stdout" in err
        ? (err as Record<string, string>).stdout
        : "";
    const failedTests = extractFailedTests(errorOutput);

    return {
      passed: false,
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
    /FAIL.*?(.+?)(?:\n|$)/g, // Generic FAIL
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
