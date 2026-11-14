import { enrichWithCisaKev } from "../../intelligence/sources/cisa-kev.js";
import { enrichWithEpss } from "../../intelligence/sources/epss.js";
import {
  lookupCveGitHub,
  mergeGhDataIntoCveDetails,
} from "../../intelligence/sources/github-advisory.js";
import { enrichWithNvd } from "../../intelligence/sources/nvd.js";
import { lookupCveOsv } from "../../intelligence/sources/osv.js";
import {
  loadIntelligenceSnapshot,
  lookupSnapshotCve,
} from "../../intelligence/sources/snapshot.js";
import { computeEscalationAction } from "../../platform/escalation.js";
import type { PatchGenerator } from "../../platform/patch-generator.js";
import { isPackageAllowed, loadPolicy } from "../../platform/policy.js";
import { createProjectSnapshot } from "../../platform/rollback.js";
import type {
  CveDetails,
  LlmUsageMetrics,
  PatchResult,
  RemediateOptions,
  RemediationReport,
  VulnerablePackage,
} from "../../platform/types.js";
import { resolvePatchGenerator } from "../patch/resolve.js";
import { checkInventoryTool } from "../tools/check-inventory.js";
import { assessPackageReachability } from "../tools/check-reachability.js";
import { applyDispositionAndContainment } from "./disposition.js";
import { shouldAttemptPatchFallback, tryPatchFallback } from "./fallback.js";
import { resolveLocalRunOptions } from "./options.js";
import { resolvePrimaryResult } from "./primary-strategy.js";
import { buildSbom } from "./sbom.js";
import { runSecOpsPreflight } from "./secops-preflight.js";
import { buildLocalSummary } from "./summary.js";
import { findVulnerablePackages } from "./vulnerability-match.js";

