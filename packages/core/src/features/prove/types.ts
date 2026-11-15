import type { LanguageModel } from "ai";

import type { PackageSource } from "../impact/types.js";

/** What an advisory says, for the agent to read. All of it is data, never instructions. */
export interface AdvisoryContext {
  id: string;
  summary: string;
  /** Longer description, from the advisory source or supplied by the caller. */
  details?: string;
  /** CWE identifiers (`CWE-1321`). */
  cwes: string[];
  references: string[];
  source: "osv" | "user";
}

/** An npm package the advisory says is affected, with the range and the first fixed version. */
export interface AdvisoryAffected {
  name: string;
  vulnerableRange: string;
  firstPatchedVersion?: string;
}

export interface AdvisoryLookup {
  context: AdvisoryContext;
  affected: AdvisoryAffected[];
}

/** One published version, downloaded and checked against the registry's integrity digest. */
export interface FetchedPackage {
  name: string;
  version: string;
  /** The tarball as downloaded (already verified). */
  bytes: Uint8Array;
  source: PackageSource;
  /** The digest the registry advertised, e.g. `sha512-…`. */
  integrity: string;
  tarballUrl: string;
}

/** What one script run in the sandbox did. */
export interface RunRecord {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The run produced more output than allowed and was killed. */
  outputLimitExceeded: boolean;
  durationMs: number;
  /** The last part of stdout and stderr, for people to read. */
  outputTail: string;
}

export type RunVerdict =
  | "reproduced"
  | "no-reproduction"
  | "crashed"
  | "clean"
  | "still-failing"
  | "timeout"
  | "output-limit"
  | "sandbox-violation";

export interface JudgedRun extends RunRecord {
  verdict: RunVerdict;
}

/** What the harness concluded about one candidate script. */
export interface TrialResult {
  accepted: boolean;
  /** A sentence for the agent and the person: why it was kept or rejected. */
  reason: string;
  /** Which check decided it. */
  stage: "screen" | "vulnerable" | "fixed" | "confirmed";
  scriptSha256: string;
  vulnerableRun?: JudgedRun;
  fixedRun?: JudgedRun;
}

export interface ReproductionTask {
  advisory: AdvisoryContext;
  packageName: string;
  vulnerableVersion: string;
  fixedVersion: string;
  /** Exports the fix changed, most likely first (a heuristic), one line each. */
  candidates: string[];
  /** Trials the agent may use. */
  maxTrials: number;
}

export interface ReproductionEnv {
  /** Both versions' source, read-only. */
  sources: { vulnerable: PackageSource; fixed: PackageSource };
  /** Run a candidate script through the harness. This is the only way a script is ever accepted. */
  trial(script: string): Promise<TrialResult>;
  signal: AbortSignal;
  /** Wall-clock limit for the whole agent session. */
  maxWallMs: number;
}

export interface ReproductionUsage {
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReproductionOutcome {
  /** How the agent stopped. It never says whether a script is good; the harness does. */
  status: "stopped" | "gave-up" | "budget-exhausted" | "failed";
  rationale: string;
  usage: ReproductionUsage[];
  transcript: Array<{ step: number; text: string }>;
}

/** An agent that proposes reproduction scripts. Injectable; the built-in one drives an AI SDK model. */
export interface ReproductionAgent {
  id: string;
  propose(task: ReproductionTask, env: ReproductionEnv): Promise<ReproductionOutcome>;
}

export type ModelResolver = (spec: string) => Promise<LanguageModel>;
