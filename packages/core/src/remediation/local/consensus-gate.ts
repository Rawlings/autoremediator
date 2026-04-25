import type {
  ConsensusVerdict,
  PatchConfidenceThresholds,
} from "../../platform/types.js";
import { generatePatchTool } from "../tools/generate-patch/index.js";

export interface ConsensusGateParams {
  packageName: string;
  vulnerableVersion: string;
  cveId: string;
  cveSummary: string;
  sourceFiles: Record<string, string>;
  policy?: string;
  cwd: string;
  llmProvider: "remote" | "local";
  model?: string;
  consensusProvider: "remote" | "local";
  consensusModel?: string;
  modelPersonality?: "analytical" | "pragmatic" | "balanced";
  providerSafetyProfile?: "strict" | "relaxed";
  patchConfidenceThresholds?: PatchConfidenceThresholds;
  dynamicModelRouting?: boolean;
  dynamicRoutingThresholdChars?: number;
  primaryPatches: Array<{ filePath: string; unifiedDiff: string }>;
}

export async function runConsensusGate(params: ConsensusGateParams): Promise<ConsensusVerdict> {
  const consensus = (await (generatePatchTool as any).execute({
    packageName: params.packageName,
    vulnerableVersion: params.vulnerableVersion,
    cveId: params.cveId,
    cveSummary: params.cveSummary,
    sourceFiles: params.sourceFiles,
    vulnerabilityCategory: "unknown",
    dryRun: false,
    llmProvider: params.consensusProvider,
    model: params.consensusModel,
    policy: params.policy,
    cwd: params.cwd,
    modelPersonality: params.modelPersonality,
    providerSafetyProfile: params.providerSafetyProfile,
    patchConfidenceThresholds: params.patchConfidenceThresholds,
    dynamicModelRouting: params.dynamicModelRouting,
    dynamicRoutingThresholdChars: params.dynamicRoutingThresholdChars,
  })) as {
    success?: boolean;
    patches?: Array<{ filePath: string; unifiedDiff: string }>;
    llmProvider?: "remote" | "local";
    llmModel?: string;
    latencyMs?: number;
    estimatedCostUsd?: number;
    error?: string;
  };

  const provider = consensus.llmProvider ?? params.consensusProvider;
  const model = consensus.llmModel ?? params.consensusModel ?? params.model ?? "unknown";
  const primaryDiff = params.primaryPatches[0]?.unifiedDiff;
  const secondaryDiff = consensus.patches?.[0]?.unifiedDiff;

  if (!consensus.success) {
    return {
      agreed: false,
      provider,
      model,
      reason: consensus.error ?? "Consensus patch generation failed.",
      latencyMs: consensus.latencyMs,
      estimatedCostUsd: consensus.estimatedCostUsd,
    };
  }

  if (!primaryDiff || !secondaryDiff) {
    return {
      agreed: false,
      provider,
      model,
      reason: "Consensus could not compare patch output.",
      latencyMs: consensus.latencyMs,
      estimatedCostUsd: consensus.estimatedCostUsd,
    };
  }

  if (primaryDiff !== secondaryDiff) {
    return {
      agreed: false,
      provider,
      model,
      reason: "High-risk patch did not pass consensus verification.",
      latencyMs: consensus.latencyMs,
      estimatedCostUsd: consensus.estimatedCostUsd,
    };
  }

  return {
    agreed: true,
    provider,
    model,
    latencyMs: consensus.latencyMs,
    estimatedCostUsd: consensus.estimatedCostUsd,
  };
}
