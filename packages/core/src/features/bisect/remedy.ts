import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../../shared/hash.js";
import type { PackageManager } from "../../shared/types.js";
import type { PatchResult, RemediationReport } from "../remediate/types.js";
import { applyPlan, persistPlan } from "../runs/index.js";
import { parseLockfileDependencies } from "../scan/lockfile-diff.js";
import { directDependencyNames, type ManifestLike } from "./changes.js";
import type { BisectedPackage, BisectRemedy } from "./types.js";

export interface RemedyRequest {
  cwd: string;
  packageManager: PackageManager;
  /** Lockfile name relative to `cwd`. */
  lockfile: string;
  culprits: readonly BisectedPackage[];
  goodCommit: string;
  badCommit: string;
  command: string;
  apply: boolean;
  applyPlanFn?: typeof applyPlan;
}

function readLocked(cwd: string, lockfile: string): Map<string, Set<string>> | undefined {
  const path = join(cwd, lockfile);
  if (!existsSync(path)) return undefined;
  return parseLockfileDependencies(lockfile, readFileSync(path, "utf8"));
}

function readDirect(cwd: string): Set<string> {
  try {
    return directDependencyNames(
      JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as ManifestLike,
    );
  } catch {
    return new Set();
  }
}

/**
 * The recommended remedy: pin each culprit back to the version it had at the good ref, recorded as a
 * plan in the project's run store like any other (`autoremediator plan`). Nothing is changed unless
 * `apply` is set, and then only through the same `applyPlan` that `runs apply` uses.
 *
 * The plan is made against the working tree as it is now, so a culprit that the working tree no longer
 * holds at its bad version (already fixed, or the checkout is somewhere else) is reported, not planned.
 */
export async function planRemedy(request: RemedyRequest): Promise<BisectRemedy> {
  const locked = readLocked(request.cwd, request.lockfile);
  const direct = readDirect(request.cwd);
  const notPlanned: BisectRemedy["notPlanned"] = [];
  const results: PatchResult[] = [];

  for (const culprit of request.culprits) {
    const versions = locked?.get(culprit.packageName);
    if (!locked) {
      notPlanned.push({
        packageName: culprit.packageName,
        reason: `${request.lockfile} does not exist in ${request.cwd}`,
      });
    } else if (!versions?.has(culprit.toVersion)) {
      notPlanned.push({
        packageName: culprit.packageName,
        reason: versions?.size
          ? `the working tree locks ${[...versions].toSorted().join(", ")}, not ${culprit.toVersion}`
          : "the working tree does not lock this package",
      });
    } else {
      const scope = direct.has(culprit.packageName) ? "direct" : "transitive";
      results.push({
        packageName: culprit.packageName,
        strategy: scope === "direct" ? "version-bump" : "override",
        fromVersion: culprit.toVersion,
        toVersion: culprit.fromVersion,
        applied: false,
        dryRun: true,
        dependencyScope: scope,
        message: `Pin ${culprit.packageName} back to ${culprit.fromVersion}: ${culprit.toVersion} breaks \`${request.command}\`.`,
      });
    }
  }

  const pins = results.map((result) => ({
    packageName: result.packageName,
    version: result.toVersion ?? "",
    strategy: result.strategy as "version-bump" | "override",
  }));
  if (results.length === 0) return { pins, nextCommands: [], notPlanned };

  const cveId = `BISECT-${sha256(`${request.goodCommit}\n${request.badCommit}\n${request.command}`).slice(0, 8)}`;
  const report: RemediationReport = {
    cveId,
    cveDetails: null,
    vulnerablePackages: [],
    results,
    summary: `Lockfile bisect ${request.goodCommit.slice(0, 12)}..${request.badCommit.slice(0, 12)}: pin ${results
      .map((result) => `${result.packageName}@${result.toVersion}`)
      .join(", ")}.`,
  };
  const { runId, planId } = await persistPlan(
    report,
    { cwd: request.cwd, packageManager: request.packageManager },
    request.cwd,
  );

  const remedy: BisectRemedy = {
    pins,
    runId,
    planId,
    nextCommands: [
      `autoremediator runs show ${runId}`,
      `autoremediator runs apply ${runId}`,
      `autoremediator runs rollback ${runId}`,
    ],
    notPlanned,
  };
  if (!request.apply) return remedy;

  const run = await (request.applyPlanFn ?? applyPlan)({ cwd: request.cwd, runId });
  const after = readLocked(request.cwd, request.lockfile);
  const unchanged = pins.filter((pin) => {
    const versions = after?.get(pin.packageName);
    return !(versions?.size === 1 && versions.has(pin.version));
  });
  const effective = unchanged.length === 0;
  return {
    ...remedy,
    applied: {
      status: run.status,
      effective,
      items: run.items,
      note: effective
        ? "The lockfile now holds the good version of every pinned package."
        : `The run finished ${run.status}, but the lockfile does not hold the good version of ${unchanged
            .map((pin) => `${pin.packageName}@${pin.version}`)
            .join(
              ", ",
            )}. The package manager may be ignoring the override it was given (pnpm 11 and later read overrides from pnpm-workspace.yaml, not package.json); roll the run back with \`autoremediator runs rollback ${runId}\` or pin it by hand.`,
    },
  };
}
