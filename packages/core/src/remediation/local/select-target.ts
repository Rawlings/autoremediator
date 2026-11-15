import { queryOsvPackage } from "../../intelligence/sources/osv.js";
import { resolveSafeUpgradeVersion } from "../../intelligence/sources/registry.js";
import type { RegistryConfig } from "../../platform/registry-config.js";
import { verifyPackageTrust } from "../../platform/supply-chain.js";
import type { SupplyChainPolicy } from "../../platform/types.js";

/** Candidates examined per package; each one can cost a trust-gate and an advisory request. */
const MAX_CANDIDATES_CHECKED = 5;

export interface SkippedCandidate {
  version: string;
  reason: string;
}

export type TargetSelection =
  | { status: "selected"; version: string; knownAdvisories?: number; skipped: SkippedCandidate[] }
  | { status: "no-safe-version" }
  | { status: "trust-blocked"; version: string; reason?: string }
  /** Every fixed version was rejected earlier (see remediation memory). */
  | { status: "memory-blocked"; version: string; reason: string };

export interface SelectTargetParams {
  packageName: string;
  installedVersion: string;
  firstPatchedVersion: string;
  vulnerableRange?: string;
  registry?: RegistryConfig;
  supplyChainPolicy?: SupplyChainPolicy;
  /** Skip the advisory lookup on candidate versions (offline intelligence). */
  offline?: boolean;
  /** Versions of this package that remediation memory says were tried and rejected, with why. */
  rejected?: ReadonlyMap<string, string>;
}

export interface SelectTargetDeps {
  resolve: typeof resolveSafeUpgradeVersion;
  verifyTrust: typeof verifyPackageTrust;
  queryAdvisories: (packageName: string, version: string) => Promise<unknown[]>;
}

const defaultDeps: SelectTargetDeps = {
  resolve: resolveSafeUpgradeVersion,
  verifyTrust: verifyPackageTrust,
  queryAdvisories: queryOsvPackage,
};

/**
 * Choose the version to move to. Walks the fixed versions best-first and takes the first that
 * passes the supply-chain trust gate and has no known advisories of its own. A fixed version that
 * is itself vulnerable is only used when no clean one is available, because moving onto another
 * advisory is still progress. An advisory lookup that fails never blocks the choice.
 */
export async function selectUpgradeTarget(
  params: SelectTargetParams,
  deps: SelectTargetDeps = defaultDeps,
): Promise<TargetSelection> {
  const resolution = await deps.resolve(
    params.packageName,
    params.installedVersion,
    params.firstPatchedVersion,
    params.vulnerableRange,
    params.registry,
  );
  if (resolution.ordered.length === 0) return { status: "no-safe-version" };

  const skipped: SkippedCandidate[] = [];
  let firstBlocked: { version: string; reason?: string } | undefined;
  let withAdvisories: { version: string; count: number } | undefined;

  // Versions memory says were rejected are passed over, and do not use up the candidates examined.
  const remembered = resolution.ordered.filter((version) => params.rejected?.has(version));
  for (const version of remembered) {
    skipped.push({ version, reason: params.rejected!.get(version)! });
  }
  const candidates = resolution.ordered.filter((version) => !params.rejected?.has(version));
  if (candidates.length === 0 && remembered.length > 0) {
    const [first] = remembered;
    return { status: "memory-blocked", version: first!, reason: params.rejected!.get(first!)! };
  }

  for (const version of candidates.slice(0, MAX_CANDIDATES_CHECKED)) {
    const trust = await deps.verifyTrust(
      params.packageName,
      version,
      params.supplyChainPolicy,
      params.registry,
    );
    if (!trust.trusted) {
      firstBlocked ??= { version, reason: trust.reason };
      skipped.push({ version, reason: `supply-chain trust gate: ${trust.reason ?? "rejected"}` });
      continue;
    }

    if (params.offline) return { status: "selected", version, skipped };

    let count: number | undefined;
    try {
      count = (await deps.queryAdvisories(params.packageName, version)).length;
    } catch {
      count = undefined;
    }
    if (count === undefined || count === 0) {
      return { status: "selected", version, knownAdvisories: count, skipped };
    }
    withAdvisories ??= { version, count };
    skipped.push({ version, reason: `${count} known advisories` });
  }

  if (withAdvisories) {
    return {
      status: "selected",
      version: withAdvisories.version,
      knownAdvisories: withAdvisories.count,
      skipped: skipped.filter((entry) => entry.version !== withAdvisories.version),
    };
  }
  if (firstBlocked) return { status: "trust-blocked", ...firstBlocked };
  return { status: "no-safe-version" };
}

/** Suffix for result messages naming candidates passed over on the way to the chosen version. */
export function describeSkipped(skipped: SkippedCandidate[]): string {
  if (skipped.length === 0) return "";
  return ` Skipped ${skipped.map((entry) => `${entry.version} (${entry.reason})`).join(", ")}.`;
}
