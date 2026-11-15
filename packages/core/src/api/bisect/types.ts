import type { PackageManager } from "../../platform/types.js";
import type { ItemOutcome } from "../runs/index.js";

export interface BisectOptions {
  /** Project directory (default: process.cwd()). A subdirectory of a git repository is fine. */
  cwd?: string;
  /** Git ref (commit, tag, branch) where the command passes. */
  good: string;
  /** Git ref where the command fails (default: HEAD). Committed state is used, not the working tree. */
  bad?: string;
  /**
   * Shell command to run after installing, in a checkout of the project. It runs with your
   * privileges, exactly as if you ran it yourself; exit code 0 means pass.
   */
  command: string;
  /** Kill the command after this many seconds and count it as failing (default: 600). */
  timeoutSeconds?: number;
  /** Evaluate at most this many candidate states, not counting the good and bad refs (default: 30). */
  maxSteps?: number;
  /** Package manager (default: from the lockfile). npm and pnpm are supported; yarn classic is not exercised. */
  packageManager?: PackageManager;
  /** Pass `--ignore-scripts` to every install, so package install scripts do not run. */
  ignoreScripts?: boolean;
  /** Apply the recommended pin to the project through the run machinery instead of only planning it. */
  apply?: boolean;
  /** SDK only: stop the search (Ctrl-C). Checkouts are removed and the report so far is returned. */
  signal?: AbortSignal;
}

/** One package whose locked version differs between the two refs. */
export interface BisectedPackage {
  packageName: string;
  /** Version at the good ref. */
  fromVersion: string;
  /** Version at the bad ref. */
  toVersion: string;
  dependencyScope: "direct" | "transitive";
}

/** A lockfile change that cannot be tried one package at a time, with why. */
export interface BisectSkippedChange {
  packageName: string;
  fromVersions: string[];
  toVersions: string[];
  reason: string;
}

export type BisectStepKind =
  | "good-ref"
  | "bad-ref"
  | "all-updates"
  | "subset"
  | "without-culprit";

export interface BisectCommandRecord {
  /** What was run, as a display string. */
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface BisectStep {
  step: number;
  kind: BisectStepKind;
  /** Packages held at their bad-ref version in this state (every other changed package is at its good-ref version). */
  updated: string[];
  /** `pass`: install and command succeeded. `fail`: either failed. `unresolved`: the state could not be built as intended. */
  outcome: "pass" | "fail" | "unresolved";
  /** Which stage ended the step. */
  phase: "install" | "pins" | "command";
  install?: BisectCommandRecord;
  run?: BisectCommandRecord;
  /** End of the output of the stage that ended the step; secrets removed, paths shortened. */
  outputTail: string;
  note?: string;
}

export interface BisectRemedy {
  /** What to pin and to which version: the good-ref version of each culprit. */
  pins: Array<{ packageName: string; version: string; strategy: "version-bump" | "override" }>;
  /** The run holding the plan; apply it with `autoremediator runs apply <runId>`. */
  runId?: string;
  planId?: string;
  nextCommands: string[];
  /** Pins that could not be planned, with why (for example the working tree does not hold the bad version). */
  notPlanned: Array<{ packageName: string; reason: string }>;
  /** Present with `apply`: what happened. */
  applied?: {
    status: string;
    /** True when the lockfile afterwards holds the good version of every pinned culprit. */
    effective: boolean;
    items: ItemOutcome[];
    note: string;
  };
}

export type BisectStatus =
  | "culprit"
  | "culprit-set"
  | "not-reproducible"
  | "not-attributable"
  | "no-changes"
  | "incomplete";

export interface BisectReport {
  schemaVersion: "1";
  status: BisectStatus;
  summary: string;
  good: { ref: string; commit: string };
  bad: { ref: string; commit: string };
  packageManager: PackageManager;
  /** Lockfile compared, relative to the project directory. */
  lockfile: string;
  command: string;
  /** Packages whose version changed and that were tried one by one. */
  updates: BisectedPackage[];
  /** Lockfile changes that were not tried one by one (added, removed, several versions). */
  skipped: BisectSkippedChange[];
  /** The packages whose bad-ref versions make the command fail: one, or a set that fails only together. */
  culprits: BisectedPackage[];
  /**
   * True when every update except the culprits' is applied and the command passes: holding the
   * culprits back is enough. False means something else breaks the command too. Absent when not checked.
   */
  holdingBackFixes?: boolean;
  steps: BisectStep[];
  /** Candidate states evaluated, not counting the good and bad refs. */
  stepsUsed: number;
  maxSteps: number;
  stopped?: "max-steps" | "interrupted";
  remedy?: BisectRemedy;
  warnings: string[];
  startedAt: string;
  durationMs: number;
}
