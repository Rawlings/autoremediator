import type { PatchRiskLevel } from "../../infra/policy/types.js";
import type { PackageManager, PatchMode } from "../../shared/types.js";
import type { PatchValidationPhase, ProofOfFixVerification } from "../verify/types.js";

export interface PatchArtifact {
  schemaVersion: "1.0";
  cveId?: string;
  packageName: string;
  vulnerableVersion: string;
  patchFilePath: string;
  manifestFilePath?: string;
  patchFileName: string;
  patchesDir?: string;
  patchMode?: PatchMode;
  confidence?: number;
  riskLevel?: PatchRiskLevel;
  generatedAt: string;
  files?: string[];
  hunkCount?: number;
  applied: boolean;
  dryRun: boolean;
  /** SHA-256 integrity hash of the patch file content (format: sha256:<hex>) */
  integrity?: string;
  reproductionTest?: string;
  reproductionTestPath?: string;
  validationPhases?: PatchValidationPhase[];
  proofOfFix?: ProofOfFixVerification;
}

export interface PatchArtifactSummary {
  patchFilePath: string;
  manifestFilePath?: string;
  patchFileName: string;
  cveId?: string;
  packageName?: string;
  vulnerableVersion?: string;
  patchMode?: PatchMode;
  confidence?: number;
  riskLevel?: PatchRiskLevel;
  generatedAt?: string;
  files?: string[];
  hunkCount?: number;
  diffValid?: boolean;
  integrity?: string;
}

export interface PatchArtifactInspection extends PatchArtifactSummary {
  exists: boolean;
  diffValid: boolean;
  formatError?: string;
  patchSizeBytes?: number;
  lineCount?: number;
  manifest?: PatchArtifact;
}

export interface PatchArtifactValidationReport {
  patchFilePath: string;
  manifestFilePath?: string;
  exists: boolean;
  manifestFound: boolean;
  diffValid: boolean;
  formatError?: string;
  driftDetected: boolean;
  cveId?: string;
  packageName?: string;
  vulnerableVersion?: string;
  installedVersion?: string;
  inventoryMatch?: boolean;
  validationPhases: PatchValidationPhase[];
}

export interface PatchArtifactQueryOptions {
  cwd?: string;
  patchesDir?: string;
  packageManager?: PackageManager;
}

export interface PatchReconcileOptions extends PatchArtifactQueryOptions {
  autoApply?: boolean;
  runTests?: boolean;
}

export interface PatchReconcileResult {
  patchFilePath: string;
  packageName: string;
  cveId?: string;
  installedVersion?: string;
  safeUpstreamVersion?: string;
  status: "upgraded" | "safe-version-available" | "patch-retained" | "error";
  reason?: string;
}

export interface PatchReconcileReport {
  reconciled: PatchReconcileResult[];
  reconciledCount: number;
  retainedCount: number;
}
