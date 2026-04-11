/**
 * autoremediator public SDK
 *
 * Usage:
 *   import { remediate } from 'autoremediator';
 *   const report = await remediate('CVE-2021-23337', { cwd: '/my/project' });
 */
export { runRemediationPipeline } from "../remediation/pipeline.js";

export type {
  CorrelationContext,
  LlmUsageMetrics,
  ModelPersonality,
  RemediationConstraints,
  ProvenanceContext,
  ProgressEvent,
  ProviderSafetyProfile,
  RemediateOptions,
  RemediationReport,
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
  PatchMode,
  PatchRiskLevel,
  PatchConfidenceThresholds,
  UnresolvedReason,
  UnresolvedReasonCounts,
  PatchValidationPhase,
  PatchValidationPhaseName,
} from "../platform/types.js";
export type { ScanInputFormat } from "../scanner/index.js";
export type { ScanOptions, ScanReport, CiSummary } from "./contracts.js";

export {
  PACKAGE_MANAGER_VALUES,
  LLM_PROVIDER_VALUES,
  PROVENANCE_SOURCE_VALUES,
  OPTION_DESCRIPTIONS,
  createConstraintSchemaProperties,
  createRemediateOptionSchemaProperties,
  createScanOptionSchemaProperties,
  createScanReportSchemaProperties,
} from "./options-schema.js";

export { toCiSummary, ciExitCode } from "./reporting.js";
export { toSarifOutput, type SarifOutput } from "./sarif.js";
export { inspectPatchArtifact, listPatchArtifacts, validatePatchArtifact } from "./patches.js";
export { remediate, planRemediation } from "./remediate.js";
export { remediateFromScan } from "./remediate-from-scan.js";
