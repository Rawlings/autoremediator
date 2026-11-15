import { getModelSpec } from "../../platform/config.js";
import { readIdempotentReport, storeIdempotentReport } from "../../platform/idempotency.js";
import type { RemediateOptions, RemediationReport } from "../../platform/types.js";
import { runLocalRemediationPipeline } from "../../remediation/local/index.js";
import {
  assertChangeRequestAllowed,
  createChangeRequestsForReports,
} from "../change-request/index.js";
import {
  resolveConstraints,
  resolveCorrelationContext,
  resolveProvenanceContext,
} from "../context.js";
import {
  addRemediateDispositionStep,
  addRemediateErrorStep,
  addRemediateResultSteps,
  addRemediateResumeStep,
  addRemediateStartStep,
  createRemediateEvidence,
  writeRemediateEvidence,
} from "../remediate.evidence.js";
import { applySimulationMetadata, assertValidSimulationMode } from "../reporting.js";
import { assertAutonomyAllows, summarizeAutonomy } from "../autonomy/index.js";
import { persistPlan } from "../runs/index.js";
import { assertValidCveId } from "./validators.js";

export async function remediate(
  cveId: string,
  options: RemediateOptions = {},
): Promise<RemediationReport> {
  assertChangeRequestAllowed(options);
  assertValidCveId(cveId);
  assertValidSimulationMode(options);

  const normalizedCveId = cveId.toUpperCase();
  const cwd = options.cwd ?? process.cwd();
  // Earned autonomy (opt-in via the policy): below L2 nothing may be changed.
  if (!options.dryRun && !options.preview) assertAutonomyAllows(cwd, options.policy, "apply", "remediate");
  const constraints = resolveConstraints(options, cwd);
  const provenance = resolveProvenanceContext(options);
  const correlation = resolveCorrelationContext(options);
  const model = getModelSpec(options.model);
  const evidence = createRemediateEvidence({
    cwd,
    cveId: normalizedCveId,
    options,
    model,
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
    model,
    constraints,
  });

  let report: RemediationReport;
  try {
    report = await runLocalRemediationPipeline(normalizedCveId, {
      ...options,
      ...correlation,
      constraints,
    });
  } catch (error) {
    addRemediateErrorStep(evidence, normalizedCveId, error);
    writeRemediateEvidence(cwd, evidence);
    throw error;
  }

  report = applySimulationMetadata(report, options);

  addRemediateResultSteps(evidence, normalizedCveId, report);
  addRemediateDispositionStep(evidence, normalizedCveId, report);

  const evidenceFile = writeRemediateEvidence(cwd, evidence);

  const finalReport: RemediationReport = {
    ...report,
    evidenceFile,
    correlation,
    provenance,
    constraints,
    resumedFromCache: false,
  };
  const autonomySummary = summarizeAutonomy(cwd, options.policy);
  if (autonomySummary) finalReport.autonomy = autonomySummary;

  if (options.changeRequest?.enabled) {
    finalReport.changeRequests = await createChangeRequestsForReports({
      cwd,
      options: options.changeRequest,
      reports: [finalReport],
    });
  }

  if (options.idempotencyKey && !options.dryRun && !options.preview) {
    storeIdempotentReport(cwd, options.idempotencyKey, normalizedCveId, finalReport);
  }

  return finalReport;
}

export async function planRemediation(
  cveId: string,
  options: RemediateOptions = {},
): Promise<RemediationReport> {
  if (Object.hasOwn(options, "dryRun") || Object.hasOwn(options, "preview")) {
    throw new Error(
      "planRemediation always runs with dryRun=true and preview=true. Remove dryRun/preview from options.",
    );
  }

  const report = await remediate(cveId, {
    ...options,
    preview: true,
    dryRun: true,
  });

  // The preview becomes a plan that `applyPlan` can carry out later. `evidence: false` asks for no
  // files to be written, so no run is recorded then.
  const cwd = options.cwd ?? process.cwd();
  const autonomy = summarizeAutonomy(cwd, options.policy);
  const withAutonomy = autonomy ? { ...report, autonomy } : report;
  if (options.evidence === false) return withAutonomy;
  // At L0 (observe) the findings are reported but no applicable plan is recorded.
  if (autonomy?.level === "L0") {
    return { ...withAutonomy, summary: `${report.summary} Autonomy is L0 (observe): no plan was recorded, so there is nothing to apply.` };
  }
  const { runId, planId } = await persistPlan(report, options, cwd);
  return { ...withAutonomy, runId, planId };
}
