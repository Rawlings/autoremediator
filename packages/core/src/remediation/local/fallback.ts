import { fetchPackageSourceTool } from "../tools/fetch-package-source.js";
import { generatePatchTool } from "../tools/generate-patch.js";
import { applyPatchFileTool } from "../tools/apply-patch-file.js";
import type { PatchResult, UnresolvedReason } from "../../platform/types.js";

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
  dryRun: boolean;
  runTests: boolean;
  patchesDir: string;
}): Promise<{ result: PatchResult; steps: number }> {
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
      result: {
        packageName: params.packageName,
        strategy: "none",
        fromVersion: params.vulnerableVersion,
        applied: false,
        dryRun: params.dryRun,
        unresolvedReason: "source-fetch-failed",
        message: sourceResult?.error ?? `Failed to fetch source for ${params.packageName}@${params.vulnerableVersion}.`,
      },
    };
  }

  const patchResult = (await (generatePatchTool as any).execute({
    packageName: params.packageName,
    vulnerableVersion: params.vulnerableVersion,
    cveId: params.cveId,
    cveSummary: params.cveSummary,
    sourceFiles: sourceResult.sourceFiles,
    vulnerabilityCategory: "unknown",
    dryRun: params.dryRun,
  })) as {
    success?: boolean;
    patches?: Array<{ filePath: string; unifiedDiff: string }>;
    patchContent?: string;
    confidence?: number;
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
      result: {
        packageName: params.packageName,
        strategy: "none",
        fromVersion: params.vulnerableVersion,
        applied: false,
        dryRun: params.dryRun,
        unresolvedReason,
        message: error,
      },
    };
  }

  if (typeof patchResult.confidence === "number" && patchResult.confidence < 0.7) {
    return {
      steps,
      result: {
        packageName: params.packageName,
        strategy: "none",
        fromVersion: params.vulnerableVersion,
        applied: false,
        dryRun: params.dryRun,
        unresolvedReason: "patch-confidence-too-low",
        message: `Patch confidence ${patchResult.confidence.toFixed(2)} is below threshold 0.70.`,
      },
    };
  }

  const applyResult = (await (applyPatchFileTool as any).execute({
    packageName: params.packageName,
    vulnerableVersion: params.vulnerableVersion,
    patchContent: patchResult.patchContent,
    patches: patchResult.patches,
    patchesDir: params.patchesDir,
    cwd: params.cwd,
    packageManager: params.packageManager,
    validateWithTests: params.runTests,
    dryRun: params.dryRun,
  })) as {
    applied?: boolean;
    dryRun?: boolean;
    message?: string;
    error?: string;
    patchFilePath?: string;
    patchPath?: string;
    validation?: { passed?: boolean; error?: string };
  };
  steps += 1;

  return {
    steps,
    result: {
      packageName: params.packageName,
      strategy: "patch-file",
      fromVersion: params.vulnerableVersion,
      patchFilePath: applyResult.patchFilePath ?? applyResult.patchPath,
      applied: Boolean(applyResult.applied),
      dryRun: Boolean(applyResult.dryRun),
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
    },
  };
}
