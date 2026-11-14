import type { PatchGenerator } from "../../platform/patch-generator.js";
import { createLlmPatchGenerator } from "./llm-generator.js";
import { resolveLanguageModel } from "./model.js";

/**
 * Pick the patch generator for a run: an explicitly supplied one wins, otherwise a configured
 * `provider:model` spec is turned into an LLM-backed generator. `undefined` means patch
 * generation is not configured, which callers must report rather than paper over.
 */
export async function resolvePatchGenerator(options: {
  patchGenerator?: PatchGenerator;
  model?: string;
}): Promise<PatchGenerator | undefined> {
  if (options.patchGenerator) return options.patchGenerator;
  if (!options.model) return undefined;
  return createLlmPatchGenerator(await resolveLanguageModel(options.model));
}
