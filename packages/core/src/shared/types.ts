export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "deno";

/**
 * CVSS v3 qualitative severity rating.
 * Anchored to the CVSS v3 standard (none/low/medium/high/critical).
 * Values are uppercase; incoming 'moderate' (npm audit, GitHub Advisory) is normalised to 'MEDIUM'.
 */
export type CveSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

/** The outcome of a single patch operation */
export type PatchStrategy =
  | "version-bump"
  | "override"
  | "patch-file"
  | "breaking-change-refactor"
  | "none";

export type DependencyScope = "direct" | "transitive";

export type PatchMode = "patch-package" | "native-pnpm" | "native-yarn";

export type UnresolvedReason =
  | "constraint-blocked"
  | "transitive-dependency"
  | "transitive-override-unsupported-deno-native"
  | "install-failed"
  | "major-bump-required"
  | "no-safe-version"
  | "override-apply-failed"
  | "package-json-not-found"
  | "patch-apply-failed"
  | "patch-confidence-too-low"
  | "patch-generation-failed"
  | "patch-validation-failed"
  | "proof-of-fix-failed"
  | "breaking-change-unresolved"
  | "policy-blocked"
  | "requires-llm-fallback"
  | "source-fetch-failed"
  | "validation-failed";

export type PatchStrategyCounts = Partial<Record<PatchStrategy, number>>;

export type DependencyScopeCounts = Partial<Record<DependencyScope, number>>;

export type UnresolvedReasonCounts = Partial<Record<UnresolvedReason, number>>;
