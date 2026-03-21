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

export interface IntelligenceSourceConfig {
  gitLabAdvisoryApi?: string;
  certCcSearchUrl?: string;
  epssApi?: string;
  cveServicesApi?: string;
  depsDevApi?: string;
  scorecardApi?: string;
  vendorAdvisoryFeeds: string[];
  commercialFeeds: string[];
  commercialFeedToken?: string;
}

export function getIntelligenceSourceConfig(): IntelligenceSourceConfig {
  return {
    gitLabAdvisoryApi:
      process.env.AUTOREMEDIATOR_GITLAB_ADVISORY_API ??
      "https://advisories.gitlab.com/api/v1/advisories",
    certCcSearchUrl:
      process.env.AUTOREMEDIATOR_CERTCC_SEARCH_URL ??
      "https://www.kb.cert.org/vuls/search",
    epssApi:
      process.env.AUTOREMEDIATOR_EPSS_API ??
      "https://api.first.org/data/v1/epss",
    cveServicesApi:
      process.env.AUTOREMEDIATOR_CVE_SERVICES_API ??
      "https://cveawg.mitre.org/api/cve",
    depsDevApi:
      process.env.AUTOREMEDIATOR_DEPSDEV_API ??
      "https://api.deps.dev/v3",
    scorecardApi:
      process.env.AUTOREMEDIATOR_SCORECARD_API ??
      "https://api.securityscorecards.dev",
    vendorAdvisoryFeeds: (process.env.AUTOREMEDIATOR_VENDOR_ADVISORY_FEEDS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    commercialFeeds: (process.env.AUTOREMEDIATOR_COMMERCIAL_FEEDS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    commercialFeedToken: process.env.AUTOREMEDIATOR_COMMERCIAL_FEED_TOKEN,
  };
}
