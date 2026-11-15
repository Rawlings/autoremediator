/**
 * Dependency freshness: how far behind the latest release the direct dependencies are, and the
 * smallest verified steps that bring them back inside the policy's `freshness` limits.
 */
export { orderClimbs } from "./order.js";
export { freshnessReport } from "./report.js";
export { applyFreshness, planFreshnessStep } from "./step.js";
export { defaultFreshnessDeps, type FreshnessDeps } from "./deps.js";
export { distanceBetween, exceedsPolicy, penaltyOf, projectScore } from "./distance.js";
export { climbSteps } from "./path.js";
export { isIgnoredPackage, type FreshnessPolicy } from "../../infra/policy/freshness-policy.js";
export type {
  ApplyFreshnessOptions,
  ApplyFreshnessResult,
  FreshnessClimb,
  FreshnessCounts,
  FreshnessDistance,
  FreshnessOptions,
  FreshnessPackage,
  FreshnessPlanResult,
  FreshnessReport,
  FreshnessStatus,
  FreshnessStep,
  FreshnessStepOutcome,
  HeldReason,
  PlanFreshnessStepOptions,
  PlannedFreshnessStep,
  StepAssessment,
  StepOutcomeStatus,
} from "./types.js";
