import { runRemediationPipeline } from "../remediation/pipeline.js";
import type { RemediateOptions, RemediationReport } from "../platform/types.js";
import { readIdempotentReport, storeIdempotentReport } from "../platform/idempotency.js";
import { resolveConstraints, resolveCorrelationContext, resolveProvenanceContext } from "./context.js";
import { resolveProvider } from "../platform/config.js";
import {
  addRemediateErrorStep,
  addRemediateResultSteps,
  addRemediateResumeStep,
  addRemediateStartStep,
  createRemediateEvidence,
  writeRemediateEvidence,
} from "./remediate.evidence.js";

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
  const llmProvider = resolveProvider(options);
  const evidence = createRemediateEvidence({
    cwd,
    cveId: normalizedCveId,
    options,
    llmProvider,
    correlation,
    provenance,
  });

  if (options.resume && options.idempotencyKey) {
    const cached = readIdempotentReport(cwd, options.idempotencyKey, normalizedCveId);
    if (cached) {
      addRemediateResumeStep(evidence, normalizedCveId);
      const evidenceFile = writeRemediateEvidence(cwd, evidence);
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

  addRemediateStartStep({
    evidence,
    cveId: normalizedCveId,
    options,
    llmProvider,
    constraints,
  });

  let report: RemediationReport;
  try {
    report = await runRemediationPipeline(normalizedCveId, {
      ...options,
      ...correlation,
      constraints,
    });
  } catch (error) {
    addRemediateErrorStep(evidence, normalizedCveId, error);
    writeRemediateEvidence(cwd, evidence);
    throw error;
  }

  addRemediateResultSteps(evidence, normalizedCveId, report);

  const evidenceFile = writeRemediateEvidence(cwd, evidence);

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
