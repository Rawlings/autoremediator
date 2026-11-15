import semver from "semver";

import type { RemediationConstraints, RemediationReport } from "../platform/types.js";
import type { RepoFingerprint } from "./fingerprint.js";
import { canonicalJson, sha256 } from "./hash.js";

/** The options a plan needs to be applied exactly as it was previewed. */
export interface PlanOptions {
  packageManager?: string;
  policy?: string;
  runTests?: boolean;
  typecheck?: boolean;
  patchesDir?: string;
  proofOfFix?: boolean;
  requireProofOfFix?: boolean;
  reproductionTest?: string;
  breakingChangeRefactor?: boolean;
  /** The plan was made with remediation memory ignored, so applying it does not consult memory either. */
  ignoreMemory?: boolean;
  constraints?: RemediationConstraints;
}

/** One change a plan will make. */
export interface PlanItem {
  itemId: string;
  cveId: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  strategy: "version-bump" | "override";
  dependencyScope?: "direct" | "transitive";
  /** The change goes back to an older version (an incident rollback), pinned exactly. Review it as such. */
  rollback?: true;
  /** What the pipeline's disposition policy said when previewing; shown to whoever reviews the plan. */
  disposition?: string;
  dispositionReason?: string;
}

/** A finding the plan cannot act on by itself, with why. */
export interface PlanSkip {
  cveId: string;
  packageName: string;
  fromVersion: string;
  strategy: string;
  reason: string;
  unresolvedReason?: string;
}

export interface RemediationPlan {
  schemaVersion: "1";
  planId: string;
  runId: string;
  createdAt: string;
  cwd: string;
  cveIds: string[];
  base: RepoFingerprint;
  options: PlanOptions;
  items: PlanItem[];
  skipped: PlanSkip[];
}

const isRollback = (from: string, to: string): boolean =>
  semver.valid(from) !== null && semver.valid(to) !== null && semver.lt(to, from);

const itemIdOf = (item: Omit<PlanItem, "itemId">): string =>
  `item_${sha256(canonicalJson([item.cveId, item.packageName, item.fromVersion, item.toVersion, item.strategy])).slice(0, 12)}`;

/**
 * Turn a preview report into a plan. Version bumps and overrides carry the exact target version the
 * preview chose, so applying them does not depend on re-deciding anything. A model-generated patch
 * cannot be replayed from a preview and is listed as skipped with the reason.
 */
export function buildPlan(input: {
  runId: string;
  cwd: string;
  report: RemediationReport;
  base: RepoFingerprint;
  options: PlanOptions;
  createdAt?: string;
}): RemediationPlan {
  const { report } = input;
  const items: PlanItem[] = [];
  const skipped: PlanSkip[] = [];

  for (const result of report.results) {
    const replayable =
      (result.strategy === "version-bump" || result.strategy === "override") &&
      result.toVersion !== undefined &&
      result.unresolvedReason === undefined;

    if (replayable) {
      const draft = {
        cveId: report.cveId,
        packageName: result.packageName,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion!,
        strategy: result.strategy as "version-bump" | "override",
        ...(result.dependencyScope ? { dependencyScope: result.dependencyScope } : {}),
        ...(isRollback(result.fromVersion, result.toVersion!) ? { rollback: true as const } : {}),
        ...(result.disposition ? { disposition: result.disposition } : {}),
        ...(result.dispositionReason ? { dispositionReason: result.dispositionReason } : {}),
      };
      items.push({ itemId: itemIdOf(draft), ...draft });
      continue;
    }

    skipped.push({
      cveId: report.cveId,
      packageName: result.packageName,
      fromVersion: result.fromVersion,
      strategy: result.strategy,
      reason: describeSkip(result),
      ...(result.unresolvedReason ? { unresolvedReason: result.unresolvedReason } : {}),
    });
  }

  const content = {
    cveIds: [report.cveId],
    base: input.base,
    options: input.options,
    items,
    skipped,
  };

  return {
    schemaVersion: "1",
    planId: `plan_${sha256(canonicalJson(content)).slice(0, 16)}`,
    runId: input.runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    cwd: input.cwd,
    ...content,
  };
}

function describeSkip(result: RemediationReport["results"][number]): string {
  if (result.suppressedBy) {
    const source = result.suppressedBy.source === "maintainer-vex" ? " by maintainer VEX" : "";
    return `suppressed${source} (${result.suppressedBy.justification})`;
  }
  if (result.strategy === "patch-file") {
    return "needs a generated patch, which is produced when applied and cannot be previewed exactly";
  }
  return result.message;
}
