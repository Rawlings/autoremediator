import { isAbsolute, normalize } from "node:path";

import type { Octokit } from "@octokit/rest";
import { parse as yamlParse } from "yaml";

import {
  type AutoremediatorRepoConfig,
  type BotPrDoctorConfig,
  DEFAULT_REPO_CONFIG,
  type ErrorLogger,
  MAX_DOCTOR_ATTEMPTS,
} from "./types.js";

type RawRepoConfig = Partial<AutoremediatorRepoConfig>;

/**
 * A repository's own config must only be able to point *inside* its checkout: absolute paths and
 * `..` segments would let it aim the server at arbitrary host directories.
 */
export function isContainedRelativePath(path: string): boolean {
  return !isAbsolute(path) && !normalize(path).split(/[\\/]/).includes("..");
}

const VALID_SEVERITIES = new Set(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

/**
 * Validate field types from untrusted YAML input before merging with defaults.
 * Fields with wrong types are silently dropped in favour of defaults.
 */
function sanitizeBotPrDoctor(raw: unknown): BotPrDoctorConfig | undefined {
  const defaults = DEFAULT_REPO_CONFIG.botPrDoctor ?? { enabled: false, maxAttempts: 2 };
  // `botPrDoctor: true` is shorthand for "on, with the default cap".
  if (typeof raw === "boolean") return { ...defaults, enabled: raw };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const candidate = raw as Record<string, unknown>;
  const attempts = candidate.maxAttempts;
  return {
    enabled: candidate.enabled === true,
    maxAttempts:
      typeof attempts === "number" &&
      Number.isInteger(attempts) &&
      attempts >= 1 &&
      attempts <= MAX_DOCTOR_ATTEMPTS
        ? attempts
        : defaults.maxAttempts,
  };
}

function sanitizeRaw(raw: Record<string, unknown>): RawRepoConfig {
  const out: RawRepoConfig = {};

  if (typeof raw.dryRun === "boolean") out.dryRun = raw.dryRun;
  if (typeof raw.runTests === "boolean") out.runTests = raw.runTests;
  if (typeof raw.minimumSeverity === "string" && VALID_SEVERITIES.has(raw.minimumSeverity)) {
    out.minimumSeverity = raw.minimumSeverity as AutoremediatorRepoConfig["minimumSeverity"];
  }
  if (typeof raw.cwd === "string" && raw.cwd.length <= 512 && isContainedRelativePath(raw.cwd)) {
    out.cwd = raw.cwd;
  }
  if (typeof raw.allowMajorBumps === "boolean") out.allowMajorBumps = raw.allowMajorBumps;
  if (Array.isArray(raw.denyPackages) && raw.denyPackages.every((p) => typeof p === "string")) {
    out.denyPackages = raw.denyPackages.slice(0, 200);
  }
  if (Array.isArray(raw.allowPackages) && raw.allowPackages.every((p) => typeof p === "string")) {
    out.allowPackages = raw.allowPackages.slice(0, 200);
  }
  if (raw.constraints !== null && typeof raw.constraints === "object") {
    out.constraints = raw.constraints as RawRepoConfig["constraints"];
  }
  if (raw.patchConfidenceThresholds !== null && typeof raw.patchConfidenceThresholds === "object") {
    out.patchConfidenceThresholds =
      raw.patchConfidenceThresholds as RawRepoConfig["patchConfidenceThresholds"];
  }
  if (raw.dispositionPolicy !== null && typeof raw.dispositionPolicy === "object") {
    out.dispositionPolicy = raw.dispositionPolicy as RawRepoConfig["dispositionPolicy"];
  }
  if (typeof raw.enablePrAutoHealing === "boolean") out.enablePrAutoHealing = raw.enablePrAutoHealing;
  if (
    typeof raw.maxHealingAttempts === "number" &&
    Number.isInteger(raw.maxHealingAttempts) &&
    raw.maxHealingAttempts >= 1 &&
    raw.maxHealingAttempts <= 10
  ) {
    out.maxHealingAttempts = raw.maxHealingAttempts;
  }
  const botPrDoctor = sanitizeBotPrDoctor(raw.botPrDoctor);
  if (botPrDoctor) out.botPrDoctor = botPrDoctor;
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
        typeof pr.repository === "string" &&
        /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(pr.repository)
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
    patchConfidenceThresholds: raw.patchConfidenceThresholds,
    dispositionPolicy: raw.dispositionPolicy,
    containmentMode: raw.containmentMode,
    escalationGraph: raw.escalationGraph,
    pullRequest: raw.pullRequest,
    enablePrAutoHealing: raw.enablePrAutoHealing ?? DEFAULT_REPO_CONFIG.enablePrAutoHealing,
    maxHealingAttempts: raw.maxHealingAttempts ?? DEFAULT_REPO_CONFIG.maxHealingAttempts,
    botPrDoctor: raw.botPrDoctor ?? DEFAULT_REPO_CONFIG.botPrDoctor,
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
  repo: string,
  logger?: ErrorLogger,
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

    return mergeWithDefaults(sanitizeRaw(parsed));
  } catch (error: unknown) {
    // 404 = file absent — that's fine, use defaults
    if (error !== null && typeof error === "object" && "status" in error && error.status === 404) {
      return { ...DEFAULT_REPO_CONFIG };
    }
    const message = error instanceof Error ? error.message : String(error);
    void logger?.({
      timestamp: new Date().toISOString(),
      source: "github-app",
      level: "warn",
      context: "repo-config.fetch",
      message: `Failed to parse repository config, falling back to defaults: ${message}`,
      error: message,
      details: { owner, repo },
    });
    return { ...DEFAULT_REPO_CONFIG };
  }
}
