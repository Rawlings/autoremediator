import { lookupCveTool } from "./tools/lookup-cve.js";
import { checkInventoryTool } from "./tools/check-inventory.js";
import { checkVersionMatchTool } from "./tools/check-version-match.js";
import { findFixedVersionTool } from "./tools/find-fixed-version.js";
import { applyVersionBumpTool } from "./tools/apply-version-bump.js";
import { applyPackageOverrideTool } from "./tools/apply-package-override/index.js";
import { fetchPackageSourceTool } from "./tools/fetch-package-source.js";
import { generatePatchTool } from "./tools/generate-patch/index.js";
import { applyPatchFileTool } from "./tools/apply-patch-file/index.js";
import { checkSuppressionTool } from "./tools/check-suppression.js";
import { checkExploitSignalTool } from "./tools/check-exploit-signal.js";
import { checkReachabilityTool } from "./tools/check-reachability.js";

interface RuntimeToolLike {
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
  [key: string]: unknown;
}

interface RuntimeToolContext {
  checkInventoryToolForRun: RuntimeToolLike;
  applyVersionBumpToolForRun: RuntimeToolLike;
  applyPackageOverrideToolForRun: RuntimeToolLike;
  applyPatchFileToolForRun: RuntimeToolLike;
  constraints: {
    directDependenciesOnly?: boolean;
    preferVersionBump?: boolean;
    workspace?: string;
    installMode?: "standard" | "prefer-offline" | "deterministic";
    installPreferOffline?: boolean;
    enforceFrozenLockfile?: boolean;
  };
}

export function buildRuntimeTools(ctx: RuntimeToolContext): Record<string, unknown> {
  const tools = {
    "lookup-cve": lookupCveTool,
    "check-inventory": ctx.checkInventoryToolForRun,
    "check-version-match": checkVersionMatchTool,
    "find-fixed-version": findFixedVersionTool,
    "apply-version-bump": ctx.applyVersionBumpToolForRun,
    "check-suppression": checkSuppressionTool,
    "check-exploit-signal": checkExploitSignalTool,
    "check-reachability": checkReachabilityTool,
  } as Record<string, unknown>;

  if (!ctx.constraints.directDependenciesOnly && !ctx.constraints.preferVersionBump) {
    tools["apply-package-override"] = ctx.applyPackageOverrideToolForRun;
  }

  if (!ctx.constraints.preferVersionBump) {
    tools["fetch-package-source"] = fetchPackageSourceTool;
    tools["generate-patch"] = generatePatchTool;
    tools["apply-patch-file"] = ctx.applyPatchFileToolForRun;
  }

  return tools;
}
