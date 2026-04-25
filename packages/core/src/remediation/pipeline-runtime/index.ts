import { createModel, resolveProvider } from "../../platform/config.js";
import { detectPackageManager } from "../../platform/package-manager/index.js";
import type { RemediateOptions } from "../../platform/types.js";
import { loadOrchestrationPrompt } from "../orchestration-prompt.js";
import { createProgressEmitter } from "./progress.js";
import { createRuntimeToolsForRun } from "./tool-wrappers.js";

export { createProgressEmitter, createRuntimeToolsForRun };

export async function createPipelineRuntime(
  cveId: string,
  options: RemediateOptions
): Promise<{
  provider: "remote" | "local";
  cwd: string;
  packageManager: "npm" | "pnpm" | "yarn";
  dryRun: boolean;
  model: Awaited<ReturnType<typeof createModel>>;
  modelName: string;
  prompt: string;
  systemPrompt: string;
}> {
  const provider = resolveProvider(options);
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
  const modelName =
    typeof model === "string"
      ? model
      : "modelId" in model && typeof model.modelId === "string"
        ? model.modelId
        : "unknown-model";
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

  return {
    provider,
    cwd,
    packageManager,
    dryRun,
    model,
    modelName,
    prompt,
    systemPrompt,
  };
}