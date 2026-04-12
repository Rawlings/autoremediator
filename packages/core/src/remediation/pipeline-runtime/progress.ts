import type { RemediateOptions } from "../../platform/types.js";

export type ProgressStage =
  | "pipeline-start"
  | "model-selected"
  | "agent-step"
  | "pipeline-finish"
  | "patch-fallback"
  | "patch-consensus";

export function createProgressEmitter(options: RemediateOptions) {
  return (
    stage: ProgressStage,
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
}