export async function runLocalRemediationPipeline(
  cveId: string,
  options: RemediateOptions = {},
): Promise<RemediationReport> {
  const resolved = resolveLocalRunOptions(options);
  const { cwd, packageManager, dryRun, constraints } = resolved;

  const correlation = {
    requestId: options.requestId,
    sessionId: options.sessionId,
    parentRunId: options.parentRunId,
  };

  let generatorPromise: Promise<PatchGenerator | undefined> | undefined;
  const getGenerator = () =>
    (generatorPromise ??= resolvePatchGenerator({
      patchGenerator: options.patchGenerator,
      model: resolved.model,
    }));

  const collectedResults: PatchResult[] = [];
  const llmUsage: LlmUsageMetrics[] = [];
  let vulnerablePackages: VulnerablePackage[] = [];
  let cveDetails: CveDetails | null = null;

  const normalizedId = cveId.toUpperCase();
  let osvDetails: Awaited<ReturnType<typeof lookupCveOsv>> = null;
  let ghPackages: Awaited<ReturnType<typeof lookupCveGitHub>> = [];

  if (resolved.offlineIntelligence) {
    if (resolved.intelligenceSnapshotPath) {
      osvDetails = lookupSnapshotCve(
        loadIntelligenceSnapshot(resolved.intelligenceSnapshotPath),
        normalizedId,
      );
    }
  } else {
    [osvDetails, ghPackages] = await Promise.all([
      lookupCveOsv(normalizedId),
      lookupCveGitHub(normalizedId).catch(() => []),
    ]);
  }

  if (!osvDetails && ghPackages.length === 0) {
    return {
      cveId,
      cveDetails: null,
      vulnerablePackages,
      results: collectedResults,
      summary: resolved.offlineIntelligence
        ? `Offline mode: ${normalizedId} not found in intelligence snapshot.`
        : `Local mode failed at lookup-cve: ${normalizedId} not found in OSV or GitHub advisory data.`,
      correlation,
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
  if (!resolved.offlineIntelligence) {
    cveDetails = await enrichWithNvd(cveDetails);
    // Exploit signals feed exploitSignalOverride and disposition; without them those gates never fire.
    cveDetails = await enrichWithCisaKev(cveDetails);
    cveDetails = await enrichWithEpss(cveDetails);
  }

  const preflight = await runSecOpsPreflight(normalizedId, cveDetails, resolved);

  if (preflight.suppressed) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages: [],
      results: [],
      summary: preflight.summary,
      correlation,
    };
  }

  const { exploitSignalTriggered, slaBreaches } = preflight;

  if (cveDetails.affectedPackages.length === 0) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages,
      results: collectedResults,
      summary: `Local mode lookup succeeded but no npm affected packages were found for ${normalizedId}.`,
      exploitSignalTriggered,
      slaBreaches,
      correlation,
    };
  }

  const inventory = await checkInventoryTool.execute({
    cwd,
    packageManager,
    policy: options.policy,
    workspace: constraints.workspace,
  });

  if (inventory?.error) {
    return {
      cveId,
      cveDetails,
      vulnerablePackages,
      results: collectedResults,
      summary: `Local mode failed at check-inventory: ${inventory.error}`,
      exploitSignalTriggered,
      slaBreaches,
      correlation,
    };
  }

  const installedPackages = (inventory.packages ?? []) as Array<{
    name: string;
    version: string;
    type: "direct" | "transitive";
  }>;

  vulnerablePackages = findVulnerablePackages(cveDetails, installedPackages);

  const effectivePolicy = loadPolicy(cwd, options.policy);
  const containmentMode = options.containmentMode ?? effectivePolicy.containmentMode ?? false;
  const dispositionPolicy = options.dispositionPolicy ?? effectivePolicy.dispositionPolicy;

  for (const vulnerable of vulnerablePackages) {
    const snapshot = await createProjectSnapshot(cwd);

    const finalizePatchResult = (result: PatchResult): PatchResult => {
      const withDisposition = applyDispositionAndContainment(result, {
        exploitSignalTriggered,
        slaBreaches,
        severity: cveDetails?.severity,
        policy: dispositionPolicy,
        containmentMode,
        cwd,
        snapshot,
      });
      if (withDisposition.unresolvedReason) {
        withDisposition.escalationAction = computeEscalationAction(
          withDisposition.unresolvedReason,
          resolved.escalationGraph,
        );
      }
      return withDisposition;
    };

    if (!isPackageAllowed(effectivePolicy, vulnerable.installed.name)) {
      collectedResults.push(
        finalizePatchResult({
          packageName: vulnerable.installed.name,
          fromVersion: vulnerable.installed.version,
          strategy: "none",
          applied: false,
          dryRun,
          unresolvedReason: "policy-blocked",
          message: `Policy denyPackages blocked changes for package "${vulnerable.installed.name}".`,
        }),
      );
      continue;
    }

    if (resolved.skipUnreachable) {
      const reach = assessPackageReachability(cwd, vulnerable.installed.name);
      if (reach.status === "not-reachable") {
        collectedResults.push(
          finalizePatchResult({
            packageName: vulnerable.installed.name,
            fromVersion: vulnerable.installed.version,
            strategy: "none",
            applied: false,
            dryRun,
            message: `Skipped: '${vulnerable.installed.name}' is not reachable from source code.`,
            reachability: reach,
          }),
        );
        continue;
      }
    }
    const primary = await resolvePrimaryResult({
      vulnerable,
      cwd,
      packageManager,
      dryRun,
      policy: resolved.policy,
      runTests: resolved.runTests,
      constraints,
      proofOfFix: resolved.proofOfFix,
      requireProofOfFix: resolved.requireProofOfFix,
      reproductionTest: options.reproductionTest,
      patchesDir: resolved.patchesDir,
    });

    if (shouldAttemptPatchFallback(primary.result, constraints.preferVersionBump ?? false)) {
      const fallback = await tryPatchFallback({
        cwd,
        packageManager,
        packageName: vulnerable.installed.name,
        vulnerableVersion: vulnerable.installed.version,
        cveId: normalizedId,
        cveSummary: cveDetails?.summary ?? normalizedId,
        dependencyScope: vulnerable.installed.type === "direct" ? "direct" : "transitive",
        dryRun,
        runTests: resolved.runTests,
        patchesDir: resolved.patchesDir,
        getGenerator,
        policy: options.policy,
        patchConfidenceThresholds: resolved.patchConfidenceThresholds,
        installMode: constraints.installMode,
        installPreferOffline: constraints.installPreferOffline,
        enforceFrozenLockfile: constraints.enforceFrozenLockfile,
        workspace: constraints.workspace,
        vulnerableRange: vulnerable.affected.vulnerableRange,
        proofOfFix: resolved.proofOfFix,
        requireProofOfFix: resolved.requireProofOfFix,
      });
      collectedResults.push(finalizePatchResult(fallback.result));
      if (fallback.usage) {
        llmUsage.push(...fallback.usage);
      }
      continue;
    }

    const primaryResult: PatchResult = {
      ...primary.result,
      dependencyScope: vulnerable.installed.type === "direct" ? "direct" : "transitive",
    };

    collectedResults.push(finalizePatchResult(primaryResult));
  }

  const vulnerableNames = new Set(vulnerablePackages.map((v) => v.installed.name));
  const sbom = buildSbom(installedPackages, vulnerableNames, collectedResults);

  return {
    cveId,
    cveDetails,
    vulnerablePackages,
    results: collectedResults,
    summary: buildLocalSummary(vulnerablePackages, collectedResults),
    llmUsage: llmUsage.length > 0 ? llmUsage : undefined,
    exploitSignalTriggered,
    slaBreaches,
    sbom,
    correlation,
  };
}
