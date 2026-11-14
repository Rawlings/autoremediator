import type { PatchRiskLevel } from "./types.js";

/** Everything a generator needs to propose a fix for one vulnerable package. */
export interface PatchRequest {
  cveId: string;
  packageName: string;
  vulnerableVersion: string;
  cveSummary: string;
  /** Vulnerable package sources, keyed by path relative to the package root. */
  sourceFiles: Readonly<Record<string, string>>;
}

export interface PatchGeneratorUsage {
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** A proposed fix, before any validation has been applied to it. */
export interface PatchProposal {
  /** Complete replacement contents, keyed by the path of the file they replace. */
  fixedFiles: Readonly<Record<string, string>>;
  analysis: string;
  /** Self-reported by the generator (0..1). A signal to gate on, not evidence of correctness. */
  confidence: number;
  riskLevel: PatchRiskLevel;
  usage?: PatchGeneratorUsage;
}

/**
 * Port for anything that can propose a source-level fix. The LLM-backed implementation lives in
 * `llm-generator.ts`; SDK callers can supply their own (a different model, a human, a fixture).
 */
export interface PatchGenerator {
  propose(request: PatchRequest): Promise<PatchProposal>;
}
