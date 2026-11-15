/**
 * Earned autonomy at the SDK surface: read the level a repository is at, gate the operations that
 * change a project on it, mark reports with it, and record outcomes into its track record.
 *
 * The feature is opt-in. Without an `autonomy` key in the policy file none of this does anything:
 * nothing is refused, nothing is recorded, and reports carry no autonomy field.
 */
import {
  evaluate,
  effectiveLevel,
  nextPromotion,
  signalsFor,
  transitionsOf,
} from "../../autonomy/compute.js";
import type {
  CapInfo,
  NextPromotion,
  OutcomeFacts,
  Transition,
  WindowStats,
} from "../../autonomy/compute.js";
import {
  appendTrackEvents,
  readTrackRecord,
  recordPathOf,
  TRACK_RECORD_PATH,
  TrackRecordError,
} from "../../autonomy/record.js";
import {
  type AutonomyConfig,
  type AutonomyLevel,
  LEVEL_ALLOWS,
  LEVEL_NAMES,
  minLevel,
  type NewTrackEvent,
  resolveAutonomyConfig,
  type TrackEvent,
} from "../../autonomy/types.js";
import { loadPolicy } from "../../platform/policy.js";
import type { AutonomySummary } from "../../platform/types.js";

export type {
  AutonomyConfig,
  AutonomyLevel,
  AutonomySummary,
  NewTrackEvent,
  TrackEvent,
  Transition,
  WindowStats,
};
export { LEVEL_NAMES, TRACK_RECORD_PATH };

export interface GetAutonomyOptions {
  /** Project directory (default: process.cwd()). */
  cwd?: string;
  /** Policy file path or inline policy (default: `.github/autoremediator.yml`). */
  policy?: string;
}

export interface AutonomyStatus {
  /** The policy has an `autonomy` key. When false, behaviour is unchanged and nothing is recorded. */
  configured: boolean;
  message: string;
  cwd: string;
  recordPath: string;
  /** The record exists but cannot be read; the level is then L0 until a person fixes it. */
  recordError?: string;
  level?: AutonomyLevel;
  levelName?: string;
  ceiling?: AutonomyLevel;
  earned?: AutonomyLevel;
  allows?: { plan: boolean; apply: boolean };
  settings?: AutonomyConfig;
  /** Counts over the recent window, and the size of the whole record. */
  evidence?: WindowStats & {
    events: number;
    lastEvent?: Pick<TrackEvent, "seq" | "at" | "type" | "runId">;
  };
  reasons?: string[];
  cap?: CapInfo;
  /** Every promotion and demotion, each citing the event or cooldown behind it. */
  history?: Transition[];
  nextPromotion?: NextPromotion;
}

/** Thrown when the level in force does not permit the operation. Nothing was changed. */
export class AutonomyRefusedError extends Error {
  readonly level: AutonomyLevel;
  constructor(message: string, level: AutonomyLevel) {
    super(message);
    this.name = "AutonomyRefusedError";
    this.level = level;
  }
}

interface State {
  config: AutonomyConfig;
  events: TrackEvent[];
  recordError?: string;
}

/** The autonomy settings from the policy and the record they apply to; undefined when not opted in. */
function stateOf(cwd: string, policy: string | undefined): State | undefined {
  const autonomy = loadPolicy(cwd, policy).autonomy;
  if (!autonomy) return undefined;
  const config = resolveAutonomyConfig(autonomy);
  try {
    return { config, events: readTrackRecord(cwd).events };
  } catch (error) {
    if (error instanceof TrackRecordError)
      return { config, events: [], recordError: error.message };
    throw error;
  }
}

function levelOfState(state: State, now: Date) {
  const evaluation = evaluate(state.events, state.config, now);
  // A record that cannot be read gives no evidence, so nothing beyond observing is allowed.
  const level: AutonomyLevel = state.recordError ? "L0" : effectiveLevel(evaluation, state.config);
  return { evaluation, level };
}

