import { fetchPackageSourceTool } from "../tools/fetch-package-source.js";
import { generatePatchTool } from "../tools/generate-patch/index.js";
import { applyPatchFileTool } from "../tools/apply-patch-file/index.js";
import type {
  LlmUsageMetrics,
  PatchConfidenceThresholds,
  PatchResult,
  UnresolvedReason,
} from "../../platform/types.js";
import { getPatchConfidenceThreshold } from "../../platform/config.js";

function resolvePatchProvider(provider: "remote" | "local"): "remote" | "local" {
  if (provider === "local") {
    return "remote";
  }
  return provider;
}

export function shouldAttemptPatchFallback(result: PatchResult, preferVersionBump: boolean): boolean {
  if (preferVersionBump) return false;
  if (result.applied || result.dryRun) return false;

  return (
    result.unresolvedReason === "no-safe-version" ||
    result.unresolvedReason === "install-failed" ||
    result.unresolvedReason === "override-apply-failed" ||
    result.unresolvedReason === "validation-failed" ||
    result.unresolvedReason === "major-bump-required" ||
    result.unresolvedReason === "indirect-dependency"
  );
}

export async function tryLocalPatchFallback(params: {
  cwd: string;
  packageManager: "npm" | "pnpm" | "yarn";
  packageName: string;
  vulnerableVersion: string;
  cveId: string;
  cveSummary: string;
  dependencyScope: "direct" | "transitive";
  dryRun: boolean;
  runTests: boolean;
  patchesDir: string;
  llmProvider: "remote" | "local";
  model?: string;
  policy?: string;
  modelPersonality?: "analytical" | "pragmatic" | "balanced";
  providerSafetyProfile?: "strict" | "relaxed";
  requireConsensusForHighRisk?: boolean;
  consensusProvider?: "remote" | "local";
  consensusModel?: string;
  patchConfidenceThresholds?: PatchConfidenceThresholds;
  dynamicModelRouting?: boolean;
  dynamicRoutingThresholdChars?: number;
  installMode?: "standard" | "prefer-offline" | "deterministic";
  installPreferOffline?: boolean;
  enforceFrozenLockfile?: boolean;
  workspace?: string;
}): Promise<{ result: PatchResult; steps: number; usage: LlmUsageMetrics[] }> {
  const usage: LlmUsageMetrics[] = [];
  let steps = 0;

  const sourceResult = (await (fetchPackageSourceTool as any).execute({
    packageName: params.packageName,
    version: params.vulnerableVersion,
  })) as {
    success?: boolean;
    sourceFiles?: Record<string, string>;
    error?: string;
  };
  steps += 1;

  if (!sourceResult?.success || !sourceResult.sourceFiles) {
    return {
      steps,
      usage,
      result: {
        packageName: params.packageName,
        strategy: "none",
        fromVersion: params.vulnerableVersion,
        applied: false,
        dryRun: params.dryRun,
        dependencyScope: params.dependencyScope,
        unresolvedReason: "source-fetch-failed",
        message: sourceResult?.error ?? `Failed to fetch source for ${params.packageName}@${params.vulnerableVersion}.`,
      },
    };
  }

  const primaryProvider = resolvePatchProvider(params.llmProvider);
  const patchResult = (await (generatePatchTool as any).execute({
    packageName: params.packageName,
    vulnerableVersion: params.vulnerableVersion,
    cveId: params.cveId,
    cveSummary: params.cveSummary,
    sourceFiles: sourceResult.sourceFiles,
    vulnerabilityCategory: "unknown",
    dryRun: params.dryRun,
    llmProvider: primaryProvider,
    model: params.model,
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
    patchContent?: string;
    llmProvider?: "remote" | "local";
    llmModel?: string;
    latencyMs?: number;
    estimatedCostUsd?: number;
    confidenceThreshold?: number;
    confidence?: number;
    riskLevel?: "low" | "medium" | "high";
    error?: string;
  };
  steps += 1;

  if (!patchResult?.success) {
    const error = patchResult?.error ?? "Patch generation failed.";
    const unresolvedReason: UnresolvedReason =
      error.includes("API_KEY") || error.includes("does not create a language model")
        ? "requires-llm-fallback"
        : "patch-generation-failed";
    return {
      steps,
      usage,
      result: {
        packageName: params.packageName,
        strategy: "none",
        fromVersion: params.vulnerableVersion,
        applied: false,
        dryRun: params.dryRun,
        dependencyScope: params.dependencyScope,
        unresolvedReason,
        message: error,
      },
    };
  }

  const effectiveProvider = patchResult.llmProvider ?? primaryProvider;
  const confidenceThreshold =
    patchResult.confidenceThreshold ??
    getPatchConfidenceThreshold(
      effectiveProvider,
      params.providerSafetyProfile ?? "relaxed",
      patchResult.riskLevel ?? "medium",
      params.patchConfidenceThresholds
    );

  if (typeof patchResult.confidence === "number" && patchResult.confidence < confidenceThreshold) {
    return {
      steps,
      usage,
      result: {
        packageName: params.packageName,
        strategy: "none",
        fromVersion: params.vulnerableVersion,
        applied: false,
        dryRun: params.dryRun,
        dependencyScope: params.dependencyScope,
        confidence: patchResult.confidence,
        riskLevel: patchResult.riskLevel,
        unresolvedReason: "patch-confidence-too-low",
        message: `Patch confidence ${patchResult.confidence.toFixed(2)} is below threshold ${confidenceThreshold.toFixed(2)}.`,
      },
    };
  }

  if (
    params.requireConsensusForHighRisk &&
    patchResult.riskLevel === "high" &&
    !params.dryRun
  ) {
    const consensusProvider = resolvePatchProvider(params.consensusProvider ?? primaryProvider);
    const consensus = (await (generatePatchTool as any).execute({
      packageName: params.packageName,
      vulnerableVersion: params.vulnerableVersion,
      cveId: params.cveId,
      cveSummary: params.cveSummary,
      sourceFiles: sourceResult.sourceFiles,
      vulnerabilityCategory: "unknown",
      dryRun: false,
      llmProvider: consensusProvider,
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
      confidence?: number;
      error?: string;
    };
    steps += 1;

    const primaryDiff = patchResult.patches?.[0]?.unifiedDiff;
    const secondaryDiff = consensus.patches?.[0]?.unifiedDiff;
    if (!consensus.success || !primaryDiff || !secondaryDiff || primaryDiff !== secondaryDiff) {
      return {
        steps,
        usage,
        result: {
          packageName: params.packageName,
          strategy: "none",
          fromVersion: params.vulnerableVersion,
          applied: false,
          dryRun: params.dryRun,
          dependencyScope: params.dependencyScope,
          unresolvedReason: "consensus-failed",
          message: consensus.error ?? "High-risk patch did not pass consensus verification.",
        },
      };
    }

    if (consensus.llmProvider && consensus.llmModel) {
      usage.push({
        purpose: "patch-consensus",
        provider: consensus.llmProvider,
        model: consensus.llmModel,
        latencyMs: consensus.latencyMs,
        estimatedCostUsd: consensus.estimatedCostUsd,
      });
    }
  }

  const applyResult = (await (applyPatchFileTool as any).execute({
    packageName: params.packageName,
    vulnerableVersion: params.vulnerableVersion,
    cveId: params.cveId,
    confidence: patchResult.confidence,
    patchContent: patchResult.patchContent,
    patches: patchResult.patches,
    patchesDir: params.patchesDir,
    cwd: params.cwd,
    packageManager: params.packageManager,
    policy: params.policy,
    installMode: params.installMode,
    installPreferOffline: params.installPreferOffline,
    enforceFrozenLockfile: params.enforceFrozenLockfile,
    workspace: params.workspace,
    riskLevel: patchResult.riskLevel,
    validateWithTests: params.runTests,
    dryRun: params.dryRun,
  })) as {
    applied?: boolean;
    dryRun?: boolean;
    message?: string;
    error?: string;
    patchFilePath?: string;
    patchPath?: string;
    patchArtifact?: PatchResult["patchArtifact"];
    validationPhases?: PatchResult["validationPhases"];
    validation?: { passed?: boolean; error?: string };
  };
  steps += 1;

  if (patchResult.llmProvider && patchResult.llmModel) {
    usage.push({
      purpose: "patch-generation",
      provider: patchResult.llmProvider,
      model: patchResult.llmModel,
      latencyMs: patchResult.latencyMs,
      estimatedCostUsd: patchResult.estimatedCostUsd,
    });
  }

  return {
    steps,
    usage,
    result: {
      packageName: params.packageName,
      strategy: "patch-file",
      fromVersion: params.vulnerableVersion,
      patchFilePath: applyResult.patchFilePath ?? applyResult.patchPath,
      patchArtifact: applyResult.patchArtifact,
      applied: Boolean(applyResult.applied),
      dryRun: Boolean(applyResult.dryRun),
      dependencyScope: params.dependencyScope,
      confidence: patchResult.confidence,
      riskLevel: patchResult.riskLevel,
      unresolvedReason:
        !Boolean(applyResult.applied) && !Boolean(applyResult.dryRun)
          ? applyResult.validation?.passed === false
            ? "patch-validation-failed"
            : "patch-apply-failed"
          : undefined,
      message: applyResult.message ?? applyResult.error ?? "Patch-file strategy finished.",
      validation:
        typeof applyResult.validation?.passed === "boolean"
          ? {
              passed: applyResult.validation.passed,
              error: applyResult.validation.error,
            }
          : undefined,
      validationPhases: applyResult.validationPhases,
    },
  };
}
