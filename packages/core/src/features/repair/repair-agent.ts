import type { MemoryProposal } from "../memory/propose.js";
import type { LlmUsageMetrics } from "../remediate/types.js";

export type { MemoryProposal };

/** Limits on one repair attempt. There is deliberately no money figure: that would need a price table. */
export interface RepairBudget {
  /** Model turns (each may call several tools). */
  maxSteps: number;
  /** Wall-clock time for one agent round. */
  maxWallMs: number;
  /** Test, type-check and build runs the agent may start. */
  maxCommandRuns: number;
  /** Times the verifier's findings are handed back to the agent. */
  maxRepairRounds: number;
  /** Input plus output tokens across the attempt; unlimited when unset. */
  maxTotalTokens?: number;
}

export const DEFAULT_REPAIR_BUDGET: RepairBudget = {
  maxSteps: 40,
  maxWallMs: 10 * 60_000,
  maxCommandRuns: 12,
  maxRepairRounds: 3,
};

/** What the verifier found wrong, in terms an agent can act on. */
export interface RepairFailure {
  /** The first failed check, e.g. "typecheck". */
  failedCheck: string;
  /** One line per check that ran, with its outcome. */
  summary: string[];
  /** The failing check's details: the tail of the compiler or test output. */
  details: string[];
}

export interface RepairTask {
  runId: string;
  attemptId: string;
  cveId: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** 1 for the first handover, then once per verifier rejection. */
  round: number;
  failure: RepairFailure;
  /** What earlier rounds said they changed, oldest first. */
  previousRounds: string[];
  /**
   * What the repository's memory holds about this upgrade, already quoted as data (see
   * `renderMemoryForAgent`). Undefined when memory has nothing to say.
   */
  memory?: string;
}

/** Commands an agent may run inside the worktree; each is the project's own, never free-form. */
export interface RepairCommands {
  typecheck?: readonly string[];
  tests?: readonly string[];
  build?: readonly string[];
}

export interface RepairEnv {
  /** Isolated checkout the agent works in. Nothing outside it is touched. */
  worktree: string;
  budget: RepairBudget;
  signal: AbortSignal;
  commands: RepairCommands;
  /**
   * Propose a memory entry. It is stored as `proposed` and changes nothing until a person accepts it;
   * the answer says what happened. Absent when the host does not want proposals.
   */
  proposeMemory?: (proposal: MemoryProposal) => Promise<string>;
}

export interface TranscriptEntry {
  step: number;
  /** What the agent said or did: its text, or `tool(args) -> result` for a tool call. */
  text: string;
}

export interface RepairOutcome {
  /** `submitted`: the agent says it is done; the verifier decides whether it is. */
  status: "submitted" | "gave-up" | "budget-exhausted";
  rationale: string;
  usage: LlmUsageMetrics[];
  transcript: TranscriptEntry[];
}

/**
 * Port for anything that can repair a project broken by a dependency upgrade. The built-in
 * implementation drives a language model through scoped tools; SDK callers can supply their own.
 * Whatever it does, it only proposes: the verifier decides whether the result stands.
 */
export interface RepairAgent {
  readonly id: string;
  repair(task: RepairTask, env: RepairEnv): Promise<RepairOutcome>;
}
