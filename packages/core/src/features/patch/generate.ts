import type { PatchConfidenceThresholds, PatchRiskLevel } from "../../infra/policy/types.js";
import { errorMessage } from "../../shared/errors.js";
import { generateUnifiedDiff } from "./diff.js";
import type { PatchGenerator, PatchProposal, PatchRequest } from "./patch-generator.js";
import { validatePatchedCodeSyntax } from "./syntax.js";

export interface GeneratedPatch {
  filePath: string;
  unifiedDiff: string;
}

/** Minimum self-reported confidence required to apply a patch, by assessed risk. */
export const DEFAULT_CONFIDENCE_THRESHOLDS: Readonly<Record<PatchRiskLevel, number>> = {
  low: 0.65,
  medium: 0.7,
  high: 0.8,
};

export function confidenceThreshold(
  riskLevel: PatchRiskLevel,
  overrides?: PatchConfidenceThresholds,
): number {
  const override = overrides?.[riskLevel];
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.min(1, Math.max(0, override));
  }
  return DEFAULT_CONFIDENCE_THRESHOLDS[riskLevel];
}

export type PatchGenerationFailure =
  | "generator-failed"
  | "unknown-file"
  | "invalid-syntax"
  | "no-changes"
  | "confidence-too-low";

export type PatchGenerationOutcome =
  | { ok: true; patches: GeneratedPatch[]; proposal: PatchProposal }
  | {
      ok: false;
      reason: PatchGenerationFailure;
      message: string;
      /** Present when the generator answered but the answer was rejected. */
      proposal?: PatchProposal;
    };

/**
 * Ask a generator for a fix and turn the answer into validated unified diffs.
 * Never throws: every rejection is reported as a typed failure with a human-readable message.
 */
export async function generatePatches(
  request: PatchRequest,
  generator: PatchGenerator,
  options: { confidenceThresholds?: PatchConfidenceThresholds } = {},
): Promise<PatchGenerationOutcome> {
  let proposal: PatchProposal;
  try {
    proposal = await generator.propose(request);
  } catch (error) {
    const detail = errorMessage(error);
    return { ok: false, reason: "generator-failed", message: `Patch generation failed: ${detail}` };
  }

  const patches: GeneratedPatch[] = [];
  for (const [filePath, fixed] of Object.entries(proposal.fixedFiles)) {
    const original = request.sourceFiles[filePath];
    if (original === undefined) {
      return {
        ok: false,
        reason: "unknown-file",
        message: `Generator returned "${filePath}", which is not part of ${request.packageName}@${request.vulnerableVersion}.`,
        proposal,
      };
    }

    const syntax = validatePatchedCodeSyntax(filePath, fixed);
    if (!syntax.valid) {
      return {
        ok: false,
        reason: "invalid-syntax",
        message: syntax.error ?? `Invalid syntax in patched ${filePath}.`,
        proposal,
      };
    }

    const unifiedDiff = generateUnifiedDiff(original, fixed, filePath);
    if (unifiedDiff) patches.push({ filePath, unifiedDiff });
  }

  if (patches.length === 0) {
    return {
      ok: false,
      reason: "no-changes",
      message: "Generator proposed no changes to the package source.",
      proposal,
    };
  }

  const required = confidenceThreshold(proposal.riskLevel, options.confidenceThresholds);
  if (proposal.confidence < required) {
    return {
      ok: false,
      reason: "confidence-too-low",
      message: `Patch confidence ${proposal.confidence.toFixed(2)} is below the ${required.toFixed(2)} required for ${proposal.riskLevel}-risk changes.`,
      proposal,
    };
  }

  return { ok: true, patches, proposal };
}
