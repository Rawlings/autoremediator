/**
 * Autoremediator agentic loop
 *
 * Orchestrates the full CVE patching pipeline using Vercel AI SDK's
 * generateText with a tool-calling loop.
 */
import { generateText } from "ai";
import { estimateModelCostUsd, resolveProvider } from "../platform/config.js";
import type {
  CveDetails,
  LlmUsageMetrics,
  PatchResult,
  RemediateOptions,
  RemediationReport,
  VulnerablePackage,
} from "../platform/types.js";
import { runLocalRemediationPipeline } from "./local/index.js";
import { accumulateStepResults } from "./strategies/pipeline-telemetry.js";
import {
  createPipelineRuntime,
  createProgressEmitter,
  createRuntimeToolsForRun,
} from "./pipeline-runtime/index.js";

export async function runRemediationPipeline(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  const provider = resolveProvider(options);
  if (provider === "local") {
    return runLocalRemediationPipeline(cveId, options);
  }

  const emitProgress = createProgressEmitter(options);

  emitProgress("pipeline-start", `Starting remediation for ${cveId}.`, { provider });

  const runtime = await createPipelineRuntime(cveId, options);
  const { model, modelName, prompt, systemPrompt } = runtime;
  emitProgress("model-selected", `Selected model ${modelName}.`, { provider, model: modelName });

  let collectedResults: PatchResult[] = [];
  let vulnerablePackages: VulnerablePackage[] = [];
  let cveDetails: CveDetails | null = null;
  let agentSteps = 0;

  function getDependencyScope(packageName: string): "direct" | "transitive" | undefined {
    const match = vulnerablePackages.find((pkg) => pkg.installed.name === packageName);
    if (!match) return undefined;
    return match.installed.type === "direct" ? "direct" : "transitive";
  }
  const tools = createRuntimeToolsForRun(options);

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
