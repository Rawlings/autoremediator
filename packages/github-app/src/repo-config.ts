import { parse as yamlParse } from "yaml";
import type { Octokit } from "@octokit/rest";
import { type AutoremediatorRepoConfig, DEFAULT_REPO_CONFIG } from "./types.js";

type RawRepoConfig = Partial<AutoremediatorRepoConfig>;

function mergeWithDefaults(raw: RawRepoConfig): AutoremediatorRepoConfig {
  return {
    dryRun: raw.dryRun ?? DEFAULT_REPO_CONFIG.dryRun,
    runTests: raw.runTests ?? DEFAULT_REPO_CONFIG.runTests,
    minimumSeverity: raw.minimumSeverity ?? DEFAULT_REPO_CONFIG.minimumSeverity,
    cwd: raw.cwd,
    allowMajorBumps: raw.allowMajorBumps ?? DEFAULT_REPO_CONFIG.allowMajorBumps,
    denyPackages: raw.denyPackages ?? DEFAULT_REPO_CONFIG.denyPackages,
    allowPackages: raw.allowPackages ?? DEFAULT_REPO_CONFIG.allowPackages,
    constraints: raw.constraints,
    modelDefaults: raw.modelDefaults,
    providerSafetyProfile: raw.providerSafetyProfile,
    requireConsensusForHighRisk: raw.requireConsensusForHighRisk,
    consensusProvider: raw.consensusProvider,
    consensusModel: raw.consensusModel,
    patchConfidenceThresholds: raw.patchConfidenceThresholds,
    dynamicModelRouting: raw.dynamicModelRouting,
    dynamicRoutingThresholdChars: raw.dynamicRoutingThresholdChars,
    dispositionPolicy: raw.dispositionPolicy,
    containmentMode: raw.containmentMode,
    escalationGraph: raw.escalationGraph,
    pullRequest: raw.pullRequest,
  };
}

/**
 * Fetch and parse .github/autoremediator.yml from a target repository via the
 * GitHub API. Falls back to DEFAULT_REPO_CONFIG when the file is absent (404)
 * or contains invalid YAML.
 */
export async function fetchRepoConfig(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<AutoremediatorRepoConfig> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: ".github/autoremediator.yml",
    });

    const data = response.data;
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return { ...DEFAULT_REPO_CONFIG };
    }

    const content = Buffer.from(data.content, "base64").toString("utf8");
    const parsed = yamlParse(content) as RawRepoConfig | null;

    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_REPO_CONFIG };
    }

    return mergeWithDefaults(parsed);
  } catch (error: unknown) {
    // 404 = file absent — that's fine, use defaults
    if (
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status: unknown }).status === 404
    ) {
      return { ...DEFAULT_REPO_CONFIG };
    }
    // Any other error (network, parse, etc.) — degrade to defaults silently
    return { ...DEFAULT_REPO_CONFIG };
  }
}
