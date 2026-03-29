import { lookupCveTool } from "./tools/lookup-cve.js";
import { checkInventoryTool } from "./tools/check-inventory.js";
import { checkVersionMatchTool } from "./tools/check-version-match.js";
import { findFixedVersionTool } from "./tools/find-fixed-version.js";
import { applyVersionBumpTool } from "./tools/apply-version-bump.js";
import { applyPackageOverrideTool } from "./tools/apply-package-override.js";
import { fetchPackageSourceTool } from "./tools/fetch-package-source.js";
import { generatePatchTool } from "./tools/generate-patch.js";
import { applyPatchFileTool } from "./tools/apply-patch-file.js";

interface RuntimeToolContext {
  applyVersionBumpToolForRun: typeof applyVersionBumpTool;
  applyPackageOverrideToolForRun: typeof applyPackageOverrideTool;
  applyPatchFileToolForRun: typeof applyPatchFileTool;
  constraints: {
    directDependenciesOnly?: boolean;
    preferVersionBump?: boolean;
  };
}

export function buildRuntimeTools(ctx: RuntimeToolContext): Record<string, unknown> {
  const tools = {
    "lookup-cve": lookupCveTool,
    "check-inventory": checkInventoryTool,
    "check-version-match": checkVersionMatchTool,
    "find-fixed-version": findFixedVersionTool,
    "apply-version-bump": ctx.applyVersionBumpToolForRun,
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
