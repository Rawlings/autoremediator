import type { LanguageModelV1 } from "ai";
import type { RemediateOptions } from "./types.js";

export type SupportedProvider = "openai" | "anthropic" | "local";

/**
 * Reads configuration from environment variables with option overrides.
 * Does NOT import provider packages — those are dynamically imported so
 * that missing optional peer deps don't blow up at startup.
 */
export function resolveProvider(options: RemediateOptions = {}): SupportedProvider {
  const raw =
    options.llmProvider ??
    process.env.AUTOREMEDIATOR_LLM_PROVIDER ??
    "openai";

  if (raw !== "openai" && raw !== "anthropic" && raw !== "local") {
    throw new Error(
      `Unsupported LLM provider "${raw}". Set AUTOREMEDIATOR_LLM_PROVIDER to "openai", "anthropic", or "local".`
    );
  }
  return raw as SupportedProvider;
}

export function resolveModelName(
  provider: SupportedProvider,
  options: RemediateOptions = {}
): string {
  if (options.model) return options.model;
  if (process.env.AUTOREMEDIATOR_MODEL) return process.env.AUTOREMEDIATOR_MODEL;

  const defaults: Record<SupportedProvider, string> = {
    openai: "gpt-4o",
    anthropic: "claude-sonnet-4-5",
    local: "local",
  };
  return defaults[provider];
}

/** Dynamically instantiates the LLM model at runtime. */
export async function createModel(options: RemediateOptions = {}): Promise<LanguageModelV1> {
  const provider = resolveProvider(options);

  if (provider === "local") {
    throw new Error(
      "Local provider does not create a language model. Use the deterministic pipeline path instead."
    );
  }

  const modelName = resolveModelName(provider, options);

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required when using the openai provider."
      );
    }
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ apiKey });
    return openai(modelName) as LanguageModelV1;
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required when using the anthropic provider."
      );
    }
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey });
    return anthropic(modelName) as LanguageModelV1;
  }

  throw new Error(`Unhandled provider: ${provider}`);
}

export interface NvdConfig {
  apiKey?: string;
}

export function getNvdConfig(): NvdConfig {
  return {
    apiKey: process.env.AUTOREMEDIATOR_NVD_API_KEY,
  };
}

export function getGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN;
}
