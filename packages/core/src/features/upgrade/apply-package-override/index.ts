import { existsSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";
import { z } from "zod";

import {
  detectPackageManager,
  getYarnMajorVersion,
  resolveDedupeCommand,
  resolveInstallCommand,
} from "../../../infra/package-manager/index.js";
import { isPackageAllowed, loadPolicy } from "../../../infra/policy/policy.js";
import { resolveProjectTestCommand } from "../../memory/test-command.js";
import { defineTool } from "../../remediate/tools/tool-compat.js";
import type { PatchResult } from "../../remediate/types.js";
import { applyDenoOverride } from "./deno.js";
import { applyManifestOverride } from "./manifest.js";
import { unresolvedResult, type OverrideRequest } from "./transaction.js";

export const applyPackageOverrideTool = defineTool({
  description:
    "Apply a package-manager-native package.json override for a vulnerable transitive dependency and reinstall. Uses npm overrides, pnpm.overrides, yarn resolutions, bun overrides, or deno.json imports.",
  inputSchema: z.object({
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
  execute: async (input): Promise<PatchResult> => {
    const { cwd, packageName, fromVersion, toVersion, dryRun } = input;
    const pm = input.packageManager ?? detectPackageManager(cwd);
    const isDenoNative = pm === "deno" && !existsSync(join(cwd, "package.json"));
    const policy = loadPolicy(cwd, input.policy);
    const commandConstraints = {
      ...policy.constraints,
      installMode: input.installMode ?? policy.constraints?.installMode,
      installPreferOffline: input.installPreferOffline ?? policy.constraints?.installPreferOffline,
      enforceFrozenLockfile:
        input.enforceFrozenLockfile ?? policy.constraints?.enforceFrozenLockfile,
      workspace: input.workspace ?? policy.constraints?.workspace,
    };
    const request: OverrideRequest = {
      cwd,
      pm,
      packageName,
      fromVersion,
      toVersion,
      dryRun,
      runTests: input.runTests,
      commandConstraints,
      overrideSelector: input.selector?.trim() || packageName,
      installCommand: resolveInstallCommand(
        pm,
        commandConstraints,
        pm === "yarn" ? await getYarnMajorVersion(cwd) : undefined,
      ),
      testCommand: resolveProjectTestCommand(pm, commandConstraints, cwd),
      dedupeCommand: resolveDedupeCommand(pm, commandConstraints),
      patchesDir: input.patchesDir,
      proofOfFix: input.proofOfFix,
      reproductionTest: input.reproductionTest,
      requireProofOfFix: input.requireProofOfFix,
    };

    if (!isPackageAllowed(policy, packageName)) {
      return unresolvedResult(
        request,
        "policy-blocked",
        `Policy blocked changes for package "${packageName}".`,
        "none",
      );
    }
    const isMajorBump =
      semver.valid(fromVersion) &&
      semver.valid(toVersion) &&
      semver.major(toVersion) > semver.major(fromVersion);
    if (isMajorBump && !policy.allowMajorBumps) {
      return unresolvedResult(
        request,
        "major-bump-required",
        `Policy blocked major override for "${packageName}" (${fromVersion} -> ${toVersion}).`,
        "none",
      );
    }
    return isDenoNative ? applyDenoOverride(request) : applyManifestOverride(request);
  },
});
