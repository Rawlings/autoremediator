import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

import type { PatchGenerator } from "./patch-generator.js";
import { buildPatchPrompt, PATCH_SYSTEM_PROMPT } from "./prompt.js";

const proposalSchema = z.object({
  analysis: z.string().describe("Root cause of the vulnerability and why the change removes it."),
  fixedFiles: z
    .record(z.string(), z.string())
    .describe("Complete new contents of every file that must change, keyed by its provided path."),
  confidence: z.number().min(0).max(1).describe("Confidence that the change fixes the issue."),
  riskLevel: z
    .enum(["low", "medium", "high"])
    .describe("Risk that the change breaks existing behavior."),
});

function modelName(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/** A {@link PatchGenerator} backed by any AI SDK language model, using schema-validated output. */
export function createLlmPatchGenerator(model: LanguageModel): PatchGenerator {
  return {
    async propose(request) {
      const started = Date.now();
      const { output, usage } = await generateText({
        model,
        output: Output.object({ schema: proposalSchema }),
        system: PATCH_SYSTEM_PROMPT,
        prompt: buildPatchPrompt(request),
        temperature: 0,
      });

      return {
        ...output,
        usage: {
          model: modelName(model),
          latencyMs: Date.now() - started,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      };
    },
  };
}
