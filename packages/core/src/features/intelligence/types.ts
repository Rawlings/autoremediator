import type { CveSeverity } from "../../shared/types.js";

/** A resolved CVE entry with affected npm package info */
export interface CveDetails {
  id: string; // e.g. "CVE-2021-23337"
  summary: string;
  severity: CveSeverity;
  cvssScore?: number;
  publishedAt?: string; // ISO 8601 date string from OSV
  epss?: {
    score: number;
    /** Absent when the source (e.g. an offline snapshot) only provides the score. */
    percentile?: number;
    date?: string;
  };
  kev?: {
    knownExploited: boolean;
    dateAdded?: string;
    dueDate?: string;
    requiredAction?: string;
    knownRansomwareCampaignUse?: string;
  };
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
  source: "osv" | "github-advisory" | "offline-snapshot" | "user-supplied";
}

/** A package found in the consumer's project */
export interface InventoryPackage {
  name: string;
  version: string;
  /** "direct" = listed in package.json; "transitive" = nested dependency */
  type: "direct" | "transitive";
}

/** A package that is both installed and matches a vulnerable range */
export interface VulnerablePackage {
  installed: InventoryPackage;
  affected: AffectedPackage;
  /** The resolved safe upgrade version, if one exists on npm */
  safeUpgradeVersion?: string;
}

export interface AlternativePackageSuggestion {
  packageName: string;
  reason: string;
  confidence: number;
  source: "npm-search";
  npmUrl?: string;
  description?: string;
}

/** Options for evaluatePackage() */
export interface EvaluatePackageOptions {
  version?: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "deno";
  cwd?: string;
  enrichIntelligence?: boolean;
}

/** A single vulnerability found on a package during evaluatePackage() */
export interface VulnerabilityEvaluationEntry {
  cveId: string;
  severity: CveSeverity;
  summary: string;
  vulnerableRange?: string;
  firstPatchedVersion?: string;
  safeUpgradeVersion?: string;
  epssScore?: number;
  epssPercentile?: number;
  inCisaKev?: boolean;
  references?: string[];
}

/** Report returned by evaluatePackage() */
export interface PackageEvaluationReport {
  schemaVersion: "1.0";
  packageName: string;
  evaluatedVersion?: string;
  isVulnerable: boolean;
  verdict: "safe" | "caution" | "vulnerable" | "actively-exploited";
  summary: string;
  vulnerabilities: VulnerabilityEvaluationEntry[];
  recommendedVersion?: string;
  latestVersion?: string;
  generatedAt: string;
}
