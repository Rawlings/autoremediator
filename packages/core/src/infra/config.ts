/**
 * Environment-derived settings for external services.
 * Read at call time (not import time) so callers and tests can change the environment between runs.
 */

export interface NvdConfig {
  apiKey?: string;
}

export function getNvdConfig(): NvdConfig {
  return { apiKey: process.env.AUTOREMEDIATOR_NVD_API_KEY };
}

/** The configured patch-generation model (`provider:model`): explicit option first, then the environment. */
export function getModelSpec(explicit?: string): string | undefined {
  return explicit ?? process.env.AUTOREMEDIATOR_MODEL;
}

export function getGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN;
}

export function getEpssApiUrl(): string {
  return process.env.AUTOREMEDIATOR_EPSS_API ?? "https://api.first.org/data/v1/epss";
}
