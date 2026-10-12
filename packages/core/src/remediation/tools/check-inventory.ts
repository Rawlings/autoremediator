/**
 * Tool: check-inventory
 *
 * Reads the consumer's package.json and installed dependency tree to produce
 * a flat list of installed packages and their resolved versions.
 */
import { defineTool } from "./tool-compat.js";
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
} from "../../platform/package-manager/index.js";
import { resolveDenoInventory } from "../../platform/package-manager/list-parser.js";
import { loadPolicy } from "../../platform/policy.js";
import semver from "semver";
import { findDeclaringWorkspacePackage } from "../../platform/workspace.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export function resolveInventoryVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim();
  if (semver.valid(trimmed)) {
    return semver.clean(trimmed) ?? trimmed;
  }

  let spec = trimmed;
  if (spec.startsWith("npm:") && spec.includes("@")) {
    spec = spec.slice(spec.lastIndexOf("@") + 1);
  }
  if (spec.startsWith("workspace:")) {
    spec = spec.slice("workspace:".length).trim();
  }

  if (semver.valid(spec)) {
    return semver.clean(spec) ?? spec;
  }

  try {
    const min = semver.minVersion(spec);
    if (min?.version && semver.valid(min.version)) {
      return min.version;
    }
  } catch {
    // Invalid semver range syntax
  }

  try {
    const coerced = semver.coerce(spec);
    if (coerced?.version && semver.valid(coerced.version)) {
      return coerced.version;
    }
  } catch {
    // Coercion failure
  }

  return semver.clean(trimmed) ?? trimmed;
}

export const checkInventoryTool = defineTool({
  description:
    "Read the project's package.json and installed dependencies to list packages and exact versions. Must be called before checking version matches.",
  parameters: z.object({
    cwd: z.string().describe("Absolute path to the consumer project's root directory"),
    packageManager: z
      .enum(["npm", "pnpm", "yarn", "bun", "deno"])
      .optional()
      .describe("Package manager used by the target project (auto-detected if omitted)"),
    policy: z
      .string()
      .optional()
      .describe("Optional path to .github/autoremediator.yml policy file"),
    workspace: z.string().optional().describe("Optional workspace/package selector for monorepos"),
  }),
  execute: async ({
    cwd,
    packageManager,
    policy,
    workspace,
  }): Promise<{ packages: InventoryPackage[]; error?: string }> => {
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

    if (pm === "deno") {
      // Deno inventory is built from deno.lock directly, not a shell command.
      installedVersions = resolveDenoInventory(cwd);
    } else {
      try {
        const [cmd, ...args] = listCommand;
        if (cmd) {
          const listResult = await execa(cmd, args, {
            cwd,
            stdio: "pipe",
            reject: false,
          });
          installedVersions = parseListOutput(pm, listResult.stdout || "");
        }
      } catch {
        // Fallback to package.json-only view when list command fails.
      }
    }

    const packages: InventoryPackage[] = [];

    for (const [name, version] of installedVersions.entries()) {
      const declaringWorkspace = findDeclaringWorkspacePackage(cwd, name, workspace);
      const isDirect =
        Boolean(pkgJson.dependencies?.[name]) ||
        Boolean(pkgJson.devDependencies?.[name]) ||
        Boolean(pkgJson.peerDependencies?.[name]) ||
        Boolean(declaringWorkspace);

      packages.push({
        name,
        version,
        type: isDirect ? "direct" : "transitive",
      });
    }

    if (packages.length === 0) {
      // Fallback: direct deps from package.json (best-effort versions)
      const allDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
        ...pkgJson.peerDependencies,
      };
      for (const [name, rawVersion] of Object.entries(allDeps)) {
        const version = resolveInventoryVersion(rawVersion);
        packages.push({ name, version, type: "direct" });
      }
    }

    return { packages };
  },
});
