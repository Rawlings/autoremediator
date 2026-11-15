/**
 * autoremediator public SDK
 *
 * Usage:
 *   import { remediate } from 'autoremediator';
 *   const report = await remediate('CVE-2021-23337', { cwd: '/my/project' });
 */
export type {
  CorrelationContext,
  LlmUsageMetrics,
  ProvenanceContext,
  RemediateOptions,
  RemediationReport,
  ResultSimulation,
  PatchResult,
  EscalationCounts,
  Disposition,
  DispositionSignals,
  DispositionCounts,
  SlaBreach,
  SlaBreachEntry,
  SlaBreachSummary,
  SbomEntry,
  SbomStatus,
  SimulationMutation,
  SimulationMutationTarget,
  SimulationRebuttalCode,
  SimulationRebuttalFinding,
  SimulationSummary,
} from "../features/remediate/types.js";
export type {
  CveSeverity,
  PatchStrategy,
  PatchStrategyCounts,
  DependencyScope,
  DependencyScopeCounts,
  PatchMode,
  UnresolvedReason,
  UnresolvedReasonCounts,
} from "../shared/types.js";
export type {
  DispositionPolicy,
  EscalationAction,
  EscalationGraph,
  ExploitSignalOverridePolicy,
  PatchConfidenceThresholds,
  PatchRiskLevel,
  RemediationConstraints,
  SlaPolicy,
  VexJustification,
  VexSuppression,
} from "../infra/policy/types.js";
export type {
  CveDetails,
  AffectedPackage,
  InventoryPackage,
  VulnerablePackage,
  EvaluatePackageOptions,
  PackageEvaluationReport,
  VulnerabilityEvaluationEntry,
} from "../features/intelligence/types.js";
export type {
  MaintainerVexEvidence,
  MaintainerVexIgnored,
} from "../features/maintainer-vex/types.js";
export type {
  PatchArtifact,
  PatchArtifactInspection,
  PatchArtifactQueryOptions,
  PatchArtifactSummary,
  PatchArtifactValidationReport,
  PatchReconcileOptions,
  PatchReconcileResult,
  PatchReconcileReport,
} from "../features/patch/types.js";
export type { PatchValidationPhase, PatchValidationPhaseName } from "../features/verify/types.js";
export type {
  PortfolioReport,
  PortfolioTarget,
  PortfolioTargetResult,
} from "../features/remediate/portfolio/types.js";
export type {
  OutdatedPackage,
  UpdateOutdatedOptions,
  UpdateOutdatedReport,
} from "../features/freshness/update-outdated/types.js";
export type {
  CheckReachabilityOptions,
  ReachabilityAssessment,
  ReachabilityEvidence,
  ReachabilityEvidenceKind,
  RuntimeReachability,
  RuntimeReachabilityVerdict,
} from "../features/reachability/types.js";
export type {
  DeltaDependencyChange,
  DeltaFinding,
  DeltaScanOptions,
  DeltaScanReport,
} from "../features/scan/types.js";
export type { ScanInputFormat } from "../features/scan/index.js";
export type { ScanOptions, ScanReport, CiSummary } from "../features/remediate/contracts.js";

export {
  PACKAGE_MANAGER_VALUES,
  PROVENANCE_SOURCE_VALUES,
  OPTION_DESCRIPTIONS,
  createConstraintSchemaProperties,
  createRemediateOptionSchemaProperties,
  createScanOptionSchemaProperties,
  createScanReportSchemaProperties,
  createUpdateOutdatedOptionSchemaProperties,
} from "../features/remediate/options-schema.js";

