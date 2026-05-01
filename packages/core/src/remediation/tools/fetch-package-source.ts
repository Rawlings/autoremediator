/**
 * Tool: fetch-package-source
 *
 * Downloads a package tarball from npm registry and extracts source files for CVE analysis.
 * Uses Node.js fetch API to download and execa to extract tar archives.
 */
import { defineTool } from "./tool-compat.js";
import { z } from "zod";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

/**
 * Interface for the tool's return value.
 */
interface FetchPackageSourceResult {
  success: boolean;
  sourceFiles?: Record<string, string>;
  packageDir?: string;
  error?: string;
}

export const fetchPackageSourceTool = defineTool({
  description:
    "Download package tarball from npm and extract source files for CVE analysis. Supports custom file patterns (default: *.js, *.ts).",
  parameters: z.object({
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
      .describe(
        "File patterns to extract (glob patterns, default: *.js, *.ts)"
      ),
  }),
  execute: async ({
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
      /^[a-zA-Z0-9._/*?-]+$/.test(p)
    );
    if (safePatterns.length === 0) {
      return { success: false, error: "No valid file patterns provided." };
    }

    const tempBaseDir = await mkdtemp(join(tmpdir(), "autoremediator-pkg-"));
    const extractDir = join(tempBaseDir, "out");

    try {
      // Step 1: Construct npm registry URL and download tarball
      const scopedName = packageName.split("/").pop()!;
      const npmUrl = `https://registry.npmjs.org/${packageName}/-/${scopedName}-${version}.tgz`;

      // Create temp directory
      await mkdir(tempBaseDir, { recursive: true });

      // Download tarball using curl (reliable method)
      const tarballPath = join(tempBaseDir, "package.tgz");
      await execa("curl", ["-L", "-o", tarballPath, npmUrl]);

      // Step 2: Extract tar.gz
      await mkdir(extractDir, { recursive: true });
      await execa("tar", ["-xzf", tarballPath, "-C", extractDir]);

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
              // Skip common non-source directories
              if (
                ![
                  "node_modules",
                  ".git",
                  "dist",
                  "build",
                  "coverage",
                  ".next",
                  "out",
                ]
                  .includes(file.name)
              ) {
                await walkDir(fullPath, relPath);
              }
            } else if (file.isFile()) {
              // Check if file matches any pattern
              const matches = safePatterns.some((pattern) => {
                const regex = new RegExp(
                  `^${pattern.replace(/\*/g, ".*").replace(/\./g, "\\.")}$`
                );
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
      const message =
        err instanceof Error ? err.message : String(err);

      // Check if it's a 404 from npm
      if (message.includes("404") || message.includes("not found")) {
        return {
          success: false,
          error: `Package ${packageName}@${version} not found on npm registry. It may not exist or the version may be incorrect.`,
        };
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
