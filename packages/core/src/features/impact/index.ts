/**
 * Public SDK API: assessUpgrade and findVulnerableSymbols.
 *
 * Both download the two published versions from the configured npm registry (integrity-verified),
 * read them in memory, and change nothing in the project.
 */
import {
  assessUpgrade as assess,
  defaultImpactDeps,
  findVulnerableSymbolsInUpgrade,
  type AssessUpgradeResult,
  type ImpactDeps,
  type VulnerableSymbolsResult,
} from "./assess.js";

export type { AssessUpgradeResult, ImpactDeps, VulnerableSymbolsResult };
export type { Breakability, FindingEvidence, ImpactFinding, UpgradeImpact } from "./impact.js";
export { IMPACT_POINTS, MEDIUM_THRESHOLD } from "./impact.js";
export type {
  CandidateBasis,
  ChangedInternal,
  FixDiff,
  VulnerableSymbolCandidate,
} from "./fix-diff.js";
export type { CallSite } from "./types.js";

export interface AssessUpgradeInput {
  packageName: string;
  /** Version currently installed. */
  from: string;
  /** Version being considered. */
  to: string;
  /** Project root whose source is scanned and whose `.npmrc` selects the registry. */
  cwd?: string;
}

export interface FindVulnerableSymbolsInput {
  packageName: string;
  /** The vulnerable version. */
  from: string;
  /** The version that fixes it. */
  to: string;
  cwd?: string;
  /** Advisory summary or details; used only to rank candidates. */
  advisoryText?: string;
  /** CWE identifiers (`CWE-1333`); used only to rank candidates. */
  cwes?: string[];
  /** Largest number of candidates returned (default 25). */
  limit?: number;
  /** Check each candidate against the project's source (default true). */
  checkReachability?: boolean;
}

/** How likely is moving `packageName` from `from` to `to` to break the project at `cwd`? */
export async function assessUpgrade(
  input: AssessUpgradeInput,
  deps: ImpactDeps = defaultImpactDeps,
): Promise<AssessUpgradeResult> {
  return assess(input.packageName, input.from, input.to, { cwd: input.cwd }, deps);
}

/**
 * Candidate vulnerable symbols: the exports that changed between a vulnerable version and its fix,
 * ranked, with project reachability. A heuristic; see `docs/guides/upgrade-impact.md`.
 */
export async function findVulnerableSymbols(
  input: FindVulnerableSymbolsInput,
  deps: ImpactDeps = defaultImpactDeps,
): Promise<VulnerableSymbolsResult> {
  const { packageName, from, to, ...options } = input;
  return findVulnerableSymbolsInUpgrade(packageName, from, to, options, deps);
}
