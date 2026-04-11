/**
 * Tool: check-inventory
 *
 * Reads the consumer's package.json and installed dependency tree to produce
 * a flat list of installed packages and their resolved versions.
 */
import { tool } from "ai";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { InventoryPackage } from "../../platform/types.js";
import {
  detectPackageManager,
  parseListOutput,
  resolveListCommand,
  type PackageManager,
} from "../../platform/package-manager.js";
import { loadPolicy } from "../../platform/policy.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export const checkInventoryTool = tool({
  description:
    "Read the project's package.json and installed dependencies to list packages and exact versions. Must be called before checking version matches.",
  parameters: z.object({
    cwd: z.string().describe("Absolute path to the consumer project's root directory"),
    packageManager: z.enum(["npm", "pnpm", "yarn"]).optional().describe("Package manager used by the target project (auto-detected if omitted)"),
    policy: z.string().optional().describe("Optional path to .autoremediator policy file"),
    workspace: z.string().optional().describe("Optional workspace/package selector for monorepos"),
  }),
  execute: async ({ cwd, packageManager, policy, workspace }): Promise<{ packages: InventoryPackage[]; error?: string }> => {
    let pkgJson: PackageJson;

    try {
      pkgJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as PackageJson;
    } catch {
      return {
        packages: [],
        error: `Could not read package.json in "${cwd}". Is this a Node.js project?`,
      };
    }

    const pm = (packageManager ?? detectPackageManager(cwd)) as PackageManager;
    const loadedPolicy = loadPolicy(cwd, policy);
    const listCommand = resolveListCommand(pm, {
      ...loadedPolicy.constraints,
      workspace: workspace ?? loadedPolicy.constraints?.workspace,
    });
    let installedVersions = new Map<string, string>();

    try {
      const [cmd, ...args] = listCommand;
      const listResult = await execa(cmd, args, {
        cwd,
        stdio: "pipe",
        reject: false,
      });
      installedVersions = parseListOutput(pm, listResult.stdout || "");
    } catch {
      // Fallback to package.json-only view when list command fails.
    }

    const packages: InventoryPackage[] = [];

    for (const [name, version] of installedVersions.entries()) {
      const isDirect =
        Boolean(pkgJson.dependencies?.[name]) ||
        Boolean(pkgJson.devDependencies?.[name]) ||
        Boolean(pkgJson.peerDependencies?.[name]);

      packages.push({
        name,
        version,
        type: isDirect ? "direct" : "indirect",
      });
    }

    if (packages.length === 0) {
      // Fallback: only direct deps from package.json (best-effort versions)
      const allDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
      };
      for (const [name, version] of Object.entries(allDeps)) {
        const cleaned = version.replace(/^[\^~>=<]+/, "").trim();
        packages.push({ name, version: cleaned, type: "direct" });
      }
    }

    return { packages };
  },
});
