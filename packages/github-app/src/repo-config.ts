import { parse as yamlParse } from "yaml";
import type { Octokit } from "@octokit/rest";
import { type AutoremediatorRepoConfig, DEFAULT_REPO_CONFIG } from "./types.js";

type RawRepoConfig = Partial<AutoremediatorRepoConfig>;

const VALID_SEVERITIES = new Set(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

/**
 * Validate field types from untrusted YAML input before merging with defaults.
 * Fields with wrong types are silently dropped in favour of defaults.
 */
function sanitizeRaw(raw: Record<string, unknown>): RawRepoConfig {
  const out: RawRepoConfig = {};

  if (typeof raw.dryRun === "boolean") out.dryRun = raw.dryRun;
  if (typeof raw.runTests === "boolean") out.runTests = raw.runTests;
  if (typeof raw.minimumSeverity === "string" && VALID_SEVERITIES.has(raw.minimumSeverity)) {
    out.minimumSeverity = raw.minimumSeverity as AutoremediatorRepoConfig["minimumSeverity"];
  }
  if (typeof raw.cwd === "string" && raw.cwd.length <= 512) out.cwd = raw.cwd;
  if (typeof raw.allowMajorBumps === "boolean") out.allowMajorBumps = raw.allowMajorBumps;
  if (Array.isArray(raw.denyPackages) && raw.denyPackages.every((p) => typeof p === "string")) {
    out.denyPackages = (raw.denyPackages as string[]).slice(0, 200);
  }
  if (Array.isArray(raw.allowPackages) && raw.allowPackages.every((p) => typeof p === "string")) {
    out.allowPackages = (raw.allowPackages as string[]).slice(0, 200);
  }
  if (raw.constraints !== null && typeof raw.constraints === "object") {
    out.constraints = raw.constraints as RawRepoConfig["constraints"];
  }
  if (raw.modelDefaults !== null && typeof raw.modelDefaults === "object") {
    out.modelDefaults = raw.modelDefaults as RawRepoConfig["modelDefaults"];
  }
  if (raw.providerSafetyProfile === "strict" || raw.providerSafetyProfile === "relaxed") {
    out.providerSafetyProfile = raw.providerSafetyProfile;
  }
  if (typeof raw.requireConsensusForHighRisk === "boolean") {
    out.requireConsensusForHighRisk = raw.requireConsensusForHighRisk;
  }
  if (raw.consensusProvider === "remote" || raw.consensusProvider === "local") {
    out.consensusProvider = raw.consensusProvider;
  }
  if (typeof raw.consensusModel === "string") out.consensusModel = raw.consensusModel.slice(0, 100);
  if (raw.patchConfidenceThresholds !== null && typeof raw.patchConfidenceThresholds === "object") {
    out.patchConfidenceThresholds = raw.patchConfidenceThresholds as RawRepoConfig["patchConfidenceThresholds"];
  }
  if (typeof raw.dynamicModelRouting === "boolean") out.dynamicModelRouting = raw.dynamicModelRouting;
  if (typeof raw.dynamicRoutingThresholdChars === "number") {
    out.dynamicRoutingThresholdChars = raw.dynamicRoutingThresholdChars;
  }
  if (raw.dispositionPolicy !== null && typeof raw.dispositionPolicy === "object") {
    out.dispositionPolicy = raw.dispositionPolicy as RawRepoConfig["dispositionPolicy"];
  }
  if (typeof raw.containmentMode === "boolean") out.containmentMode = raw.containmentMode;
  if (raw.escalationGraph !== null && typeof raw.escalationGraph === "object") {
    out.escalationGraph = raw.escalationGraph as RawRepoConfig["escalationGraph"];
  }
  if (raw.pullRequest !== null && typeof raw.pullRequest === "object") {
    const pr = raw.pullRequest as Record<string, unknown>;
    out.pullRequest = {
      enabled: typeof pr.enabled === "boolean" ? pr.enabled : undefined,
      grouping:
        pr.grouping === "all" || pr.grouping === "per-cve" || pr.grouping === "per-package"
          ? pr.grouping
          : undefined,
      repository:
        typeof pr.repository === "string" && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(pr.repository)
          ? pr.repository
          : undefined,
      baseBranch: typeof pr.baseBranch === "string" ? pr.baseBranch.slice(0, 100) : undefined,
      branchPrefix: typeof pr.branchPrefix === "string" ? pr.branchPrefix.slice(0, 80) : undefined,
      titlePrefix: typeof pr.titlePrefix === "string" ? pr.titlePrefix.slice(0, 200) : undefined,
      bodyFooter: typeof pr.bodyFooter === "string" ? pr.bodyFooter.slice(0, 2000) : undefined,
      draft: typeof pr.draft === "boolean" ? pr.draft : undefined,
      pushRemote:
        typeof pr.pushRemote === "string" && /^[a-zA-Z0-9._-]+$/.test(pr.pushRemote)
          ? pr.pushRemote
          : undefined,
      tokenEnvVar:
        typeof pr.tokenEnvVar === "string" && /^[A-Z_][A-Z0-9_]*$/.test(pr.tokenEnvVar)
          ? pr.tokenEnvVar
          : undefined,
    };
  }

  return out;
}

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

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_REPO_CONFIG };
    }

    return mergeWithDefaults(sanitizeRaw(parsed as Record<string, unknown>));
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
