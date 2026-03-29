/**
 * Autoremediator agentic loop
 *
 * Orchestrates the full CVE patching pipeline using Vercel AI SDK's
 * generateText with a tool-calling loop.
 *
 * Phase 1 tools: lookup-cve → check-inventory → check-version-match
 *                → find-fixed-version → apply-version-bump
 * Phase 4 tools: fetch-package-source → generate-patch → apply-patch-file
 */
import { generateText } from "ai";
import { createModel, resolveProvider } from "../platform/config.js";
import { detectPackageManager } from "../platform/package-manager.js";
import { applyVersionBumpTool } from "./tools/apply-version-bump.js";
import { applyPackageOverrideTool } from "./tools/apply-package-override.js";
import { applyPatchFileTool } from "./tools/apply-patch-file.js";
import type {
  RemediateOptions,
  RemediationReport,
  PatchResult,
  VulnerablePackage,
  CveDetails,
} from "../platform/types.js";
import { runLocalRemediationPipeline } from "./local/index.js";
import { buildRuntimeTools } from "./runtime-tools.js";
import { loadOrchestrationPrompt } from "./orchestration-prompt.js";

export async function runRemediationPipeline(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  const provider = resolveProvider(options);
  if (provider === "local") {
    return runLocalRemediationPipeline(cveId, options);
  }

  const cwd = options.cwd ?? process.cwd();
  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const preview = options.preview ?? false;
  const dryRun = (options.dryRun ?? false) || preview;
  const runTests = options.runTests ?? false;
  const policy = options.policy ?? "";
  const patchesDir = options.patchesDir || "./patches";
  const constraints = options.constraints ?? {};

  const model = await createModel(options);

  const systemPrompt = loadOrchestrationPrompt({
    cveId,
    cwd,
    dryRun,
    runTests,
    policy,
    patchesDir,
    packageManager,
    constraints,
  });

  const prompt = `Patch vulnerable dependencies affected by ${cveId} in the project at: ${cwd}. Package manager: ${packageManager}.`;

  const collectedResults: PatchResult[] = [];
  const vulnerablePackages: VulnerablePackage[] = [];
  let cveDetails: CveDetails | null = null;
  let agentSteps = 0;

  const applyVersionBumpToolForRun = preview
    ? {
        ...applyVersionBumpTool,
        execute: async (input: Record<string, unknown>) =>
          (applyVersionBumpTool as any).execute({ ...input, dryRun: true }),
      } as typeof applyVersionBumpTool
    : applyVersionBumpTool;
  const applyPackageOverrideToolForRun = preview
    ? {
        ...applyPackageOverrideTool,
        execute: async (input: Record<string, unknown>) =>
          (applyPackageOverrideTool as any).execute({ ...input, dryRun: true }),
      } as typeof applyPackageOverrideTool
    : applyPackageOverrideTool;
  const applyPatchFileToolForRun = preview
    ? {
        ...applyPatchFileTool,
        execute: async (input: Record<string, unknown>) =>
          (applyPatchFileTool as any).execute({ ...input, dryRun: true }),
      } as typeof applyPatchFileTool
    : applyPatchFileTool;
  const tools = buildRuntimeTools({
    applyVersionBumpToolForRun,
    applyPackageOverrideToolForRun,
    applyPatchFileToolForRun,
    constraints,
  });

  const result = await generateText({
    model,
    system: systemPrompt,
    prompt,
    tools: tools as any,
    maxSteps: 25,
    onStepFinish(stepResult) {
      agentSteps += 1;

      const toolResults = (stepResult.toolResults ?? []) as Array<{
        toolName: string;
        result?: unknown;
      }>;

      for (const tr of toolResults) {
        const toolResult = tr.result as Record<string, unknown> | undefined;

        if (tr.toolName === "lookup-cve" && toolResult?.data) {
          cveDetails = toolResult.data as CveDetails;
        }
        if (tr.toolName === "check-version-match" && toolResult?.vulnerablePackages) {
          vulnerablePackages.push(...(toolResult.vulnerablePackages as VulnerablePackage[]));
        }
        if (tr.toolName === "apply-version-bump") {
          collectedResults.push(toolResult as unknown as PatchResult);
        }

        if (tr.toolName === "apply-package-override") {
          collectedResults.push(toolResult as unknown as PatchResult);
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

          collectedResults.push({
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
            applied: Boolean(toolResult.applied),
            dryRun: Boolean(toolResult.dryRun),
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
          });
        }
      }
    },
  });

  return {
    cveId,
    cveDetails,
    vulnerablePackages,
    results: collectedResults,
    agentSteps,
    summary: result.text,
    correlation: {
      requestId: options.requestId,
      sessionId: options.sessionId,
      parentRunId: options.parentRunId,
    },
  };
}