export function getAutonomy(
  options: GetAutonomyOptions = {},
  now: Date = new Date(),
): AutonomyStatus {
  const cwd = options.cwd ?? process.cwd();
  const base = { cwd, recordPath: recordPathOf(cwd) };
  const state = stateOf(cwd, options.policy);
  if (!state) {
    return {
      configured: false,
      message:
        "No `autonomy` key in the policy file, so earned autonomy is off: nothing is gated or recorded. Add `autonomy: { ceiling: L2 }` to enable it.",
      ...base,
    };
  }

  const { evaluation, level } = levelOfState(state, now);
  const last = state.events.at(-1);
  const promotion = nextPromotion(evaluation, state.config);
  const reasons = state.recordError
    ? [
        `${state.recordError} Fix or restore the file; until then the level is L0.`,
        ...evaluation.reasons,
      ]
    : evaluation.reasons;
  const ceilingNote =
    !state.recordError && level !== evaluation.earned
      ? [
          `The policy ceiling ${state.config.ceiling} holds the level below the earned ${evaluation.earned}`,
        ]
      : [];

  return {
    configured: true,
    message: `Autonomy ${level} (${LEVEL_NAMES[level]}); ceiling ${state.config.ceiling}, earned ${evaluation.earned}.`,
    ...base,
    ...(state.recordError ? { recordError: state.recordError } : {}),
    level,
    levelName: LEVEL_NAMES[level],
    ceiling: state.config.ceiling,
    earned: state.recordError ? "L0" : evaluation.earned,
    allows: LEVEL_ALLOWS[level],
    settings: state.config,
    evidence: {
      ...evaluation.stats,
      events: state.events.length,
      ...(last
        ? { lastEvent: { seq: last.seq, at: last.at, type: last.type, runId: last.runId } }
        : {}),
    },
    reasons: [...ceilingNote, ...reasons],
    ...(evaluation.cap ? { cap: evaluation.cap } : {}),
    history: transitionsOf(state.events, state.config, now),
    ...(promotion ? { nextPromotion: promotion } : {}),
  };
}

/**
 * Refuse an operation the level in force does not permit. A no-op when autonomy is not configured.
 * Call before anything is changed.
 */
export function assertAutonomyAllows(
  cwd: string,
  policy: string | undefined,
  action: "apply" | "plan",
  what: string,
  now: Date = new Date(),
): void {
  const state = stateOf(cwd, policy);
  if (!state) return;
  const { evaluation, level } = levelOfState(state, now);
  if (LEVEL_ALLOWS[level][action]) return;

  const why = state.recordError
    ? state.recordError
    : level === state.config.ceiling && level !== evaluation.earned
      ? `the policy ceiling is ${state.config.ceiling}`
      : (evaluation.reasons[0] ?? "see the track record");
  throw new AutonomyRefusedError(
    `${what} refused: autonomy is ${level} (${LEVEL_NAMES[level]}), which does not allow ${action === "apply" ? "changing the project" : "recording plans"}. ` +
      `Ceiling ${state.config.ceiling}, earned ${evaluation.earned}: ${why}. ` +
      `Nothing was changed. Run \`autoremediator autonomy explain\` for the evidence.`,
    level,
  );
}

/** The level and its signals for a report; undefined when autonomy is not configured. */
export function summarizeAutonomy(
  cwd: string,
  policy: string | undefined,
  facts?: OutcomeFacts,
  now: Date = new Date(),
  /** The level the result was produced under, when it differs from the level now (a run can promote itself). */
  producedAt?: AutonomyLevel,
): AutonomySummary | undefined {
  const state = stateOf(cwd, policy);
  if (!state) return undefined;
  const { evaluation, level } = levelOfState(state, now);
  const signalLevel = producedAt ? minLevel(producedAt, level) : level;
  const base = facts
    ? signalsFor(signalLevel, facts)
    : { autoMergeEligible: false, escalate: false, note: `${level} (${LEVEL_NAMES[level]})` };
  const signals =
    signalLevel === level
      ? base
      : {
          ...base,
          note: `${base.note}; this run raised the level to ${level}, which applies from the next run`,
        };
  return {
    level,
    ceiling: state.config.ceiling,
    earned: state.recordError ? "L0" : evaluation.earned,
    name: LEVEL_NAMES[level],
    autoMergeEligible: signals.autoMergeEligible,
    escalate: signals.escalate,
    note: signals.note,
  };
}

/**
 * Add outcomes to the track record, when autonomy is configured. Best effort by design: a record
 * that cannot be written must never fail or undo the run that produced the outcome, so the problem
 * is returned for the caller to log and nothing is thrown.
 */
export async function recordAutonomyEvents(
  cwd: string,
  policy: string | undefined,
  events: readonly NewTrackEvent[],
): Promise<{ recorded: number; problem?: string }> {
  if (events.length === 0) return { recorded: 0 };
  try {
    if (!loadPolicy(cwd, policy).autonomy) return { recorded: 0 };
    const added = await appendTrackEvents(cwd, events);
    return { recorded: added.length };
  } catch (error) {
    return { recorded: 0, problem: error instanceof Error ? error.message : String(error) };
  }
}
