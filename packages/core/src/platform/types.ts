// ---------------------------------------------------------------------------
// Core domain types for autoremediator
// ---------------------------------------------------------------------------

/** A resolved CVE entry with affected npm package info */
export interface CveDetails {
  id: string; // e.g. "CVE-2021-23337"
  summary: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
  cvssScore?: number;
  references: string[];
  affectedPackages: AffectedPackage[];
}

/** A single npm package affected by a CVE */
export interface AffectedPackage {
  name: string;
  ecosystem: "npm";
  /** Semver range string for the vulnerable version window, e.g. ">=0.0.0 <4.17.21" */
  vulnerableRange: string;
  /** The first version that is NOT vulnerable (the safe upgrade target) */
  firstPatchedVersion?: string;
  /** Source that provided this entry */
  source: "osv" | "github-advisory";
}

/** A package found in the consumer's project */
export interface InventoryPackage {
  name: string;
  version: string;
  /** "direct" = listed in package.json; "indirect" = transitive dep */
  type: "direct" | "indirect";
}

/** A package that is both installed and matches a vulnerable range */
export interface VulnerablePackage {
  installed: InventoryPackage;
  affected: AffectedPackage;
  /** The resolved safe upgrade version, if one exists on npm */
  safeUpgradeVersion?: string;
}

/** The outcome of a single patch operation */
export type PatchStrategy = "version-bump" | "patch-file" | "none";

export interface PatchResult {
  packageName: string;
  strategy: PatchStrategy;
  fromVersion: string;
  toVersion?: string;
  patchFilePath?: string;
  applied: boolean;
  dryRun: boolean;
  message: string;
  validation?: {
    passed: boolean;
    error?: string;
  };
}

/** Top-level options for the remediate() API and CLI */
export interface RemediateOptions {
  /** Working directory of the consumer's project (defaults to process.cwd()) */
  cwd?: string;
  /** Package manager to use (defaults to auto-detect from lockfile) */
  packageManager?: "npm" | "pnpm" | "yarn";
  /** If true, plan and report changes but do not write anything */
  dryRun?: boolean;
  /** If true, skip running npm test after patching */
  skipTests?: boolean;
  /** Override the LLM provider (falls back to env AUTOREMEDIATOR_LLM_PROVIDER) */
  llmProvider?: "openai" | "anthropic" | "local";
  /** Override the model name */
  model?: string;
  /** Optional path to a policy file (.autoremediator.json) */
  policyPath?: string;
  /** Directory to write .patch files (default: ./patches) */
  patchesDir?: string;
}

/** Final report returned by the remediation pipeline */
export interface RemediationReport {
  cveId: string;
  cveDetails: CveDetails | null;
  vulnerablePackages: VulnerablePackage[];
  results: PatchResult[];
  agentSteps: number;
  summary: string;
}
