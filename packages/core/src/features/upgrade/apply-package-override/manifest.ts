/** Overrides written into `package.json` (npm, yarn, bun, pnpm) or `pnpm-workspace.yaml` (pnpm 10+). */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPnpmMajorVersion } from "../../../infra/package-manager/index.js";
import { withRepoLock } from "../../../infra/repo-lock.js";
import type { PatchResult } from "../../remediate/types.js";
import { serializeManifest } from "../manifest-format.js";
import {
  collectDependencyTrace,
  describeOverrideField,
  setOverrideValue,
  type RawPackageJson,
} from "./helpers.js";
import {
  PNPM_WORKSPACE_OVERRIDES_FROM,
  pnpmLockRecordsOverride,
  readWorkspaceYaml,
  restoreWorkspaceYaml,
  setWorkspaceOverride,
} from "./pnpm-workspace.js";
import { runOverrideTransaction, unresolvedResult, type OverrideRequest } from "./transaction.js";

function dryRunMessage(request: OverrideRequest, label: string, traceSuffix: string): string {
  const { overrideSelector, toVersion, installCommand, testCommand, dedupeCommand } = request;
  const tests = request.runTests ? ` and ${testCommand.join(" ")}` : "";
  const dedupe = dedupeCommand.length > 0 ? ` and ${dedupeCommand.join(" ")} (best-effort)` : "";
  return `[DRY RUN] Would set ${label}.${overrideSelector} to "${toVersion}", then run ${installCommand.join(" ")}${tests}${dedupe}.${traceSuffix}`;
}

export async function applyManifestOverride(request: OverrideRequest): Promise<PatchResult> {
  const { cwd, pm, packageName, overrideSelector, fromVersion, toVersion, dryRun } = request;
  const manifestPath = join(cwd, "package.json");
  let manifest: RawPackageJson;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RawPackageJson;
  } catch {
    return unresolvedResult(
      request,
      "package-json-not-found",
      `Could not read package.json at "${manifestPath}".`,
      "none",
    );
  }

  const pnpmMajor = pm === "pnpm" ? await getPnpmMajorVersion(cwd) : undefined;
  const useWorkspaceYaml = pm === "pnpm" && (pnpmMajor ?? 0) >= PNPM_WORKSPACE_OVERRIDES_FROM;
  const label = useWorkspaceYaml ? "overrides in pnpm-workspace.yaml" : describeOverrideField(pm);
  const trace = await collectDependencyTrace(cwd, pm, packageName, request.commandConstraints);
  const traceSuffix = trace ? ` Dependency trace: ${trace}` : "";
  if (dryRun) {
    return {
      packageName,
      strategy: "override",
      fromVersion,
      toVersion,
      applied: false,
      dryRun: true,
      message: dryRunMessage(request, label, traceSuffix),
    };
  }

  // Read inside the lock, after the proof-of-fix stage, so the snapshot is what is on disk now.
  let originalManifest = "";
  let originalWorkspace: ReturnType<typeof readWorkspaceYaml>;
  return withRepoLock(cwd, () =>
    runOverrideTransaction(
      { ...request, traceSuffix },
      {
        appliedPhrase: `applying ${label} for "${overrideSelector}" to ${toVersion}`,
        successPhrase: `applied ${label} for "${overrideSelector}"`,
        dedupe: true,
        write: () => {
          originalManifest = readFileSync(manifestPath, "utf8");
          originalWorkspace = useWorkspaceYaml ? readWorkspaceYaml(cwd) : undefined;
          if (useWorkspaceYaml) {
            setWorkspaceOverride(cwd, overrideSelector, toVersion);
          } else {
            setOverrideValue(manifest, pm, overrideSelector, toVersion);
            writeFileSync(manifestPath, serializeManifest(originalManifest, manifest), "utf8");
          }
        },
        restore: () => {
          writeFileSync(manifestPath, originalManifest, "utf8");
          if (useWorkspaceYaml) restoreWorkspaceYaml(cwd, originalWorkspace);
        },
        checkEffective: () =>
          pm === "pnpm" && pnpmLockRecordsOverride(cwd, overrideSelector) === false
            ? `pnpm did not record the ${label} override for "${overrideSelector}" in pnpm-lock.yaml, so it had no effect. Reverted.`
            : undefined,
      },
    ),
  );
}
