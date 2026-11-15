/** Overrides for a native Deno project: the `imports` map in `deno.json` (there is no package.json). */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withRepoLock } from "../../../infra/repo-lock.js";
import type { PatchResult } from "../../remediate/types.js";
import {
  collectDependencyTrace,
  getDenoJsonImportValue,
  restoreDenoJsonImportValue,
  setDenoJsonImportValue,
  type DenoJson,
} from "./helpers.js";
import { runOverrideTransaction, unresolvedResult, type OverrideRequest } from "./transaction.js";

export async function applyDenoOverride(request: OverrideRequest): Promise<PatchResult> {
  const { cwd, pm, packageName, overrideSelector, fromVersion, toVersion, dryRun } = request;
  const denoJsonPath = join(cwd, "deno.json");
  let denoJson: DenoJson;
  try {
    denoJson = JSON.parse(readFileSync(denoJsonPath, "utf8")) as DenoJson;
  } catch {
    return unresolvedResult(
      request,
      "package-json-not-found",
      `Could not read deno.json at "${denoJsonPath}".`,
      "none",
    );
  }

  const existing = getDenoJsonImportValue(denoJson, overrideSelector);
  if (!existing) {
    return unresolvedResult(
      request,
      "transitive-override-unsupported-deno-native",
      `Cannot apply transitive override for "${overrideSelector}" in a native Deno project (no package.json). Only direct dependencies declared in deno.json imports can be overridden.`,
      "none",
    );
  }

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
      message: `[DRY RUN] Would update deno.json imports["${existing.key}"] to "npm:${overrideSelector}@${toVersion}", then run ${request.installCommand.join(" ")}.${traceSuffix}`,
    };
  }

  const save = (): void => {
    writeFileSync(denoJsonPath, `${JSON.stringify(denoJson, null, 2)}\n`, "utf8");
  };
  return withRepoLock(cwd, () =>
    runOverrideTransaction(
      { ...request, traceSuffix },
      {
        appliedPhrase: `updating deno.json imports for "${overrideSelector}" to ${toVersion}`,
        successPhrase: `updated deno.json imports["${existing.key}"] for "${overrideSelector}"`,
        dedupe: false,
        write: () => {
          setDenoJsonImportValue(denoJson, overrideSelector, toVersion);
          save();
        },
        restore: () => {
          restoreDenoJsonImportValue(denoJson, overrideSelector, existing);
          save();
        },
      },
    ),
  );
}
