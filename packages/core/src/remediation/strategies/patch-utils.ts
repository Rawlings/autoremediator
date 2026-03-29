/**
 * Patch generation utilities for Autoremediator
 *
 * Provides functions for:
 * - Writing patch files to disk
 * - Validating unified diff format
 * - Managing patch-package integration
 * - Fetching source files from npm
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { detectPackageManager, getPackageManagerCommands } from "../../platform/package-manager.js";

/**
 * Validation result type for patch diffs
 */
export interface PatchValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Write a unified diff patch to the patches directory
 *
 * Creates patches/ directory if it doesn't exist and writes the patch with
 * naming convention: <packageName>+<version>.patch
 *
 * @param packageName - The npm package name
 * @param version - The package version
 * @param patchContent - The unified diff content
 * @param projectDir - Project root directory
 * @returns Full file path to the written patch file
 */
export function writePatchFile(
  packageName: string,
  version: string,
  patchContent: string,
  projectDir: string
): string {
  const patchesDir = join(projectDir, "patches");

  // Create patches directory if missing
  if (!existsSync(patchesDir)) {
    mkdirSync(patchesDir, { recursive: true });
  }

  // Sanitize package name for filename (remove @ from scoped packages)
  const safeName = packageName.replace(/^@/, "").replace(/\//g, "+");
  const filename = `${safeName}+${version}.patch`;
  const filePath = join(patchesDir, filename);

  // Write patch file
  writeFileSync(filePath, patchContent, "utf8");

  return filePath;
}

/**
 * Validate that patch content matches unified diff format
 *
 * Checks for:
 * - Presence of --- and +++ header lines
 * - Presence of @@ hunk headers
 * - Valid unified diff structure
 *
 * @param patchContent - The patch content to validate
 * @returns Validation result with error details if invalid
 */
export function validatePatchDiff(patchContent: string): PatchValidationResult {
  if (!patchContent || typeof patchContent !== "string") {
    return {
      valid: false,
      error: "Patch content must be a non-empty string",
    };
  }

  // Check for basic unified diff structure
  const hasFromLine = /^---\s+\S+/m.test(patchContent);
  const hasToLine = /^\+\+\+\s+\S+/m.test(patchContent);
  const hasHunkHeader = /^@@\s+-\d+/m.test(patchContent);

  if (!hasFromLine) {
    return {
      valid: false,
      error: 'Missing "---" line in patch format',
    };
  }

  if (!hasToLine) {
    return {
      valid: false,
      error: 'Missing "+++" line in patch format',
    };
  }

  if (!hasHunkHeader) {
    return {
      valid: false,
      error: "No hunk headers (@@...) found in patch",
    };
  }

  return { valid: true };
}

/**
 * Ensure patch-package is installed and configured
 *
 * Checks if patch-package is in devDependencies. If not, either:
 * - Installs it automatically (if not in dry-run context)
 * - Logs a warning with installation instructions
 *
 * Updates package.json postinstall script if needed:
 * Add "postinstall": "patch-package" or append to existing script
 *
 * @param projectDir - Project root directory
 * @returns Promise that resolves when patch-package is ensured
 */
export async function ensurePatchPackage(projectDir: string): Promise<void> {
  const pkgPath = join(projectDir, "package.json");

  // Read package.json
  let pkgJson: Record<string, unknown>;
  try {
    const content = readFileSync(pkgPath, "utf8");
    pkgJson = JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to read package.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const devDeps = (pkgJson.devDependencies as Record<string, string> | undefined) || {};

  // Check if patch-package is already installed
  if (devDeps["patch-package"]) {
    return; // Already present
  }

  // Install patch-package
  try {
    const packageManager = detectPackageManager(projectDir);
    const commands = getPackageManagerCommands(packageManager);
    const [cmd, ...args] = commands.installDev("patch-package");
    await execa(cmd, args, {
      cwd: projectDir,
      stdio: "inherit",
    });
  } catch (err) {
    throw new Error(
      `Failed to install patch-package: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Update postinstall script in package.json
  let scripts = (pkgJson.scripts as Record<string, string> | undefined) || {};
  const existingPostinstall = scripts.postinstall || "";
  const newPostinstall = existingPostinstall
    ? `${existingPostinstall} && patch-package`
    : "patch-package";

  scripts.postinstall = newPostinstall;
  pkgJson.scripts = scripts;

  // Write updated package.json
  try {
    writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
  } catch (err) {
    throw new Error(`Failed to update package.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fetch the content of a specific file from an npm package
 *
 * Downloads the package tarball from npm, extracts the specified file,
 * and returns its content. Useful for LLM analysis of vulnerable source code.
 *
 * @param packageName - The npm package name
 * @param version - The package version
 * @param filePath - Path to file within package (relative to package root)
 * @returns Promise resolving to file content as string
 */
export async function getVulnerableFileContent(
  packageName: string,
  version: string,
  filePath: string
): Promise<string> {
  // Use npm view to fetch tarball URL
  let tarballUrl: string;
  try {
    const result = await execa("npm", ["view", `${packageName}@${version}`, "dist.tarball"], {
      stdio: "pipe",
    });
    tarballUrl = (result.stdout as string).trim();
  } catch (err) {
    throw new Error(
      `Failed to get tarball URL for ${packageName}@${version}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!tarballUrl) {
    throw new Error(`No tarball URL found for ${packageName}@${version}`);
  }

  // Create temporary directory for extraction
  const tempDir = join("/tmp", `autoremediator-${packageName}-${version}-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    // Alternative: use curl and tar
    await execa("bash", [
      "-c",
      `curl -s "${tarballUrl}" | tar xz -C "${tempDir}"`,
    ]);

    // Read the file from extracted package (npm extracts under "package/" directory)
    const extractedPath = join(tempDir, "package", filePath);
    const content = readFileSync(extractedPath, "utf8");

    return content;
  } catch (err) {
    throw new Error(
      `Failed to fetch file ${filePath} from ${packageName}@${version}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    // Clean up temporary directory
    try {
      await execa("rm", ["-rf", tempDir]);
    } catch (cleanupErr) {
      // Ignore cleanup errors
    }
  }
}