export {
  toCiSummary,
  ciExitCode,
  EXIT_CODES,
  buildSlaBreachSummary,
  buildStrategyCounts,
  buildDependencyScopeCounts,
} from "../features/remediate/reporting.js";
export { toSarifOutput, type SarifOutput } from "../features/remediate/sarif.js";
export {
  toCycloneDxVex,
  type CycloneDxVexDocument,
  type CycloneDxVexVulnerability,
  type CycloneDxVexVulnerabilityAnalysis,
  type ToCycloneDxVexOptions,
} from "../features/vex/index.js";
export {
  inspectPatchArtifact,
  listPatchArtifacts,
  validatePatchArtifact,
  reconcilePatchArtifacts,
} from "../features/patch/artifacts/index.js";
export type {
  PatchGenerator,
  PatchGeneratorUsage,
  PatchProposal,
  PatchRequest,
} from "../features/patch/patch-generator.js";
export { createLlmPatchGenerator } from "../features/patch/llm-generator.js";
export { resolveLanguageModel } from "../features/patch/model.js";
export { remediatePortfolio } from "../features/remediate/portfolio/index.js";
export { remediate, planRemediation } from "../features/remediate/index.js";
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
} from "../features/runs/index.js";
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
} from "../features/runs/attempts.js";
export { remediateFromScan } from "../features/remediate/scan/index.js";
export { updateOutdated } from "../features/freshness/update-outdated/index.js";
export { checkReachability } from "../features/reachability/index.js";
export { traceRun } from "../features/trace/index.js";
export type { TraceRunOptions, TraceRunResult } from "../features/trace/index.js";
export type { TracePackage, TraceReport } from "../features/trace/types.js";
export { evaluatePackage } from "../features/intelligence/evaluate/index.js";
export {
  assessUpgrade,
  findVulnerableSymbols,
  IMPACT_POINTS,
  MEDIUM_THRESHOLD,
  type AssessUpgradeInput,
  type AssessUpgradeResult,
  type Breakability,
  type CallSite,
  type CandidateBasis,
  type FindVulnerableSymbolsInput,
  type FixDiff,
  type ImpactFinding,
  type VulnerableSymbolCandidate,
  type VulnerableSymbolsResult,
} from "../features/impact/index.js";
export { scanDelta } from "../features/scan/delta/index.js";
export { init, AGENT_HOSTS } from "../features/init/index.js";
export { installHooks, HOOK_MANAGERS, HOOK_NAMES } from "../features/hooks/index.js";
export type {
  HookChangeSummary,
  HookManager,
  HookName,
  HooksOptions,
  HooksResult,
  HookState,
  HookStatus,
} from "../features/hooks/index.js";
export {
  guardPackage,
  guardPackages,
  type GuardFinding,
  type GuardOptions,
  type GuardReport,
  type GuardVerdict,
} from "../features/guard/index.js";
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
} from "../features/guard/hook.js";
export {
  guardGitDiff,
  type GuardDiffOptions,
  type GuardDiffResult,
} from "../features/guard/diff.js";
export type { AgentHost, InitOptions, InitResult, ProjectFacts } from "../features/init/index.js";
export {
  submitRemediateJob,
  submitScanJob,
  submitPortfolioJob,
  pollJob,
  type JobHandle,
  type AsyncRemediationJob,
  type TypedAsyncRemediationJob,
} from "../features/jobs/index.js";
export {
  applyRecipe,
  captureRecipe,
  exportRecipes,
  listRecipes,
  type ApplyRecipeOptions,
  type CaptureRecipeOptions,
  type CaptureRecipeResult,
  type ExportRecipesOptions,
  type ExportResult,
  type ListRecipesOptions,
  type RecipeListing,
  type RecipeSummary,
} from "../features/recipes/index.js";
export {
  bisectLockfile,
  type BisectCommandRecord,
  type BisectedPackage,
  type BisectOptions,
  type BisectRemedy,
  type BisectReport,
  type BisectSkippedChange,
  type BisectStatus,
  type BisectStep,
  type BisectStepKind,
} from "../features/bisect/index.js";
export {
  getAutonomy,
  AutonomyRefusedError,
  LEVEL_NAMES as AUTONOMY_LEVEL_NAMES,
  TRACK_RECORD_PATH,
  type AutonomyConfig,
  type AutonomyLevel,
  type AutonomyStatus,
  type AutonomySummary,
  type GetAutonomyOptions,
  type TrackEvent,
  type Transition as AutonomyTransition,
  type WindowStats as AutonomyWindowStats,
} from "../features/autonomy/index.js";
export {
  analyzeDependencies,
  removeUnusedDependencies,
  type AnalyzeDependenciesOptions,
  type AttackSurface,
  type DependencyDietReport,
  type DietApplyResult,
  type DietApplyStatus,
  type DietPackageReport,
  type DuplicatePackage,
  type DuplicatesReport,
  type DuplicateVerdict,
  type RemovedDependency,
  type RemoveUnusedDependenciesOptions,
  type ReplaceableDependency,
  type ReplaceableStatus,
  type SurfaceComponent,
  type UnusedClassification,
  type UnusedDependency,
} from "../features/diet/index.js";
export {
  incident,
  incidentExitCode,
  isAdvisoryId,
  renderIncidentMarkdown,
  scanSecrets,
  type AffectedRange,
  type ChecklistItem,
  type CiFile,
  type ContainerFile,
  type EnvTemplate,
  type Exposure,
  type HistoryReport,
  type IncidentOptions,
  type IncidentReport,
  type IncidentTarget,
  type NpmrcFile,
  type Occurrence,
  type PackageExposure,
  type PackageHistory,
  type Rollback,
  type RollbackProposal,
  type SecretsChecklist,
  type VersionWindow,
} from "../features/incident/index.js";
export {
  discoverRepos,
  premortem,
  type PackageBlastRadius,
  type PlaybookKind,
  type PremortemOptions,
  type PremortemReport,
  type PremortemRepo,
  type PremortemTarget,
  type PremortemUsage,
} from "../features/incident/premortem/index.js";
export {
  compilePolicy,
  explainPolicy,
  findLoosenings,
  isLoosening,
  PolicyRequestError,
  writePolicyProposal,
  type CompilePolicyOptions,
  type ExplainPolicyOptions,
  type ExplainPolicyResult,
  type Loosening,
  type PolicyCompileResult,
  type PolicyProposer,
  type PolicyRule,
} from "../features/policy-nl/index.js";
export {
  maintain,
  type MaintainAdvisory,
  type MaintainDecision,
  type MaintainOptions,
  type MaintainPackageFinding,
  type MaintainPlanSummary,
  type MaintainResult,
} from "../features/maintainer-vex/maintain/index.js";
export {
  readMaintainerVex,
  type MaintainerVexReport,
  type MaintainerVexStatementSummary,
  type OwnVexSummary,
  type ReadMaintainerVexOptions,
  type ShippedVexSummary,
} from "../features/maintainer-vex/api.js";
export {
  defaultProveDeps,
  findEvidence,
  generateProofOfFix,
  proofEvidenceRefs,
  verifyProofEvidence,
  type ProofEvidence,
  type ProofEvidenceRef,
  type ProveDeps,
  type ProveOptions,
  type ProveResult,
  type ReproductionAgent,
  type SignatureCheck,
  type TrialSummary,
} from "../features/prove/index.js";
export {
  createLlmRadarClassifier,
  radar,
  radarExitCode,
  renderRadar,
  type RadarAdvisory,
  type RadarCategory,
  type RadarConfidence,
  type RadarDeps,
  type RadarEntry,
  type RadarFlag,
  type RadarImpact,
  type RadarModelPort,
  type RadarModelRequest,
  type RadarModelVerdict,
  type RadarOptions,
  type RadarReport,
  type RadarSkipped,
  type RadarTarget,
} from "../features/radar/index.js";
export {
  applyFreshness,
  freshnessReport,
  planFreshnessStep,
  type ApplyFreshnessOptions,
  type ApplyFreshnessResult,
  type FreshnessClimb,
  type FreshnessCounts,
  type FreshnessDistance,
  type FreshnessOptions,
  type FreshnessPackage,
  type FreshnessPlanResult,
  type FreshnessPolicy,
  type FreshnessReport,
  type FreshnessStatus,
  type FreshnessStep,
  type FreshnessStepOutcome,
  type PlanFreshnessStepOptions,
  type PlannedFreshnessStep,
  type StepAssessment,
} from "../features/freshness/index.js";
export {
  acceptMemory,
  addMemory,
  listMemory,
  memoryForHost,
  MEMORY_KINDS,
  MEMORY_PATH,
  proposeMemory,
  pruneMemory,
  removeMemory,
  type AddMemoryOptions,
  type AddMemoryReport,
  type ListMemoryOptions,
  type MemoryEntry,
  type MemoryEntryState,
  type MemoryForHost,
  type MemoryIdOptions,
  type MemoryKind,
  type MemoryListing,
  type MemoryProposal,
  type MemoryQuery,
  type NewMemoryEntry,
  type ProposeMemoryOptions,
} from "../features/memory/api.js";
export {
  buildEvidencePack,
  craDeadlines,
  EVIDENCE_PACK_DISCLAIMER,
  INTOTO_PAYLOAD_TYPE,
  PACK_PREDICATE_TYPE,
  pae,
  parseAwareness,
  RUN_PREDICATE_TYPE,
  SIGNING_KEY_ENV,
  verifyEvidencePack,
  type CraDeadlines,
  type DsseEnvelope,
  type EvidencePackFile,
  type EvidencePackOptions,
  type EvidencePackResult,
  type EvidencePackVerification,
} from "../features/evidence/pack/index.js";
