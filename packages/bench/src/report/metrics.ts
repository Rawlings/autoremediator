/**
 * The numbers the results pages quote. Every one is computed here from the rows of a results file
 * and from nothing else, so a figure on a page can always be traced to rows in `results/*.json`.
 */
import type { ResultFile, TaskResult } from "../results.ts";
import { median } from "./format.ts";

export interface Slice {
  tasks: number;
  correct: number;
  /** Tasks whose correct outcome is a fix. */
  fixExpected: number;
  fixCorrect: number;
  /** Tasks whose correct outcome is to leave the project alone (no safe fix, or refused). */
  holdExpected: number;
  holdCorrect: number;
  /** A fix was reported that the oracle does not accept. */
  falseClaims: number;
  /** The project was changed and is not fixed. */
  leftBroken: number;
  /** Fixes that were expected but could not be made without editing the project's own code: left untouched. */
  needsRepair: number;
  /** Median files changed by a correct fix. */
  medianFixFiles: number | undefined;
  medianMs: number | undefined;
  totalMs: number;
}

export type Origin = TaskResult["origin"];

/** The scored (non-control) rows of a result file, optionally of one origin. */
export function scoredRows(result: ResultFile, origin?: Origin): TaskResult[] {
  return result.tasks.filter(
    (task) => !task.control && (origin === undefined || task.origin === origin),
  );
}

const correct = (list: readonly TaskResult[]): number =>
  list.filter((task) => task.score === "PASS").length;

export function sliceOf(rows: readonly TaskResult[]): Slice {
  const fix = rows.filter((task) => task.expected === "fixed");
  const hold = rows.filter((task) => task.expected !== "fixed");
  return {
    tasks: rows.length,
    correct: correct(rows),
    fixExpected: fix.length,
    fixCorrect: correct(fix),
    holdExpected: hold.length,
    holdCorrect: correct(hold),
    falseClaims: rows.filter((task) => task.outcome === "false-claim").length,
    needsRepair: fix.filter((task) => task.score === "FAIL" && task.outcome === "unresolved")
      .length,
    leftBroken: rows.filter((task) => task.outcome === "broken" || task.outcome === "false-claim")
      .length,
    medianFixFiles: median(
      fix.filter((task) => task.score === "PASS").map((task) => task.changedFiles),
    ),
    medianMs: median(rows.map((task) => task.durationMs)),
    totalMs: rows.reduce((sum, task) => sum + task.durationMs, 0),
  };
}

/** What happened to the tasks of a slice that did not end correctly, in words. */
export function shortfalls(rows: readonly TaskResult[]): string {
  const missed = rows.filter((task) => task.score === "FAIL");
  if (missed.length === 0) return "";
  const untouched = missed.filter(
    (task) => task.outcome === "unresolved" || task.outcome === "refused",
  );
  const parts: string[] = [];
  if (untouched.length > 0) parts.push(`${untouched.length} left untouched and reported`);
  const other = missed.length - untouched.length;
  if (other > 0) parts.push(`${other} left changed but not fixed`);
  return parts.join("; ");
}
