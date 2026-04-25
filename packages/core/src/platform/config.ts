import type { LanguageModel } from "ai";
import type { PatchConfidenceThresholds, PatchRiskLevel, RemediateOptions } from "./types.js";
import { loadPolicy } from "./policy.js";

export type SupportedProvider = "remote" | "local";

interface ModelRoutingContext {
  inputChars?: number;
}

interface RemoteAdapterModule {
  [key: string]: unknown;
}

interface RemoteModelFactory {
  (options: { apiKey: string }): (modelName: string) => LanguageModel;
}

export function resolveProvider(options: RemediateOptions = {}): SupportedProvider {
  const raw = options.llmProvider ?? process.env.AUTOREMEDIATOR_LLM_PROVIDER ?? "remote";
  if (raw !== "remote" && raw !== "local") {
    throw new Error(
      `Unsupported LLM provider "${raw}". Set AUTOREMEDIATOR_LLM_PROVIDER to "remote" or "local".`
    );
  }
  return raw;
}

export function resolveModelName(
  provider: SupportedProvider,
  options: RemediateOptions = {},
  routing: ModelRoutingContext = {}
): string {
  if (options.model) return options.model;
  if (process.env.AUTOREMEDIATOR_MODEL) return process.env.AUTOREMEDIATOR_MODEL;

  const cwd = options.cwd ?? process.cwd();
  const policy = loadPolicy(cwd, options.policy);

  const providerEnvModel =
    provider === "remote"
      ? process.env.AUTOREMEDIATOR_MODEL_REMOTE
      : process.env.AUTOREMEDIATOR_MODEL_LOCAL;
  if (providerEnvModel) return providerEnvModel;

  const policyPinnedModel =
    provider === "remote" ? policy.modelDefaults?.remote : policy.modelDefaults?.local;
  if (policyPinnedModel) return policyPinnedModel;

  const defaults: Record<SupportedProvider, string> = {
    remote: "remote-default",
    local: "local",
  };

  const routingEnabled =
    options.dynamicModelRouting ??
    policy.dynamicModelRouting ??
    false;
  const threshold =
    options.dynamicRoutingThresholdChars ??
    policy.dynamicRoutingThresholdChars ??
    18000;

  if (
    provider === "remote" &&
    routingEnabled &&
    typeof routing.inputChars === "number" &&
    routing.inputChars >= threshold
  ) {
    return process.env.AUTOREMEDIATOR_MODEL_REMOTE_LARGE ?? "remote-large";
  }

  return defaults[provider];
}

async function loadRemoteFactory(): Promise<RemoteModelFactory> {
  const moduleName = process.env.AUTOREMEDIATOR_REMOTE_CLIENT_MODULE;
  const exportName = process.env.AUTOREMEDIATOR_REMOTE_CLIENT_FACTORY ?? "createRemoteClient";

  if (!moduleName) {
    throw new Error(
      "AUTOREMEDIATOR_REMOTE_CLIENT_MODULE is required for remote provider model loading."
    );
  }

  const loaded = (await import(moduleName)) as RemoteAdapterModule;
  const factory = loaded[exportName];
  if (typeof factory !== "function") {
    throw new Error(
      `Remote client factory "${exportName}" was not found in module "${moduleName}".`
    );
  }

  return factory as RemoteModelFactory;
}

export async function createModel(
  options: RemediateOptions = {},
  routing: ModelRoutingContext = {}
): Promise<LanguageModel> {
  const provider = resolveProvider(options);

  if (provider === "local") {
    throw new Error(
      "Local provider does not create a language model. Use the deterministic pipeline path instead."
    );
  }

  const apiKey = process.env.AUTOREMEDIATOR_REMOTE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AUTOREMEDIATOR_REMOTE_API_KEY environment variable is required for remote provider."
    );
  }

  const modelName = resolveModelName(provider, options, routing);
  const createRemoteClient = await loadRemoteFactory();
  const remoteClient = createRemoteClient({ apiKey });
  return remoteClient(modelName);
}

export function getPatchConfidenceThreshold(
  provider: SupportedProvider,
  safetyProfile: "strict" | "relaxed" = "relaxed",
  riskLevel: PatchRiskLevel = "medium",
  overrides?: PatchConfidenceThresholds
): number {
  const relaxed: Record<SupportedProvider, Record<PatchRiskLevel, number>> = {
    remote: { low: 0.65, medium: 0.7, high: 0.8 },
    local: { low: 0.65, medium: 0.7, high: 0.8 },
  };
  const strict: Record<SupportedProvider, Record<PatchRiskLevel, number>> = {
    remote: { low: 0.8, medium: 0.85, high: 0.9 },
    local: { low: 0.8, medium: 0.85, high: 0.9 },
  };

  const baseThreshold =
    safetyProfile === "strict"
      ? strict[provider][riskLevel]
      : relaxed[provider][riskLevel];
  const override = overrides?.[riskLevel];

  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(0, Math.min(1, override));
  }

  return baseThreshold;
}

export function estimateModelCostUsd(params: {
  provider: SupportedProvider;
  promptChars: number;
  completionChars: number;
}): number {
  const inputTokens = params.promptChars / 4;
  const outputTokens = params.completionChars / 4;

  const pricePerThousand =
    params.provider === "remote"
      ? { input: 0.006, output: 0.02 }
      : { input: 0, output: 0 };

  return (
    (inputTokens / 1000) * pricePerThousand.input +
    (outputTokens / 1000) * pricePerThousand.output
  );
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
