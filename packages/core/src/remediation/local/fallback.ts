import type { PatchGenerator } from "../../platform/patch-generator.js";
import { isPackageAllowed, loadPolicy } from "../../platform/policy.js";
import type {
  LlmUsageMetrics,
  PackageManager,
  PatchConfidenceThresholds,
  PatchResult,
  UnresolvedReason,
} from "../../platform/types.js";
import { generatePatches, type PatchGenerationFailure } from "../patch/generate.js";
import { applyPatchFileTool } from "../tools/apply-patch-file/index.js";
import { fetchPackageSourceTool } from "../tools/fetch-package-source.js";

const FAILURE_REASON: Record<PatchGenerationFailure, UnresolvedReason> = {
  "generator-failed": "patch-generation-failed",
  "unknown-file": "patch-generation-failed",
  "invalid-syntax": "patch-generation-failed",
  "no-changes": "patch-generation-failed",
  "confidence-too-low": "patch-confidence-too-low",
};

export function shouldAttemptPatchFallback(
  result: PatchResult,
  preferVersionBump: boolean,
): boolean {
  if (preferVersionBump) return false;
  if (result.applied || result.dryRun) return false;

  return (
    result.unresolvedReason === "no-safe-version" ||
    result.unresolvedReason === "install-failed" ||
    result.unresolvedReason === "override-apply-failed" ||
    result.unresolvedReason === "validation-failed" ||
    result.unresolvedReason === "major-bump-required" ||
    result.unresolvedReason === "transitive-dependency" ||
    result.unresolvedReason === "proof-of-fix-failed"
  );
}

export interface PatchFallbackParams {
  cwd: string;
  packageManager: PackageManager;
  packageName: string;
  vulnerableVersion: string;
  cveId: string;
  cveSummary: string;
  dependencyScope: "direct" | "transitive";
  dryRun: boolean;
  runTests: boolean;
  patchesDir: string;
  /** Resolves the generator lazily so runs that never need patching never load a model. */
  getGenerator: () => Promise<PatchGenerator | undefined>;
  patchConfidenceThresholds?: PatchConfidenceThresholds;
  policy?: string;
  installMode?: "standard" | "prefer-offline" | "deterministic";
  installPreferOffline?: boolean;
  enforceFrozenLockfile?: boolean;
  workspace?: string;
  vulnerableRange?: string;
  proofOfFix?: boolean | string;
  requireProofOfFix?: boolean;
}

/** Fetch the vulnerable source, have the generator propose a fix, and apply it as a patch file. */
export async function tryPatchFallback(
  params: PatchFallbackParams,
): Promise<{ result: PatchResult; usage: LlmUsageMetrics[] }> {
  const usage: LlmUsageMetrics[] = [];

  const unresolved = (
    unresolvedReason: UnresolvedReason,
    message: string,
    extra: Partial<PatchResult> = {},
  ): { result: PatchResult; usage: LlmUsageMetrics[] } => ({
    usage,
    result: {
      packageName: params.packageName,
      strategy: "none",
      fromVersion: params.vulnerableVersion,
      applied: false,
      dryRun: params.dryRun,
      dependencyScope: params.dependencyScope,
      unresolvedReason,
      message,
      ...extra,
    },
  });

  if (!isPackageAllowed(loadPolicy(params.cwd, params.policy), params.packageName)) {
    return unresolved(
      "policy-blocked",
      `Policy denyPackages blocked patch fallback for package "${params.packageName}".`,
    );
  }

  let generator: PatchGenerator | undefined;
  try {
    generator = await params.getGenerator();
  } catch (error) {
    return unresolved(
      "requires-llm-fallback",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!generator) {
    return unresolved(
      "requires-llm-fallback",
      'Patch fallback needs a language model: set `model` (e.g. "anthropic:claude-sonnet-5-5") or provide a `patchGenerator`.',
    );
  }

  const source = await fetchPackageSourceTool.execute({
    cwd: params.cwd,
    packageName: params.packageName,
    version: params.vulnerableVersion,
  });
  if (!source?.success || !source.sourceFiles) {
    return unresolved(
      "source-fetch-failed",
      source?.error ??
        `Failed to fetch source for ${params.packageName}@${params.vulnerableVersion}.`,
    );
  }

  const generation = await generatePatches(
    {
      cveId: params.cveId,
      packageName: params.packageName,
      vulnerableVersion: params.vulnerableVersion,
      cveSummary: params.cveSummary,
      sourceFiles: source.sourceFiles,
    },
    generator,
    { confidenceThresholds: params.patchConfidenceThresholds },
  );

  const proposalUsage = generation.proposal?.usage;
  if (proposalUsage) usage.push({ purpose: "patch-generation", ...proposalUsage });

  if (!generation.ok) {
    return unresolved(FAILURE_REASON[generation.reason], generation.message, {
      confidence: generation.proposal?.confidence,
      riskLevel: generation.proposal?.riskLevel,
    });
  }

  const { patches, proposal } = generation;
  const applied = await applyPatchFileTool.execute({
    packageName: params.packageName,
    vulnerableVersion: params.vulnerableVersion,
    cveId: params.cveId,
    confidence: proposal.confidence,
    patchContent: patches[0]?.unifiedDiff,
    patches,
    patchesDir: params.patchesDir,
    cwd: params.cwd,
    packageManager: params.packageManager,
    policy: params.policy,
    installMode: params.installMode,
    installPreferOffline: params.installPreferOffline,
    enforceFrozenLockfile: params.enforceFrozenLockfile,
    workspace: params.workspace,
    riskLevel: proposal.riskLevel,
    validateWithTests: params.runTests,
    proofOfFix: params.proofOfFix,
    requireProofOfFix: params.requireProofOfFix,
    dryRun: params.dryRun,
  });

  return {
    usage,
    result: {
      packageName: params.packageName,
      strategy: "patch-file",
      fromVersion: params.vulnerableVersion,
      patchFilePath: applied.patchFilePath ?? applied.patchPath,
      patchArtifact: applied.patchArtifact,
      applied: applied.applied,
      dryRun: applied.dryRun,
      dependencyScope: params.dependencyScope,
      confidence: proposal.confidence,
      riskLevel: proposal.riskLevel,
      vulnerableRange: params.vulnerableRange,
      unresolvedReason:
        !applied.applied && !applied.dryRun
          ? (applied.unresolvedReason ??
            (applied.validation?.passed === false
              ? "patch-validation-failed"
              : "patch-apply-failed"))
          : undefined,
      message: applied.message ?? applied.error ?? "Patch-file strategy finished.",
      validation:
        typeof applied.validation?.passed === "boolean"
          ? { passed: applied.validation.passed, error: applied.validation.error }
          : undefined,
      validationPhases: applied.validationPhases,
    },
  };
}
