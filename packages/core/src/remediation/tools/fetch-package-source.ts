import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  downloadTarball,
  getTarballInfo,
  verifyTarballIntegrity,
} from "../../intelligence/sources/registry.js";
import { loadRegistryConfig } from "../../platform/registry-config.js";
import { safeExeca } from "../../platform/safe-exec.js";
/**
 * Tool: fetch-package-source
 *
 * Downloads a package tarball from the configured npm registry (`.npmrc` aware), verifies it against
 * the registry's integrity digest, and extracts source files for CVE analysis.
 */
import { defineTool } from "./tool-compat.js";

/**
 * Interface for the tool's return value.
 */
interface FetchPackageSourceResult {
  success: boolean;
  sourceFiles?: Record<string, string>;
  packageDir?: string;
  error?: string;
}

const notFoundMessage = (packageName: string, version: string): string =>
  `Package ${packageName}@${version} not found on npm registry. It may not exist or the version may be incorrect.`;

export const fetchPackageSourceTool = defineTool({
  description:
    "Download package tarball from npm and extract source files for CVE analysis. Supports custom file patterns (default: *.js, *.ts).",
  inputSchema: z.object({
    cwd: z
      .string()
      .optional()
      .describe("Project directory whose .npmrc selects the registry and credentials"),
    packageName: z
      .string()
      .min(1)
      .describe("The npm package name (e.g., 'lodash', '@scope/package')"),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+/, "Must be a valid semver version")
      .describe("Exact package version to download"),
    filePatterns: z
      .array(z.string())
      .optional()
      .default(["*.js", "*.ts"])
      .describe("File patterns to extract (glob patterns, default: *.js, *.ts)"),
  }),
  execute: async ({
    cwd,
    packageName,
    version,
    filePatterns,
  }): Promise<FetchPackageSourceResult> => {
    // Validate package name against npm spec before using in URL
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) {
      return { success: false, error: `Invalid package name: ${packageName}` };
    }

    // Validate file patterns to prevent ReDoS
    const safePatterns = (filePatterns ?? ["*.js", "*.ts"]).filter((p) =>
      /^[a-zA-Z0-9._/*?-]+$/.test(p),
    );
    if (safePatterns.length === 0) {
      return { success: false, error: "No valid file patterns provided." };
    }

    const tempBaseDir = await mkdtemp(join(tmpdir(), "autoremediator-pkg-"));
    const extractDir = join(tempBaseDir, "out");

    try {
      // Step 1: Resolve the tarball through the configured registry, download and verify it
      const registry = loadRegistryConfig(cwd);
      const info = await getTarballInfo(packageName, version, registry);
      if (!info) {
        return { success: false, error: notFoundMessage(packageName, version) };
      }

      await mkdir(tempBaseDir, { recursive: true });
      const tarballPath = join(tempBaseDir, "package.tgz");
      const bytes = await downloadTarball(info, registry);
      const integrity = verifyTarballIntegrity(bytes, info);
      if (!integrity.ok) {
        return {
          success: false,
          error: `Refusing ${packageName}@${version}: tarball failed verification (${integrity.reason}).`,
        };
      }
      await writeFile(tarballPath, bytes);

      // Step 2: Extract tar.gz
      await mkdir(extractDir, { recursive: true });
      await safeExeca("tar", ["-xzf", tarballPath, "-C", extractDir]);

      // Step 3: Discover package root (tar extracts to 'package/' subdirectory)
      const extractedContents = await readdir(extractDir);
      const packageRootDir = extractedContents.includes("package")
        ? join(extractDir, "package")
        : extractDir;

      // Step 4: Recursively find and read matching source files
      const sourceCode: Record<string, string> = {};

      async function walkDir(dir: string, relativeBase: string): Promise<void> {
        try {
          const files = await readdir(dir, { withFileTypes: true });

          for (const file of files) {
            const fullPath = join(dir, file.name);
            const relPath = join(relativeBase, file.name);

            if (file.isDirectory()) {
              // Skip non-source directories (retain dist, build, and out for published packages)
              if (!["node_modules", ".git", "coverage", ".next"].includes(file.name)) {
                await walkDir(fullPath, relPath);
              }
            } else if (file.isFile()) {
              // Check if file matches any pattern (escape dots before expanding wildcards)
              const matches = safePatterns.some((pattern) => {
                const escaped = pattern.replaceAll(".", String.raw`\.`).replaceAll("*", ".*");
                const regex = new RegExp(`^${escaped}$`);
                return regex.test(file.name);
              });

              if (matches) {
                try {
                  const content = await readFile(fullPath, "utf8");
                  sourceCode[relPath] = content;
                } catch {
                  // Skip files that can't be read as UTF-8
                }
              }
            }
          }
        } catch {
          // Skip directories that can't be read
        }
      }

      await walkDir(packageRootDir, "");

      if (Object.keys(sourceCode).length === 0) {
        return {
          success: false,
          error: `No source files matching patterns [${safePatterns.join(", ")}] found in ${packageName}@${version}. Download succeeded but extraction yielded no matching files.`,
        };
      }

      return {
        success: true,
        sourceFiles: sourceCode,
        packageDir: packageRootDir,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A 404 from the registry or tarball host means the version does not exist.
      if (/\b404\b/.test(message)) {
        return { success: false, error: notFoundMessage(packageName, version) };
      }

      return {
        success: false,
        error: `Failed to fetch and extract package ${packageName}@${version}: ${message}`,
      };
    } finally {
      await rm(tempBaseDir, { recursive: true, force: true });
    }
  },
});
