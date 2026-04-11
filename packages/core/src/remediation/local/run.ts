import semver from "semver";
import { lookupCveOsv } from "../../intelligence/sources/osv.js";
import { lookupCveGitHub, mergeGhDataIntoCveDetails } from "../../intelligence/sources/github-advisory.js";
import { enrichWithNvd } from "../../intelligence/sources/nvd.js";
import type {
  CveDetails,
  LlmUsageMetrics,
  PatchResult,
  RemediateOptions,
  RemediationReport,
  VulnerablePackage,
} from "../../platform/types.js";
import { detectPackageManager } from "../../platform/package-manager.js";
import { resolveProvider } from "../../platform/config.js";
import { loadPolicy } from "../../platform/policy.js";
import { checkInventoryTool } from "../tools/check-inventory.js";
import { resolvePrimaryResult } from "./primary-strategy.js";
import { shouldAttemptPatchFallback, tryLocalPatchFallback } from "./fallback.js";

export async function runLocalRemediationPipeline(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  const cwd = options.cwd ?? process.cwd();
  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const preview = options.preview ?? false;
  const dryRun = (options.dryRun ?? false) || preview;
  const runTests = options.runTests ?? false;
  const policy = options.policy ?? "";
  const patchesDir = options.patchesDir || "./patches";
  const constraints = options.constraints ?? {};
  const loadedPolicy = loadPolicy(cwd, options.policy);
  const llmProvider = resolveProvider(options);
  const providerSafetyProfile =
    options.providerSafetyProfile ??
    loadedPolicy.providerSafetyProfile ??
    "relaxed";
  const requireConsensusForHighRisk =
    options.requireConsensusForHighRisk ??
    loadedPolicy.requireConsensusForHighRisk ??
    false;
  const dynamicModelRouting =
    options.dynamicModelRouting ??
    loadedPolicy.dynamicModelRouting ??
    false;
  const dynamicRoutingThresholdChars =
    options.dynamicRoutingThresholdChars ??
    loadedPolicy.dynamicRoutingThresholdChars;

  const collectedResults: PatchResult[] = [];
  const llmUsage: LlmUsageMetrics[] = [];
  const vulnerablePackages: VulnerablePackage[] = [];
  let cveDetails: CveDetails | null = null;
  let agentSteps = 0;

  const normalizedId = cveId.toUpperCase();
  const [osvDetails, ghPackages] = await Promise.all([
    lookupCveOsv(normalizedId),
    lookupCveGitHub(normalizedId).catch(() => []),
  ]);
  agentSteps += 2;

  if (!osvDetails && ghPackages.length === 0) {
    return {
      cveId,
      cveDetails: null,
      vulnerablePackages,
      results: collectedResults,
      agentSteps,
      summary: `Local mode failed at lookup-cve: ${normalizedId} not found in OSV or GitHub advisory data.`,
      correlation: {
        requestId: options.requestId,
        sessionId: options.sessionId,
        parentRunId: options.parentRunId,
      },
    };
  }

  cveDetails = osvDetails ?? {
    id: normalizedId,
    summary: "Details sourced from GitHub Advisory Database.",
    severity: "UNKNOWN",
    references: [],
    affectedPackages: [],
  };

  if (ghPackages.length > 0) {
    cveDetails = mergeGhDataIntoCveDetails(cveDetails, ghPackages);
  }
  cveDetails = await enrichWithNvd(cveDetails);

  if (cveDetails.affectedPackages.length === 0) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages,
      results: collectedResults,
      agentSteps,
      summary: `Local mode lookup succeeded but no npm affected packages were found for ${normalizedId}.`,
      correlation: {
        requestId: options.requestId,
        sessionId: options.sessionId,
        parentRunId: options.parentRunId,
      },
    };
  }

  const inventory = await (checkInventoryTool as any).execute({ cwd, packageManager });
  agentSteps += 1;

  if (inventory?.error) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages,
      results: collectedResults,
      agentSteps,
      summary: `Local mode failed at check-inventory: ${inventory.error}`,
      correlation: {
        requestId: options.requestId,
        sessionId: options.sessionId,
        parentRunId: options.parentRunId,
      },
    };
  }

  const installedPackages = (inventory.packages ?? []) as Array<{
    name: string;
    version: string;
    type: "direct" | "indirect";
  }>;

  for (const affected of cveDetails.affectedPackages) {
    if (!affected || typeof affected !== "object") continue;
    if (!affected.name || !affected.vulnerableRange) continue;
    if (affected.ecosystem !== "npm") continue;
    const matches = installedPackages.filter((pkg) => pkg.name === affected.name);
    for (const installed of matches) {
      if (!semver.valid(installed.version)) continue;
      let isVulnerable = false;
      try {
        isVulnerable = semver.satisfies(installed.version, affected.vulnerableRange, {
          includePrerelease: false,
        });
      } catch {
        continue;
      }
      if (isVulnerable) {
        vulnerablePackages.push({ installed, affected });
      }
    }
  }
  agentSteps += 1;

  for (const vulnerable of vulnerablePackages) {
    const primary = await resolvePrimaryResult({
      vulnerable,
      cwd,
      packageManager,
      dryRun,
      policy,
      runTests,
      constraints,
    });
    agentSteps += primary.steps;

    if (shouldAttemptPatchFallback(primary.result, constraints.preferVersionBump ?? false)) {
      const fallback = await tryLocalPatchFallback({
        cwd,
        packageManager,
        packageName: vulnerable.installed.name,
        vulnerableVersion: vulnerable.installed.version,
        cveId: normalizedId,
        cveSummary: cveDetails?.summary ?? normalizedId,
        dependencyScope: vulnerable.installed.type === "direct" ? "direct" : "transitive",
        dryRun,
        runTests,
        patchesDir,
        llmProvider,
        model: options.model,
        policy: options.policy,
        modelPersonality: options.modelPersonality,
        providerSafetyProfile,
        requireConsensusForHighRisk,
        dynamicModelRouting,
        dynamicRoutingThresholdChars,
      });
      agentSteps += fallback.steps;
      collectedResults.push(fallback.result);
      if (fallback.usage) {
        llmUsage.push(...fallback.usage);
      }
      continue;
    }

    collectedResults.push({
      ...primary.result,
      dependencyScope: vulnerable.installed.type === "direct" ? "direct" : "transitive",
    });
  }

  const appliedCount = collectedResults.filter((result) => result.applied).length;
  const unresolvedCount = collectedResults.filter((result) => !result.applied && !result.dryRun).length;
  const dryRunCount = collectedResults.filter((result) => result.dryRun).length;

  return {
    cveId,
    cveDetails,
    vulnerablePackages,
    results: collectedResults,
    agentSteps,
    summary: `Local mode completed: vulnerable=${vulnerablePackages.length}, applied=${appliedCount}, dryRun=${dryRunCount}, unresolved=${unresolvedCount}`,
    llmUsage: llmUsage.length > 0 ? llmUsage : undefined,
    correlation: {
      requestId: options.requestId,
      sessionId: options.sessionId,
      parentRunId: options.parentRunId,
    },
  };
}
