/**
 * autoremediator public SDK
 *
 * Usage:
 *   import { remediate } from 'autoremediator';
 *   const report = await remediate('CVE-2021-23337', { cwd: '/my/project' });
 */
export type {
  CorrelationContext,
  CveSeverity,
  LlmUsageMetrics,
  RemediationConstraints,
  ProvenanceContext,
  RemediateOptions,
  RemediationReport,
  ResultSimulation,
  CveDetails,
  AffectedPackage,
  InventoryPackage,
  VulnerablePackage,
  PatchResult,
  PatchStrategy,
  PatchStrategyCounts,
  DependencyScope,
  DependencyScopeCounts,
  PatchArtifact,
  PatchArtifactInspection,
  PatchArtifactQueryOptions,
  PatchArtifactSummary,
  PatchArtifactValidationReport,
  PatchReconcileOptions,
  PatchReconcileResult,
  PatchReconcileReport,
  PatchMode,
  PatchRiskLevel,
  PatchConfidenceThresholds,
  UnresolvedReason,
  UnresolvedReasonCounts,
  EscalationAction,
  EscalationGraph,
  EscalationCounts,
  Disposition,
  DispositionPolicy,
  DispositionSignals,
  DispositionCounts,
  PatchValidationPhase,
  PatchValidationPhaseName,
  PortfolioReport,
  PortfolioTarget,
  PortfolioTargetResult,
  OutdatedPackage,
  UpdateOutdatedOptions,
  UpdateOutdatedReport,
  ExploitSignalOverridePolicy,
  VexJustification,
  VexSuppression,
  SlaPolicy,
  SlaBreach,
  SlaBreachEntry,
  SlaBreachSummary,
  ReachabilityAssessment,
  ReachabilityEvidence,
  SbomEntry,
  SbomStatus,
  SimulationMutation,
  SimulationMutationTarget,
  SimulationRebuttalCode,
  SimulationRebuttalFinding,
  SimulationSummary,
  CheckReachabilityOptions,
  EvaluatePackageOptions,
  PackageEvaluationReport,
  VulnerabilityEvaluationEntry,
  DeltaDependencyChange,
  DeltaFinding,
  DeltaScanOptions,
  DeltaScanReport,
} from "../platform/types.js";
export type { ScanInputFormat } from "../scanner/index.js";
export type { ScanOptions, ScanReport, CiSummary } from "./contracts.js";

export {
  PACKAGE_MANAGER_VALUES,
  PROVENANCE_SOURCE_VALUES,
  OPTION_DESCRIPTIONS,
  createConstraintSchemaProperties,
  createRemediateOptionSchemaProperties,
  createScanOptionSchemaProperties,
  createScanReportSchemaProperties,
  createUpdateOutdatedOptionSchemaProperties,
} from "./options-schema.js";

export {
  toCiSummary,
  ciExitCode,
  EXIT_CODES,
  buildSlaBreachSummary,
  buildStrategyCounts,
  buildDependencyScopeCounts,
} from "./reporting.js";
export { toSarifOutput, type SarifOutput } from "./sarif.js";
export {
  toCycloneDxVex,
  type CycloneDxVexDocument,
  type CycloneDxVexVulnerability,
  type CycloneDxVexVulnerabilityAnalysis,
  type ToCycloneDxVexOptions,
} from "./vex/index.js";
export {
  inspectPatchArtifact,
  listPatchArtifacts,
  validatePatchArtifact,
  reconcilePatchArtifacts,
} from "./patches/index.js";
export type {
  PatchGenerator,
  PatchGeneratorUsage,
  PatchProposal,
  PatchRequest,
} from "../platform/patch-generator.js";
export { createLlmPatchGenerator } from "../remediation/patch/llm-generator.js";
export { resolveLanguageModel } from "../remediation/patch/model.js";
export { remediatePortfolio } from "./portfolio/index.js";
export { remediate, planRemediation } from "./remediate/index.js";
export {
  applyPlan,
  getRun,
  listRuns,
  resumeRun,
  rollbackRun,
  verifyRun,
  readAttemptArtifact,
  type AttemptArtifact,
  type ApplyPlanOptions,
  type ItemOutcome,
  type ListRunsOptions,
  type PlanItem,
  type PlanSkip,
  type RemediationPlan,
  type RollbackReport,
  type RollbackRunOptions,
  type RunDetails,
  type RunQuery,
  type RunRecord,
  type RunReport,
  type RunStatus,
  type RunVerification,
  type VerifyRunOptions,
  type CheckName,
  type CheckResult,
  type VerificationResult,
} from "./runs/index.js";
export {
  abandonAttempt,
  finalizeAttempt,
  proposePatch,
  startAttempt,
  verifyAttempt,
  type AttemptQuery,
  type AttemptView,
  type ProposePatchOptions,
  type StartAttemptOptions,
  type VerifyAttemptOptions,
} from "./runs/attempts.js";
export { remediateFromScan } from "./remediate-from-scan/index.js";
export { updateOutdated } from "./update-outdated/index.js";
export { checkReachability } from "./reachability/index.js";
export { evaluatePackage } from "./evaluate/index.js";
export { scanDelta } from "./delta-scan/index.js";
export { init, AGENT_HOSTS } from "./init/index.js";
export {
  guardPackage,
  guardPackages,
  type GuardFinding,
  type GuardOptions,
  type GuardReport,
  type GuardVerdict,
} from "./guard/index.js";
export {
  copilotHookOutput,
  cursorHookOutput,
  decideForCommand,
  guardExitCode,
  hookOutputFor,
  runClaudeCodeHook,
  runHostHook,
  HOOK_HOSTS,
  type HookHost,
} from "./guard/hook.js";
export { guardGitDiff, type GuardDiffOptions, type GuardDiffResult } from "./guard/diff.js";
export type { AgentHost, InitOptions, InitResult, ProjectFacts } from "./init/index.js";
export {
  submitRemediateJob,
  submitScanJob,
  submitPortfolioJob,
  pollJob,
  type JobHandle,
  type AsyncRemediationJob,
  type TypedAsyncRemediationJob,
} from "./jobs/index.js";
