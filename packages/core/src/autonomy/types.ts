import type { AutonomyLevel, AutonomyPolicy } from "../platform/option-schemas.js";

export type { AutonomyLevel, AutonomyPolicy };

/** What happened, as the track record keeps it. */
export const TRACK_EVENT_TYPES = [
  /** An item was applied and the verifier accepted it. Counts as a verified run. */
  "applied-verified",
  /** An item was applied with verification turned off. Evidence of nothing; shown, never counted. */
  "applied-unverified",
  /** An item could not be applied (nothing was left in the project). */
  "apply-failed",
  /** The verifier rejected a change that had been applied (or judged an applied run bad later). */
  "verifier-failure",
  /** A run that had changed the project was rolled back. */
  "rollback",
  /** `verifyRun` passed on an applied run. Supporting evidence (tests, type check) for that run. */
  "verify-passed",
] as const;
export type TrackEventType = (typeof TRACK_EVENT_TYPES)[number];

/** Events that count as outcomes in the recent window. */
export const OUTCOME_EVENT_TYPES: readonly TrackEventType[] = [
  "applied-verified",
  "applied-unverified",
  "apply-failed",
  "verifier-failure",
  "rollback",
];

export interface TrackEvent {
  /** 1-based position in the record; assigned when the event is appended. */
  seq: number;
  at: string;
  type: TrackEventType;
  runId: string;
  itemId?: string;
  cveIds: string[];
  packages: string[];
  /** Whether the project's own tests / type check were part of what verified this change. */
  coverage: { tests: boolean; typecheck: boolean };
  /** One short line (no command output, no secrets). */
  detail: string;
  /**
   * SHA-256 of the previous event's canonical JSON (all zeros for the first), so an edit, a removal
   * or a reordering breaks the chain. Absent only in a record written before hashes existed, which is
   * chained on its next append. Assigned when the event is appended.
   */
  prev?: string;
}

export type NewTrackEvent = Omit<TrackEvent, "seq" | "at" | "prev"> & { at?: string };

export interface TrackRecord {
  schemaVersion: 1;
  events: TrackEvent[];
  /** SHA-256 of the last event's canonical JSON: vouches for the final event, which no later one does. */
  head?: string;
}

/** The policy's `autonomy` key with every default filled in. */
export interface AutonomyConfig {
  ceiling: AutonomyLevel;
  minVerifiedRuns: number;
  window: number;
  minSuccessRate: number;
  cooldownDays: number;
  requireTestCoverage: boolean;
}

export const AUTONOMY_DEFAULTS = {
  minVerifiedRuns: 5,
  window: 20,
  minSuccessRate: 0.9,
  cooldownDays: 7,
  requireTestCoverage: true,
} as const;

export function resolveAutonomyConfig(policy: AutonomyPolicy): AutonomyConfig {
  return {
    ceiling: policy.ceiling,
    minVerifiedRuns: policy.minVerifiedRuns ?? AUTONOMY_DEFAULTS.minVerifiedRuns,
    window: policy.window ?? AUTONOMY_DEFAULTS.window,
    minSuccessRate: policy.minSuccessRate ?? AUTONOMY_DEFAULTS.minSuccessRate,
    cooldownDays: policy.cooldownDays ?? AUTONOMY_DEFAULTS.cooldownDays,
    requireTestCoverage: policy.requireTestCoverage ?? AUTONOMY_DEFAULTS.requireTestCoverage,
  };
}

export const LEVEL_NAMES: Record<AutonomyLevel, string> = {
  L0: "observe",
  L1: "suggest",
  L2: "open pull request",
  L3: "auto-merge eligible",
  L4: "autonomous with escalation",
};

/** What a level permits. Auto-merge itself is never performed; L3 and L4 only raise a signal. */
export const LEVEL_ALLOWS: Record<AutonomyLevel, { plan: boolean; apply: boolean }> = {
  L0: { plan: false, apply: false },
  L1: { plan: true, apply: false },
  L2: { plan: true, apply: true },
  L3: { plan: true, apply: true },
  L4: { plan: true, apply: true },
};

export const levelIndex = (level: AutonomyLevel): number => Number(level.slice(1));
export const minLevel = (a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel =>
  levelIndex(a) <= levelIndex(b) ? a : b;
export const levelOf = (index: number): AutonomyLevel => `L${index}` as AutonomyLevel;
