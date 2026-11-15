import type { PackageManager, RemediationConstraints } from "../../platform/types.js";
import type { VerificationResult } from "../../remediation/verify/types.js";

/** How sure the analysis is that a declared dependency can be deleted. */
export type UnusedClassification = "certainly-unused" | "probably-unused" | "used-indirectly";

export type DependencySection = "dependencies" | "devDependencies" | "optionalDependencies";

export interface UnusedDependency {
  name: string;
  section: DependencySection;
  /** The range as declared in package.json. */
  range: string;
  classification: UnusedClassification;
  /** Why it is classified this way, in a sentence a reviewer can check. */
  reason: string;
  /** Where the evidence was found (files, scripts), when there is some. */
  evidence?: string[];
}

export type ReplaceableStatus =
  /** The project's whole declared Node range has the replacement. */
  | "replaceable"
  /** Some Node version the project declares lacks it: do not migrate until the floor is raised. */
  | "blocked-by-node"
  /** The project declares no Node floor (`engines.node`, `.nvmrc`), so nothing can be claimed. */
  | "unknown-node"
  /** The replacement only covers part of the package and the project uses more of it. */
  | "not-covered";

export interface ReplaceableDependency {
  name: string;
  section: DependencySection;
  range: string;
  status: ReplaceableStatus;
  /** The Node built-in or platform API that replaces the package. */
  replacement: string;
  /** Node versions that have the replacement, as a semver range. */
  nodeRange: string;
  migration: string;
  /** `drop-in` behaves the same for the common call; `check-usage` has differences to read first. */
  fit: "drop-in" | "check-usage";
  caveat?: string;
  /** Why the status is what it is (the project's Node range against `nodeRange`, or symbols used). */
  reason: string;
  source: string;
}

export interface NodeRequirement {
  /** The project's declared Node range (an `.nvmrc` pin is read as `>=` that version). */
  range: string;
  source: "engines.node" | ".nvmrc" | ".node-version";
  /** Where it was read from, relative to the analysed root. */
  file: string;
}

export interface DietPackageReport {
  name: string;
  /** Directory relative to the analysed root; `.` for the root package. */
  dir: string;
  manifestPath: string;
  node?: NodeRequirement;
  counts: {
    declared: number;
    used: number;
    certainlyUnused: number;
    probablyUnused: number;
    usedIndirectly: number;
    replaceable: number;
  };
  /** Declared dependencies with no direct import: the three classifications. */
  unused: UnusedDependency[];
  replaceable: ReplaceableDependency[];
  /** What the scan covered, so a reader can judge how much to trust a `certainly-unused`. */
  scan: {
    sourceFiles: number;
    configFiles: number;
    dynamicLoadFiles: string[];
    unparsedFiles: string[];
    dependenciesInstalled: boolean;
  };
}

export interface DuplicateParent {
  /** Package that asks for this version; `(project)` or a workspace package name for direct ones. */
  name: string;
  version?: string;
  /** The range the parent declares. Unknown when only resolved versions are on record (pnpm, not installed). */
  range?: string;
  direct: boolean;
}

export interface DuplicateVersion {
  version: string;
  parents: DuplicateParent[];
  /**
   * The highest newer installed version that every parent of this one accepts, so a dedupe could
   * move it there without leaving any parent's range. Absent when none, or when ranges are unknown.
   */
  movableTo?: string;
}

export type DuplicateVerdict =
  /** One installed version satisfies every parent's range: `dedupe` or an override to it is safe by semver. */
  | "dedupe-within-range"
  /** Some copies can be collapsed within range, others are held by a parent that excludes the rest. */
  | "partly-dedupable"
  /** Every copy is held by a parent whose range excludes the others: an override or a parent upgrade is needed. */
  | "needs-override-or-upgrade"
  /** The parents' ranges are not on record, so nothing can be said about range. */
  | "unknown-ranges";

export interface DuplicatePackage {
  name: string;
  versions: DuplicateVersion[];
  verdict: DuplicateVerdict;
  /** The single version a dedupe would converge on, when `verdict` is `dedupe-within-range`. */
  unifiedVersion?: string;
  /** One line a reviewer can act on. */
  summary: string;
}

export interface DuplicatesReport {
  /** False when the lockfile format is not read (the reason is in `note`). */
  supported: boolean;
  note?: string;
  packages: DuplicatePackage[];
  /** Copies beyond the first, summed over duplicated packages. */
  extraCopies: number;
}

export interface SurfaceComponent {
  id: "size" | "depth" | "install-scripts" | "deprecated" | "waste" | "duplicates";
  label: string;
  /** The measured quantity (a count, or a depth). */
  value: number;
  points: number;
  maxPoints: number;
  /** How `points` follows from `value`, written out. */
  formula: string;
}

export interface AttackSurface {
  /** 0 (nothing installed) to 100. Higher means more code you did not choose runs in your project. */
  score: number;
  formulaVersion: 1;
  components: SurfaceComponent[];
  facts: {
    installedPackages: number;
    directDependencies: number;
    maxDepth: number;
    installScriptPackages: string[];
    deprecatedPackages: string[];
    certainlyUnused: number;
    probablyUnused: number;
    replaceable: number;
    extraCopies: number;
    /** Installed package.json files read, out of installedPackages (install scripts need them). */
    manifestsRead: number;
  };
  /** What the score could not see. */
  limits: string[];
}

export interface DependencyDietReport {
  schemaVersion: "1";
  cwd: string;
  root: string;
  packageManager: PackageManager;
  lockfile?: { path: string; format: "npm" | "pnpm" | "unsupported" };
  generatedAt: string;
  packages: DietPackageReport[];
  duplicates: DuplicatesReport;
  attackSurface: AttackSurface;
  summary: {
    packages: number;
    certainlyUnused: number;
    probablyUnused: number;
    usedIndirectly: number;
    replaceable: number;
    duplicatedPackages: number;
    score: number;
  };
  notes: string[];
}

export interface AnalyzeDependenciesOptions {
  cwd?: string;
}

export interface RemoveUnusedDependenciesOptions extends AnalyzeDependenciesOptions {
  packageManager?: PackageManager;
  policy?: string;
  /** Run the project's tests as part of verification. Default false. */
  runTests?: boolean;
  /** Type-check as part of verification. Default true (when a typecheck script or tsconfig exists). */
  typecheck?: boolean;
  constraints?: RemediationConstraints;
}

export interface RemovedDependency {
  /** Workspace package the dependency was removed from (`.` for the root). */
  dir: string;
  name: string;
  section: DependencySection;
  range: string;
}

export type DietApplyStatus = "removed" | "rolled-back" | "nothing-to-remove" | "failed";

export interface DietApplyResult {
  status: DietApplyStatus;
  /** What was (or, when rolled back, would have been) removed. */
  removals: RemovedDependency[];
  /** The verifier's verdict on the change. Absent when nothing was changed. */
  verification?: VerificationResult;
  /** Set when the removal was undone, or could not be completed. */
  message: string;
  /** The analysis the removals were chosen from. */
  report: DependencyDietReport;
}
