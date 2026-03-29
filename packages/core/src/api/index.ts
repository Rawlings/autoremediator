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
  RemediationConstraints,
  ProvenanceContext,
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
  UnresolvedReason,
  UnresolvedReasonCounts,
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
export { remediate, planRemediation } from "./remediate.js";
export { remediateFromScan } from "./remediate-from-scan.js";
