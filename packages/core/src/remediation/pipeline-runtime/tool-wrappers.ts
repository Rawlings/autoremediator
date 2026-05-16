import type { RemediateOptions } from "../../platform/types.js";
import { applyPackageOverrideTool } from "../tools/apply-package-override/index.js";
import { applyPatchFileTool } from "../tools/apply-patch-file/index.js";
import { applyVersionBumpTool } from "../tools/apply-version-bump.js";
import { checkInventoryTool } from "../tools/check-inventory.js";
import { buildRuntimeTools } from "../runtime-tools.js";

export function createRuntimeToolsForRun(options: RemediateOptions) {
  const preview = options.preview ?? false;
  const constraints = options.constraints ?? {};
  const policy = options.policy ?? "";

  const checkInventoryToolForRun = {
    ...checkInventoryTool,
    execute: async (input: Record<string, unknown>) =>
      (checkInventoryTool as any).execute({
        ...input,
        policy,
        workspace: constraints.workspace,
      }),
  };

  const applyVersionBumpToolForRun = {
    ...applyVersionBumpTool,
    execute: async (input: Record<string, unknown>) =>
      (applyVersionBumpTool as any).execute({
        ...input,
        policy,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        dryRun: preview ? true : input.dryRun,
      }),
  };

  const applyPackageOverrideToolForRun = {
    ...applyPackageOverrideTool,
    execute: async (input: Record<string, unknown>) =>
      (applyPackageOverrideTool as any).execute({
        ...input,
        policy,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        dryRun: preview ? true : input.dryRun,
      }),
  };

  const applyPatchFileToolForRun = {
    ...applyPatchFileTool,
    execute: async (input: Record<string, unknown>) =>
      (applyPatchFileTool as any).execute({
        ...input,
        policy,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        dryRun: preview ? true : input.dryRun,
      }),
  };

  const tools = buildRuntimeTools({
    checkInventoryToolForRun,
    applyVersionBumpToolForRun,
    applyPackageOverrideToolForRun,
    applyPatchFileToolForRun,
    constraints,
  });

  if (options.offlineIntelligence) {
    const offlineMessage = options.intelligenceSnapshotPath
      ? `Offline mode: intelligence lookup via snapshot only. No live network calls.`
      : `Offline mode: intelligence lookup skipped (no snapshot provided).`;

    (tools as Record<string, unknown>)["lookup-cve"] = {
      ...((tools as Record<string, unknown>)["lookup-cve"] as Record<string, unknown>),
      execute: async (_input: Record<string, unknown>) => ({
        cveId: ((_input as { cveId?: string }).cveId ?? "unknown").toUpperCase(),
        found: false,
        offlineMode: true,
        message: offlineMessage,
      }),
    };
  }

  return tools;
}