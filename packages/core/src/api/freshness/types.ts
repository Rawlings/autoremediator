import type { FreshnessPolicy } from "../../platform/freshness-policy.js";
import type { Breakability } from "../../remediation/impact/impact.js";
import type {
  ChangeRequestOptions,
  ChangeRequestResult,
  PackageManager,
  RemediateOptions,
} from "../../platform/types.js";
import type { ApplyPlanOptions, RunReport } from "../runs/index.js";

export type { FreshnessPolicy };

/** How a package stands against the latest release. The distances are 0 for a current package. */
export interface FreshnessDistance {
  /** Latest major minus installed major. */
  majorsBehind: number;
  /** Latest minor minus installed minor, counted only when the installed copy is on the latest major. */
  minorsBehind: number;
  /** Latest patch minus installed patch, counted only when major and minor match. */
  patchesBehind: number;
  /** Stable releases newer than the installed version, up to the latest. Needs the registry's version list. */
  releasesBehind?: number;
  /** Days since the installed version was published. Needs the registry's publish times. */
  ageDays?: number;
}

export type FreshnessStatus = "current" | "behind" | "ignored" | "not-installed" | "unreadable";

export interface FreshnessPackage extends Partial<FreshnessDistance> {
  name: string;
  field: "dependencies" | "devDependencies";
  /** The range in package.json. */
  range: string;
  /** The installed version; absent when the dependency is not installed. */
  installed?: string;
  /** The latest release the registry reports; equal to `installed` for a current package. */
  latest?: string;
  status: FreshnessStatus;
  /** 0 (current) to 100 (far behind); see the guide for how it is made. Only for packages that count. */
  penalty?: number;
  /** The policy limits this package is past, in words. Empty when it is within them or there is no policy. */
  exceeds: string[];
}

/** What `assessUpgrade` said about a step, or that it could not say. */
export interface StepAssessment {
  breakability: Breakability | "Unknown";
  score?: number;
  summary: string;
}

/** One verified upgrade: one package, one jump. */
export interface FreshnessStep {
  packageName: string;
  field: "dependencies" | "devDependencies";
  fromVersion: string;
  toVersion: string;
  level: "patch" | "minor" | "major";
  /** `catch-up` stays on the installed major; `major` crosses into the next one. */
  kind: "catch-up" | "major";
  /** 1-based position in this package's climb, and how many steps the climb has. */
  index: number;
  of: number;
}

export type HeldReason =
  | "high-breakability"
  | "major-bump-not-allowed"
  | "package-not-allowed";

export interface FreshnessClimb {
  packageName: string;
  installed: string;
  latest: string;
  /** Every step needed to get inside the policy, in order. Only the first is ever taken in one go. */
  steps: FreshnessStep[];
  /** What `assessUpgrade` says about the first step. Absent when assessment was not requested. */
  assessment?: StepAssessment;
  /** Why the first step will not be taken. A held climb is reported and never applied. */
  held?: { reason: HeldReason; message: string };
}

export interface FreshnessCounts {
  /** Direct dependencies in package.json that come from a registry. */
  direct: number;
  current: number;
  behind: number;
  ignored: number;
  notInstalled: number;
  /** Installed, but a version that cannot be read as semver. Not counted in the score. */
  unreadable: number;
  /** Behind and past a policy limit. */
  exceeding: number;
}

export interface FreshnessReport {
  schemaVersion: "1.0";
  generatedAt: string;
  cwd: string;
  packageManager: PackageManager;
  /** The policy's `freshness` key; null when there is none, and then nothing is planned. */
  policy: FreshnessPolicy | null;
  /** 0 to 100, higher is fresher. 100 when there is nothing to count. */
  score: number;
  counts: FreshnessCounts;
  /** Behind packages first, worst penalty first; then current ones, then the rest. */
  packages: FreshnessPackage[];
  /** One climb per package past the policy, in the order the steps would be taken. */
  climbs: FreshnessClimb[];
  /** Packages past the policy for which no climb could be made, with why. */
  unplanned: Array<{ packageName: string; reason: string }>;
  notes: string[];
}

export interface FreshnessOptions {
  /** Project directory (default: process.cwd()). */
  cwd?: string;
  /** Policy file path or inline policy (default: `.github/autoremediator.yml`). */
  policy?: string;
  packageManager?: PackageManager;
  /** Only these packages. */
  packages?: string[];
  /** Rate the first step of each climb with `assessUpgrade` to order and hold them. Default false for the report. */
  assess?: boolean;
  /** Take steps `assessUpgrade` rates High. They are held otherwise. */
  allowHigh?: boolean;
}

export interface PlanFreshnessStepOptions extends Omit<FreshnessOptions, "assess"> {
  /** Never rate steps (default: they are rated, since the rating orders and holds them). */
  assess?: boolean;
  runTests?: boolean;
  typecheck?: boolean;
  /** Provenance recorded with the run. */
  source?: RemediateOptions["source"];
}

export interface PlannedFreshnessStep {
  step: FreshnessStep;
  assessment?: StepAssessment;
  runId: string;
  planId: string;
}

export interface FreshnessPlanResult {
  /** The step now waiting as a recorded plan; absent when nothing is eligible. */
  planned?: PlannedFreshnessStep;
  /** Why no plan was recorded, when none was. */
  reason?: string;
  held: Array<{ packageName: string; reason: string }>;
  report: FreshnessReport;
}

export interface ApplyFreshnessOptions
  extends PlanFreshnessStepOptions,
    Pick<
      ApplyPlanOptions,
      "repair" | "model" | "repairAgent" | "repairBudget" | "signal" | "verify"
    > {
  /** Most steps to take in this call (default 1: a scheduled job takes one reviewable step per run). */
  maxSteps?: number;
  /** One change request per step, on a branch named for the package and step. Needs a git repository. */
  changeRequest?: ChangeRequestOptions;
}

export type StepOutcomeStatus = "applied" | "failed" | "skipped";

export interface FreshnessStepOutcome {
  step: FreshnessStep;
  assessment?: StepAssessment;
  runId?: string;
  planId?: string;
  status: StepOutcomeStatus;
  message: string;
  /** The step's own run, after apply (and rollback, if it failed). */
  run?: Pick<RunReport, "status" | "message">;
  /** A failed step was taken back out with `rollbackRun`. */
  rolledBack?: boolean;
  changeRequest?: ChangeRequestResult;
}

export interface ApplyFreshnessResult {
  status: "ok" | "partial" | "failed" | "nothing-to-do";
  steps: FreshnessStepOutcome[];
  /** Packages the planner stopped on, with why: a failed step, or a held one. */
  stopped: Array<{ packageName: string; reason: string }>;
  /** Packages with a step still to take after this call. */
  remaining: string[];
  /** The report before the first step. */
  report: FreshnessReport;
  message: string;
}
