import type {
  CveDetails,
  PatchResult,
  VulnerablePackage,
} from "../../platform/types.js";

interface StepToolResult {
  toolName: string;
  result?: unknown;
}

interface AccumulateStepResultsParams {
  toolResults: StepToolResult[];
  cveDetails: CveDetails | null;
  vulnerablePackages: VulnerablePackage[];
  collectedResults: PatchResult[];
  getDependencyScope: (packageName: string) => "direct" | "transitive" | undefined;
}

interface AccumulateStepResultsOutput {
  cveDetails: CveDetails | null;
  vulnerablePackages: VulnerablePackage[];
  collectedResults: PatchResult[];
}

export function accumulateStepResults(
  params: AccumulateStepResultsParams
): AccumulateStepResultsOutput {
  const {
    toolResults,
    cveDetails,
    vulnerablePackages,
    collectedResults,
    getDependencyScope,
  } = params;

  let nextCveDetails = cveDetails;
  const nextVulnerablePackages = [...vulnerablePackages];
  const nextCollectedResults = [...collectedResults];

  for (const tr of toolResults) {
    const toolResult = tr.result as Record<string, unknown> | undefined;

    if (tr.toolName === "lookup-cve" && toolResult?.data) {
      nextCveDetails = toolResult.data as CveDetails;
    }

    if (tr.toolName === "check-version-match" && toolResult?.vulnerablePackages) {
      nextVulnerablePackages.push(...(toolResult.vulnerablePackages as VulnerablePackage[]));
    }

    if (tr.toolName === "apply-version-bump") {
      const typed = toolResult as unknown as PatchResult;
      nextCollectedResults.push({
        ...typed,
        dependencyScope: typed.packageName
          ? getDependencyScope(typed.packageName)
          : typed.dependencyScope,
      });
    }

    if (tr.toolName === "apply-package-override") {
      const typed = toolResult as unknown as PatchResult;
      nextCollectedResults.push({
        ...typed,
        dependencyScope: typed.packageName
          ? getDependencyScope(typed.packageName)
          : typed.dependencyScope,
      });
    }

    if (tr.toolName === "apply-patch-file" && toolResult) {
      const validation = toolResult.validation as
        | { passed?: boolean; error?: string }
        | undefined;
      const message =
        typeof toolResult.message === "string"
          ? toolResult.message
          : typeof toolResult.error === "string"
            ? toolResult.error
            : "Patch-file strategy finished.";

      nextCollectedResults.push({
        packageName:
          typeof toolResult.packageName === "string"
            ? toolResult.packageName
            : "unknown-package",
        strategy: "patch-file",
        fromVersion:
          typeof toolResult.vulnerableVersion === "string"
            ? toolResult.vulnerableVersion
            : "unknown",
        patchFilePath:
          typeof toolResult.patchFilePath === "string"
            ? toolResult.patchFilePath
            : typeof toolResult.patchPath === "string"
              ? toolResult.patchPath
              : undefined,
        patchArtifact:
          typeof toolResult.patchArtifact === "object" && toolResult.patchArtifact !== null
            ? (toolResult.patchArtifact as PatchResult["patchArtifact"])
            : undefined,
        applied: Boolean(toolResult.applied),
        dryRun: Boolean(toolResult.dryRun),
        dependencyScope:
          typeof toolResult.packageName === "string"
            ? getDependencyScope(toolResult.packageName)
            : undefined,
        confidence:
          typeof toolResult.patchArtifact === "object" &&
          toolResult.patchArtifact !== null &&
          typeof (toolResult.patchArtifact as Record<string, unknown>).confidence === "number"
            ? ((toolResult.patchArtifact as Record<string, unknown>).confidence as number)
            : undefined,
        riskLevel:
          typeof toolResult.patchArtifact === "object" &&
          toolResult.patchArtifact !== null &&
          typeof (toolResult.patchArtifact as Record<string, unknown>).riskLevel === "string"
            ? ((toolResult.patchArtifact as Record<string, unknown>).riskLevel as PatchResult["riskLevel"])
            : undefined,
        unresolvedReason:
          !Boolean(toolResult.applied) && !Boolean(toolResult.dryRun)
            ? validation && validation.passed === false
              ? "patch-validation-failed"
              : "patch-apply-failed"
            : undefined,
        message,
        validation:
          validation && typeof validation.passed === "boolean"
            ? {
                passed: validation.passed,
                error: typeof validation.error === "string" ? validation.error : undefined,
              }
            : undefined,
        validationPhases:
          Array.isArray(toolResult.validationPhases)
            ? (toolResult.validationPhases as PatchResult["validationPhases"])
            : undefined,
      });
    }
  }

  return {
    cveDetails: nextCveDetails,
    vulnerablePackages: nextVulnerablePackages,
    collectedResults: nextCollectedResults,
  };
}