import type { RemediateOptions, RemediationReport } from "../platform/types.js";
import {
  addEvidenceStep,
  createEvidenceLog,
  finalizeEvidence,
  type EvidenceLog,
  writeEvidenceLog,
} from "../platform/evidence.js";

export function createRemediateEvidence(params: {
  cwd: string;
  cveId: string;
  options: RemediateOptions;
  llmProvider: "remote" | "local";
  correlation: { requestId?: string; sessionId?: string; parentRunId?: string };
  provenance: { actor?: string; source?: "cli" | "sdk" | "mcp" | "openapi" | "unknown" };
}): EvidenceLog | undefined {
  if (params.options.evidence === false) {
    return undefined;
  }

  return createEvidenceLog(params.cwd, [params.cveId], {
    ...params.correlation,
    actor: params.provenance.actor,
    source: params.provenance.source,
    llmProvider: params.llmProvider,
    idempotencyKey: params.options.idempotencyKey,
  });
}

export function addRemediateStartStep(params: {
  evidence: EvidenceLog | undefined;
  cveId: string;
  options: RemediateOptions;
  llmProvider: "remote" | "local";
  constraints: { directDependenciesOnly?: boolean; preferVersionBump?: boolean };
}): void {
  if (!params.evidence) {
    return;
  }

  addEvidenceStep(
    params.evidence,
    "remediate.start",
    {
      cveId: params.cveId,
      dryRun: Boolean(params.options.dryRun),
      preview: Boolean(params.options.preview),
      llmProvider: params.llmProvider,
    },
    {
      directDependenciesOnly: Boolean(params.constraints.directDependenciesOnly),
      preferVersionBump: Boolean(params.constraints.preferVersionBump),
    }
  );
}

export function addRemediateResultSteps(
  evidence: EvidenceLog | undefined,
  cveId: string,
  report: RemediationReport
): void {
  if (!evidence) {
    return;
  }

  for (const result of report.results) {
    addEvidenceStep(
      evidence,
      "remediate.package-result",
      {
        packageName: result.packageName,
        strategy: result.strategy,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
      },
      {
        applied: result.applied,
        dryRun: result.dryRun,
        unresolvedReason: result.unresolvedReason,
        reachability: result.reachability?.status,
        hasAlternatives: Boolean(result.alternativeSuggestions?.length),
        suppressedBy: result.suppressedBy?.justification,
        regressionDetected: result.regressionDetected,
      }
    );
  }

  addEvidenceStep(
    evidence,
    "remediate.finish",
    { cveId },
    {
      resultCount: report.results.length,
      vulnerableCount: report.vulnerablePackages.length,
      llmUsage: report.llmUsage,
      exploitSignalTriggered: report.exploitSignalTriggered ?? false,
      slaBreachCount: report.slaBreaches?.length ?? 0,
      regressionDetectedCount: report.results.filter((r) => r.regressionDetected).length,
      sbomEntryCount: report.sbom?.length ?? 0,
    }
  );
  finalizeEvidence(evidence);
}

export function addRemediateErrorStep(
  evidence: EvidenceLog | undefined,
  cveId: string,
  error: unknown
): void {
  if (!evidence) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  addEvidenceStep(evidence, "remediate.error", { cveId }, undefined, message);
  finalizeEvidence(evidence);
}

export function addRemediateResumeStep(evidence: EvidenceLog | undefined, cveId: string): void {
  if (!evidence) {
    return;
  }
  addEvidenceStep(evidence, "remediate.resume-cache", { cveId });
  finalizeEvidence(evidence);
}

export function writeRemediateEvidence(cwd: string, evidence: EvidenceLog | undefined): string | undefined {
  return evidence ? writeEvidenceLog(cwd, evidence) : undefined;
}
