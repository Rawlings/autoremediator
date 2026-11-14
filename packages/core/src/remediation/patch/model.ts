import type { LanguageModel } from "ai";

export interface ModelSpec {
  provider: string;
  modelId: string;
}

/** Provider ids map to `@ai-sdk/<provider>` packages, so only simple package-name characters are allowed. */
const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

/** Parse `"<provider>:<model-id>"`, e.g. `"anthropic:claude-sonnet-5-5"`. */
export function parseModelSpec(spec: string): ModelSpec {
  const separator = spec.indexOf(":");
  const provider = separator > 0 ? spec.slice(0, separator) : "";
  const modelId = separator > 0 ? spec.slice(separator + 1) : "";
  if (!PROVIDER_ID.test(provider) || modelId.length === 0) {
    throw new Error(
      `Invalid model "${spec}". Expected "<provider>:<model-id>", e.g. "anthropic:claude-sonnet-5-5".`,
    );
  }
  return { provider, modelId };
}

type ModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

/**
 * Resolve a model spec to an AI SDK language model by loading the matching `@ai-sdk/<provider>`
 * package, which must be installed alongside autoremediator. Credentials are read by that
 * package from its own standard environment variable (e.g. `ANTHROPIC_API_KEY`).
 *
 * Providers with a differently named export (e.g. `google-vertex`) are not covered; pass a
 * `PatchGenerator` through the SDK for those.
 */
export async function resolveLanguageModel(
  spec: string,
  load: ModuleLoader = (specifier) => import(specifier) as Promise<Record<string, unknown>>,
): Promise<LanguageModel> {
  const { provider, modelId } = parseModelSpec(spec);
  const packageName = `@ai-sdk/${provider}`;

  let loaded: Record<string, unknown>;
  try {
    loaded = await load(packageName);
  } catch (cause) {
    throw new Error(
      `Model "${spec}" requires the ${packageName} package. Install it next to autoremediator.`,
      { cause },
    );
  }

  const createModel = loaded[provider];
  if (typeof createModel !== "function") {
    throw new Error(`${packageName} does not export a "${provider}" provider.`);
  }
  return (createModel as (id: string) => LanguageModel)(modelId);
}
