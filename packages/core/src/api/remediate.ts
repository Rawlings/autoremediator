import { runRemediationPipeline } from "../remediation/pipeline.js";
import type { RemediateOptions, RemediationReport } from "../platform/types.js";
import { addEvidenceStep, createEvidenceLog, finalizeEvidence, writeEvidenceLog } from "../platform/evidence.js";
import { readIdempotentReport, storeIdempotentReport } from "../platform/idempotency.js";
import { resolveConstraints, resolveCorrelationContext, resolveProvenanceContext } from "./context.js";

export async function remediate(cveId: string, options: RemediateOptions = {}): Promise<RemediationReport> {
  if (!/^CVE-\d{4}-\d+$/i.test(cveId)) {
    throw new Error(
      `Invalid CVE ID: "${cveId}". Expected format: CVE-YYYY-NNNNN (e.g. CVE-2021-23337).`
    );
  }

  const normalizedCveId = cveId.toUpperCase();
  const cwd = options.cwd ?? process.cwd();
  const constraints = resolveConstraints(options, cwd);
  const provenance = resolveProvenanceContext(options);
  const correlation = resolveCorrelationContext(options);
  const evidenceEnabled = options.evidence !== false;
  const evidence = evidenceEnabled
    ? createEvidenceLog(cwd, [normalizedCveId], {
        ...correlation,
        actor: provenance.actor,
        source: provenance.source,
        idempotencyKey: options.idempotencyKey,
      })
    : undefined;

  if (options.resume && options.idempotencyKey) {
    const cached = readIdempotentReport(cwd, options.idempotencyKey, normalizedCveId);
    if (cached) {
      if (evidence) {
        addEvidenceStep(evidence, "remediate.resume-cache", { cveId: normalizedCveId });
        finalizeEvidence(evidence);
      }
      const evidenceFile = evidence ? writeEvidenceLog(cwd, evidence) : undefined;
      return {
        ...cached,
        summary: `${cached.summary} (resumed from idempotency cache)`,
        evidenceFile,
        correlation,
        provenance,
        constraints,
        resumedFromCache: true,
      };
    }
  }

  if (evidence) {
    addEvidenceStep(
      evidence,
      "remediate.start",
      {
        cveId: normalizedCveId,
        dryRun: Boolean(options.dryRun),
        preview: Boolean(options.preview),
      },
      {
        directDependenciesOnly: Boolean(constraints.directDependenciesOnly),
        preferVersionBump: Boolean(constraints.preferVersionBump),
      }
    );
  }

  let report: RemediationReport;
  try {
    report = await runRemediationPipeline(normalizedCveId, {
      ...options,
      ...correlation,
      constraints,
    });
  } catch (error) {
    if (evidence) {
      const message = error instanceof Error ? error.message : String(error);
      addEvidenceStep(evidence, "remediate.error", { cveId: normalizedCveId }, undefined, message);
      finalizeEvidence(evidence);
      writeEvidenceLog(cwd, evidence);
    }
    throw error;
  }

  if (evidence) {
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
        }
      );
    }

    addEvidenceStep(
      evidence,
      "remediate.finish",
      { cveId: normalizedCveId },
      {
        resultCount: report.results.length,
        vulnerableCount: report.vulnerablePackages.length,
      }
    );
    finalizeEvidence(evidence);
  }

  const evidenceFile = evidence ? writeEvidenceLog(cwd, evidence) : undefined;

  const finalReport: RemediationReport = {
    ...report,
    evidenceFile,
    correlation,
    provenance,
    constraints,
    resumedFromCache: false,
  };

  if (options.idempotencyKey && !options.dryRun && !options.preview) {
    storeIdempotentReport(cwd, options.idempotencyKey, normalizedCveId, finalReport);
  }

  return finalReport;
}

export async function planRemediation(
  cveId: string,
  options: RemediateOptions = {}
): Promise<RemediationReport> {
  return remediate(cveId, {
    ...options,
    preview: true,
    dryRun: true,
  });
}
