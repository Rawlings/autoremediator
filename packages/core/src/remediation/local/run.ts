import semver from "semver";
import { lookupCveOsv } from "../../intelligence/sources/osv.js";
import { lookupCveGitHub, mergeGhDataIntoCveDetails } from "../../intelligence/sources/github-advisory.js";
import { enrichWithNvd } from "../../intelligence/sources/nvd.js";
import type {
  CveDetails,
  InventoryPackage,
  LlmUsageMetrics,
  PatchResult,
  RemediateOptions,
  RemediationReport,
  VulnerablePackage,
} from "../../platform/types.js";
import { checkInventoryTool } from "../tools/check-inventory.js";
import { assessPackageReachability } from "../tools/check-reachability.js";
import { runSecOpsPreflight } from "./secops-preflight.js";
import { buildSbom } from "./sbom.js";
import { resolvePrimaryResult } from "./primary-strategy.js";
import { shouldAttemptPatchFallback, tryLocalPatchFallback } from "./fallback.js";
import { resolveLocalRunOptions } from "./options.js";
import { findVulnerablePackages } from "./vulnerability-match.js";
import { buildLocalSummary } from "./summary.js";

export async function runLocalRemediationPipeline(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  const resolved = resolveLocalRunOptions(options);
  const {
    cwd,
    packageManager,
    dryRun,
    runTests,
    policy,
    patchesDir,
    constraints,
    llmProvider,
    providerSafetyProfile,
    requireConsensusForHighRisk,
    consensusProvider,
    consensusModel,
    patchConfidenceThresholds,
    dynamicModelRouting,
    dynamicRoutingThresholdChars,
    exploitSignalOverride,
    suppressions,
    suppressionsFile,
    slaCheck,
    slaPolicy,
    skipUnreachable,
    regressionCheck,
  } = resolved;

  const collectedResults: PatchResult[] = [];
  const llmUsage: LlmUsageMetrics[] = [];
  let vulnerablePackages: VulnerablePackage[] = [];
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

  const preflight = await runSecOpsPreflight(normalizedId, cveDetails, {
    suppressions,
    suppressionsFile,
    exploitSignalOverride,
    slaCheck,
    slaPolicy,
  });

  if (preflight.suppressed) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages: [],
      results: [],
      agentSteps,
      summary: preflight.summary,
      correlation: {
        requestId: options.requestId,
        sessionId: options.sessionId,
        parentRunId: options.parentRunId,
      },
    };
  }

  const { exploitSignalTriggered, slaBreaches } = preflight;

  if (cveDetails.affectedPackages.length === 0) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages,
      results: collectedResults,
      agentSteps,
      summary: `Local mode lookup succeeded but no npm affected packages were found for ${normalizedId}.`,
      exploitSignalTriggered,
      slaBreaches,
      correlation: {
        requestId: options.requestId,
        sessionId: options.sessionId,
        parentRunId: options.parentRunId,
      },
    };
  }

  const inventory = await (checkInventoryTool as any).execute({
    cwd,
    packageManager,
    policy: options.policy,
    workspace: constraints.workspace,
  });
  agentSteps += 1;

  if (inventory?.error) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages,
      results: collectedResults,
      agentSteps,
      summary: `Local mode failed at check-inventory: ${inventory.error}`,
      exploitSignalTriggered,
      slaBreaches,
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

  vulnerablePackages = findVulnerablePackages(cveDetails, installedPackages);
  agentSteps += 1;

  for (const vulnerable of vulnerablePackages) {
    if (skipUnreachable) {
      const reach = assessPackageReachability(cwd, vulnerable.installed.name);
      if (reach.status === "not-reachable") {
        collectedResults.push({
          packageName: vulnerable.installed.name,
          fromVersion: vulnerable.installed.version,
          strategy: "none",
          applied: false,
          dryRun,
          message: `Skipped: '${vulnerable.installed.name}' is not reachable from source code.`,
          reachability: reach,
        });
        continue;
      }
    }
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
        consensusProvider,
        consensusModel,
        patchConfidenceThresholds,
        dynamicModelRouting,
        dynamicRoutingThresholdChars,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
      });
      agentSteps += fallback.steps;
      collectedResults.push(fallback.result);
      if (fallback.usage) {
        llmUsage.push(...fallback.usage);
      }
      continue;
    }

    const primaryResult: PatchResult = {
      ...primary.result,
      dependencyScope: vulnerable.installed.type === "direct" ? "direct" : "transitive",
    };

    if (regressionCheck && primaryResult.applied && !dryRun && primaryResult.toVersion) {
      try {
        if (semver.satisfies(primaryResult.toVersion, vulnerable.affected.vulnerableRange, { includePrerelease: false })) {
          primaryResult.regressionDetected = true;
        }
      } catch {
        // ignore malformed range
      }
    }

    collectedResults.push(primaryResult);
  }

  const vulnerableNames = new Set(vulnerablePackages.map((v) => v.installed.name));
  const sbom = buildSbom(installedPackages as InventoryPackage[], vulnerableNames, collectedResults);

  return {
    cveId,
    cveDetails,
    vulnerablePackages,
    results: collectedResults,
    agentSteps,
    summary: buildLocalSummary(vulnerablePackages, collectedResults),
    llmUsage: llmUsage.length > 0 ? llmUsage : undefined,
    exploitSignalTriggered,
    slaBreaches,
    sbom,
    correlation: {
      requestId: options.requestId,
      sessionId: options.sessionId,
      parentRunId: options.parentRunId,
    },
  };
}
