/**
 * Autoremediator agentic loop
 *
 * Orchestrates the full CVE patching pipeline using Vercel AI SDK's
 * generateText with a tool-calling loop.
 */
import { generateText } from "ai";
import { createModel, estimateModelCostUsd, resolveProvider } from "../platform/config.js";
import { detectPackageManager } from "../platform/package-manager.js";
import { applyVersionBumpTool } from "./tools/apply-version-bump.js";
import { applyPackageOverrideTool } from "./tools/apply-package-override.js";
import { applyPatchFileTool } from "./tools/apply-patch-file.js";
import type {
  CveDetails,
  LlmUsageMetrics,
  PatchResult,
  RemediateOptions,
  RemediationReport,
  VulnerablePackage,
} from "../platform/types.js";
import { runLocalRemediationPipeline } from "./local/index.js";
import { loadOrchestrationPrompt } from "./orchestration-prompt.js";
import { buildRuntimeTools } from "./runtime-tools.js";
import { accumulateStepResults } from "./strategies/pipeline-telemetry.js";
import { checkInventoryTool } from "./tools/check-inventory.js";

export async function runRemediationPipeline(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  const provider = resolveProvider(options);
  if (provider === "local") {
    return runLocalRemediationPipeline(cveId, options);
  }

  const emitProgress = (
    stage: "pipeline-start" | "model-selected" | "agent-step" | "pipeline-finish" | "patch-fallback" | "patch-consensus",
    detail: string,
    extra?: { provider?: "remote" | "local"; model?: string }
  ): void => {
    if (!options.onProgress) return;
    options.onProgress({
      stage,
      detail,
      at: new Date().toISOString(),
      provider: extra?.provider,
      model: extra?.model,
    });
  };

  emitProgress("pipeline-start", `Starting remediation for ${cveId}.`, { provider });

  const cwd = options.cwd ?? process.cwd();
  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const preview = options.preview ?? false;
  const dryRun = (options.dryRun ?? false) || preview;
  const runTests = options.runTests ?? false;
  const policy = options.policy ?? "";
  const patchesDir = options.patchesDir || "./patches";
  const constraints = options.constraints ?? {};

  const prompt = `Patch vulnerable dependencies affected by ${cveId} in the project at: ${cwd}. Package manager: ${packageManager}.`;
  const model = await createModel(options, { inputChars: prompt.length });
  const modelName = model.modelId ?? "unknown-model";
  emitProgress("model-selected", `Selected model ${modelName}.`, { provider, model: modelName });

  const systemPrompt = loadOrchestrationPrompt({
    cveId,
    cwd,
    llmProvider: provider,
    modelPersonality: options.modelPersonality,
    dryRun,
    runTests,
    policy,
    patchesDir,
    packageManager,
    constraints,
  });

  let collectedResults: PatchResult[] = [];
  let vulnerablePackages: VulnerablePackage[] = [];
  let cveDetails: CveDetails | null = null;
  let agentSteps = 0;

  function getDependencyScope(packageName: string): "direct" | "transitive" | undefined {
    const match = vulnerablePackages.find((pkg) => pkg.installed.name === packageName);
    if (!match) return undefined;
    return match.installed.type === "direct" ? "direct" : "transitive";
  }

  const checkInventoryToolForRun = {
    ...checkInventoryTool,
    execute: async (input: Record<string, unknown>) =>
      (checkInventoryTool as any).execute({
        ...input,
        policy,
        workspace: constraints.workspace,
      }),
  };

  const applyVersionBumpToolForRun = {
    ...applyVersionBumpTool,
    execute: async (input: Record<string, unknown>) =>
      (applyVersionBumpTool as any).execute({
        ...input,
        policy,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        dryRun: preview ? true : input.dryRun,
      }),
  };
  const applyPackageOverrideToolForRun = {
    ...applyPackageOverrideTool,
    execute: async (input: Record<string, unknown>) =>
      (applyPackageOverrideTool as any).execute({
        ...input,
        policy,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        dryRun: preview ? true : input.dryRun,
      }),
  };
  const applyPatchFileToolForRun = {
    ...applyPatchFileTool,
    execute: async (input: Record<string, unknown>) =>
      (applyPatchFileTool as any).execute({
        ...input,
        policy,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        dryRun: preview ? true : input.dryRun,
      }),
  };

  const tools = buildRuntimeTools({
    checkInventoryToolForRun,
    applyVersionBumpToolForRun,
    applyPackageOverrideToolForRun,
    applyPatchFileToolForRun,
    constraints,
  });

  const started = Date.now();
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

      const aggregation = accumulateStepResults({
        toolResults,
        cveDetails,
        vulnerablePackages,
        collectedResults,
        getDependencyScope,
      });
      cveDetails = aggregation.cveDetails;
      vulnerablePackages = aggregation.vulnerablePackages;
      collectedResults = aggregation.collectedResults;

      emitProgress("agent-step", `Completed agent step ${agentSteps} with ${toolResults.length} tool result(s).`, {
        provider,
        model: modelName,
      });
    },
  });

  const llmUsage: LlmUsageMetrics[] = [
    {
      purpose: "orchestration",
      provider,
      model: modelName,
      latencyMs: Date.now() - started,
      promptChars: prompt.length + systemPrompt.length,
      completionChars: result.text.length,
      estimatedCostUsd: estimateModelCostUsd({
        provider,
        promptChars: prompt.length + systemPrompt.length,
        completionChars: result.text.length,
      }),
    },
  ];

  emitProgress("pipeline-finish", `Completed remediation with ${collectedResults.length} result(s).`, {
    provider,
    model: modelName,
  });

  return {
    cveId,
    cveDetails,
    vulnerablePackages,
    results: collectedResults,
    agentSteps,
    summary: result.text,
    llmUsage,
    correlation: {
      requestId: options.requestId,
      sessionId: options.sessionId,
      parentRunId: options.parentRunId,
    },
  };
}
