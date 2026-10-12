import { existsSync } from "node:fs";
import type { RemediateOptions } from "../../platform/types.js";
import {
  loadIntelligenceSnapshot,
  lookupSnapshotCve,
  type IntelligenceSnapshot,
} from "../../intelligence/sources/snapshot.js";
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
    execute: async (input: Parameters<typeof checkInventoryTool.execute>[0]) =>
      checkInventoryTool.execute({
        ...input,
        policy,
        workspace: constraints.workspace,
      }),
  };

  const applyVersionBumpToolForRun = {
    ...applyVersionBumpTool,
    execute: async (input: Parameters<typeof applyVersionBumpTool.execute>[0]) =>
      applyVersionBumpTool.execute({
        ...input,
        policy,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        typecheck: input.typecheck ?? options.typecheck ?? constraints.typecheck,
        breakingChangeRefactor:
          input.breakingChangeRefactor ??
          options.breakingChangeRefactor ??
          constraints.enableBreakingChangeRefactor,
        proofOfFix: input.proofOfFix ?? options.proofOfFix,
        requireProofOfFix:
          input.requireProofOfFix ?? options.requireProofOfFix ?? constraints.requireProofOfFix,
        reproductionTest: input.reproductionTest ?? options.reproductionTest,
        patchesDir: input.patchesDir ?? options.patchesDir,
        dryRun: preview ? true : input.dryRun,
      }),
  };

  const applyPackageOverrideToolForRun = {
    ...applyPackageOverrideTool,
    execute: async (input: Parameters<typeof applyPackageOverrideTool.execute>[0]) =>
      applyPackageOverrideTool.execute({
        ...input,
        policy,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        proofOfFix: input.proofOfFix ?? options.proofOfFix,
        requireProofOfFix:
          input.requireProofOfFix ?? options.requireProofOfFix ?? constraints.requireProofOfFix,
        reproductionTest: input.reproductionTest ?? options.reproductionTest,
        patchesDir: input.patchesDir ?? options.patchesDir,
        dryRun: preview ? true : input.dryRun,
      }),
  };

  const applyPatchFileToolForRun = {
    ...applyPatchFileTool,
    execute: async (input: Parameters<typeof applyPatchFileTool.execute>[0]) =>
      applyPatchFileTool.execute({
        ...input,
        policy,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        proofOfFix: input.proofOfFix ?? options.proofOfFix,
        requireProofOfFix:
          input.requireProofOfFix ?? options.requireProofOfFix ?? constraints.requireProofOfFix,
        reproductionTest: input.reproductionTest ?? options.reproductionTest,
        patchesDir: input.patchesDir ?? options.patchesDir,
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
    let snapshot: IntelligenceSnapshot | null = null;
    if (options.intelligenceSnapshotPath && existsSync(options.intelligenceSnapshotPath)) {
      try {
        snapshot = loadIntelligenceSnapshot(options.intelligenceSnapshotPath);
      } catch (err) {
        const _ignored = err;
        snapshot = null;
      }
    }

    (tools as Record<string, unknown>)["lookup-cve"] = {
      ...((tools as Record<string, unknown>)["lookup-cve"] as Record<string, unknown>),
      execute: async (_input: Record<string, unknown>) => {
        const cveId = ((_input as { cveId?: string }).cveId ?? "unknown").toUpperCase();
        if (snapshot) {
          const details = lookupSnapshotCve(snapshot, cveId);
          if (details) {
            return {
              success: true,
              found: true,
              cveId,
              offlineMode: true,
              data: details,
              message: `Offline mode: intelligence lookup resolved from snapshot for ${cveId}.`,
            };
          }
          return {
            success: false,
            found: false,
            cveId,
            offlineMode: true,
            error: `Offline mode: ${cveId} not found in intelligence snapshot.`,
            message: `Offline mode: ${cveId} not found in intelligence snapshot.`,
          };
        }

        const snapshotErrorMsg = options.intelligenceSnapshotPath
          ? `Offline mode: intelligence snapshot file not found or invalid at ${options.intelligenceSnapshotPath}.`
          : `Offline mode: intelligence lookup skipped (no snapshot provided).`;

        return {
          success: false,
          found: false,
          cveId,
          offlineMode: true,
          error: snapshotErrorMsg,
          message: snapshotErrorMsg,
        };
      },
    };
  }

  return tools;
}
