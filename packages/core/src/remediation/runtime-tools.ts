import type { Tool } from "ai";
import { lookupCveTool } from "./tools/lookup-cve.js";
import { checkVersionMatchTool } from "./tools/check-version-match.js";
import { findFixedVersionTool } from "./tools/find-fixed-version.js";
import { fetchPackageSourceTool } from "./tools/fetch-package-source.js";
import { generatePatchTool } from "./tools/generate-patch/index.js";
import { checkSuppressionTool } from "./tools/check-suppression.js";
import { checkExploitSignalTool } from "./tools/check-exploit-signal.js";
import { checkReachabilityTool } from "./tools/check-reachability.js";

interface RuntimeToolLike {
  description?: string;
  parameters?: unknown;
  execute: (input: any) => Promise<unknown> | unknown;
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

export function buildRuntimeTools(ctx: RuntimeToolContext): Record<string, Tool> {
  const tools: Record<string, Tool> = {
    "lookup-cve": lookupCveTool as unknown as Tool,
    "check-inventory": ctx.checkInventoryToolForRun as unknown as Tool,
    "check-version-match": checkVersionMatchTool as unknown as Tool,
    "find-fixed-version": findFixedVersionTool as unknown as Tool,
    "apply-version-bump": ctx.applyVersionBumpToolForRun as unknown as Tool,
    "check-suppression": checkSuppressionTool as unknown as Tool,
    "check-exploit-signal": checkExploitSignalTool as unknown as Tool,
    "check-reachability": checkReachabilityTool as unknown as Tool,
  };

  if (!ctx.constraints.directDependenciesOnly && !ctx.constraints.preferVersionBump) {
    tools["apply-package-override"] = ctx.applyPackageOverrideToolForRun as unknown as Tool;
  }

  if (!ctx.constraints.preferVersionBump) {
    tools["fetch-package-source"] = fetchPackageSourceTool as unknown as Tool;
    tools["generate-patch"] = generatePatchTool as unknown as Tool;
    tools["apply-patch-file"] = ctx.applyPatchFileToolForRun as unknown as Tool;
  }

  return tools;
}
