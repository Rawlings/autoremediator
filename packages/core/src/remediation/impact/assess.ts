/**
 * Orchestration: fetch the two versions of a package from the registry and run the pure analyses.
 * The registry access is a dependency so tests and embedders need no network.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";

import {
  classifyUpgradeLevel,
  downloadTarball,
  getTarballInfo,
  verifyTarballIntegrity,
} from "../../intelligence/sources/registry.js";
import { loadRegistryConfig } from "../../platform/registry-config.js";
import type { ReachabilityAssessment } from "../../platform/types.js";
import { assessSymbolsReachability } from "../tools/check-reachability.js";
import { findVulnerableSymbols, type AdvisoryHints, type FixDiff, type VulnerableSymbolCandidate } from "./fix-diff.js";
import { analyzeUpgrade, type UpgradeImpact } from "./impact.js";
import { readPackageTarball } from "./tarball.js";
import type { PackageSource } from "./types.js";
import { buildUsageIndex } from "./usage-index.js";

export interface ImpactDeps {
  /** Fetch and read one published version; throws if it does not exist or fails verification. */
  loadPackage(packageName: string, version: string, cwd: string): Promise<PackageSource>;
}

export const defaultImpactDeps: ImpactDeps = {
  async loadPackage(packageName, version, cwd) {
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) {
      throw new Error(`Invalid package name: ${packageName}`);
    }
    if (!semver.valid(version)) throw new Error(`Not an exact version: ${version}`);
    const registry = loadRegistryConfig(cwd);
    const info = await getTarballInfo(packageName, version, registry);
    if (!info) throw new Error(`${packageName}@${version} was not found on the registry`);
    const bytes = await downloadTarball(info, registry);
    const integrity = verifyTarballIntegrity(bytes, info);
    if (!integrity.ok) {
      throw new Error(`Refusing ${packageName}@${version}: tarball failed verification (${integrity.reason})`);
    }
    const { files, manifest } = readPackageTarball(bytes);
    return { name: packageName, version, files, manifest, integrityVerified: integrity.verified };
  },
};

export interface AssessUpgradeOptions {
  /** Project root whose source is scanned and whose `.npmrc` selects the registry. */
  cwd?: string;
}

export interface AssessUpgradeResult extends UpgradeImpact {
  upgradeLevel?: "patch" | "minor" | "major";
}

function readProjectManifest(cwd: string): Record<string, unknown> | undefined {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function assertDistinctVersions(from: string, to: string): void {
  if (!semver.valid(from) || !semver.valid(to)) {
    throw new Error(`Versions must be exact semver versions (got "${from}" and "${to}")`);
  }
  if (semver.eq(from, to)) throw new Error("The two versions are the same");
}

/** How risky is moving `packageName` from `from` to `to` for the project at `cwd`? */
export async function assessUpgrade(
  packageName: string,
  from: string,
  to: string,
  options: AssessUpgradeOptions = {},
  deps: ImpactDeps = defaultImpactDeps,
): Promise<AssessUpgradeResult> {
  assertDistinctVersions(from, to);
  const cwd = options.cwd ?? process.cwd();
  const [before, after] = await Promise.all([
    deps.loadPackage(packageName, from, cwd),
    deps.loadPackage(packageName, to, cwd),
  ]);
  const usage = buildUsageIndex(cwd, packageName);
  const impact = analyzeUpgrade({ before, after, usage, projectManifest: readProjectManifest(cwd) });
  return {
    ...impact,
    upgradeLevel: semver.gt(to, from) ? classifyUpgradeLevel(from, to) : undefined,
  };
}

export interface FindVulnerableSymbolsOptions {
  cwd?: string;
  /** Advisory summary or details, used only to rank candidates. */
  advisoryText?: string;
  /** CWE identifiers, used only to rank candidates. */
  cwes?: string[];
  /** Largest number of candidates returned (default 25). */
  limit?: number;
  /** Check each candidate against the project's source (default true). */
  checkReachability?: boolean;
}

export interface SymbolReachability {
  status: ReachabilityAssessment["status"];
  reason: string;
  basis?: ReachabilityAssessment["reachabilityBasis"];
  /** Files in the project that invoke the symbol. */
  invokedIn: string[];
}

export interface RankedVulnerableSymbol extends VulnerableSymbolCandidate {
  /** Present when the project was checked. */
  reachability?: SymbolReachability;
}

export interface VulnerableSymbolsResult extends Omit<FixDiff, "candidates"> {
  candidates: RankedVulnerableSymbol[];
  /** How many of the returned candidates the project's code reaches. */
  reachableCount?: number;
}

/**
 * Candidate vulnerable symbols from the diff between a vulnerable version and its fix, each checked
 * for reachability from the project. HEURISTIC: see `findVulnerableSymbols` in `fix-diff.ts`.
 */
export async function findVulnerableSymbolsInUpgrade(
  packageName: string,
  vulnerableVersion: string,
  fixedVersion: string,
  options: FindVulnerableSymbolsOptions = {},
  deps: ImpactDeps = defaultImpactDeps,
): Promise<VulnerableSymbolsResult> {
  assertDistinctVersions(vulnerableVersion, fixedVersion);
  const cwd = options.cwd ?? process.cwd();
  const [vulnerable, fixed] = await Promise.all([
    deps.loadPackage(packageName, vulnerableVersion, cwd),
    deps.loadPackage(packageName, fixedVersion, cwd),
  ]);
  const hints: AdvisoryHints = { text: options.advisoryText, cwes: options.cwes };
  const diff = findVulnerableSymbols(vulnerable, fixed, { hints, limit: options.limit });
  if (options.checkReachability === false) return diff;

  // The existing reachability check takes a package and a symbol. Deep-file specifiers are checked
  // under the package name too: it matches `pkg/sub` imports of the package.
  const symbols = [...new Set(diff.candidates.map((candidate) => candidate.symbol))];
  const reachability = assessSymbolsReachability(cwd, packageName, symbols);
  const candidates: RankedVulnerableSymbol[] = diff.candidates.map((candidate) => {
    const assessment = reachability.get(candidate.symbol);
    if (!assessment) return candidate;
    return {
      ...candidate,
      reachability: {
        status: assessment.status,
        reason: assessment.reason,
        basis: assessment.reachabilityBasis,
        invokedIn: [...new Set((assessment.evidence ?? []).filter((item) => item.invoked).map((item) => item.filePath))].toSorted(),
      },
    };
  });
  return {
    ...diff,
    candidates,
    reachableCount: candidates.filter((candidate) => candidate.reachability?.status === "reachable").length,
  };
}
