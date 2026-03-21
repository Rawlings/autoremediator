export type {
  CveDetails,
  AffectedPackage,
  InventoryPackage,
  VulnerablePackage,
  PatchStrategy,
  PatchResult,
  RemediateOptions,
  RemediationReport,
  HealOptions,
  HealReport,
} from "./types.js";

export {
  resolveProvider,
  resolveModelName,
  createModel,
  getNvdConfig,
  getGitHubToken,
  type SupportedProvider,
  type NvdConfig,
} from "./config.js";

export {
  loadPolicy,
  isPackageAllowed,
  DEFAULT_POLICY,
  type AutoremediatorPolicy,
} from "./policy.js";

export {
  createEvidenceLog,
  addEvidenceStep,
  finalizeEvidence,
  writeEvidenceLog,
  type EvidenceStep,
  type EvidenceLog,
} from "./evidence.js";

export {
  detectPackageManager,
  getPackageManagerCommands,
  parseListOutput,
  type PackageManager,
  type PackageManagerCommands,
} from "./package-manager.js";
