import { planRemediation, type RunReport } from "autoremediator";

import type { ModeContext } from "./types.ts";

export interface PlannedTask {
  runId: string;
  /** `unresolvedReason` of each planned result. */
  reasons: string[];
  /** One line per planned item and per finding the plan cannot act on. */
  notes: string[];
}

/**
 * The plan every mode starts from: offline intelligence from the task's snapshot, the project's own
 * type check and tests as validation, dependencies from the local registry (via the project's
 * `.npmrc`). Nothing in the project changes.
 */
export async function planTask(context: ModeContext): Promise<PlannedTask> {
  const { task, project } = context;
  const report = await planRemediation(task.advisory, {
    cwd: project.dir,
    packageManager: "npm",
    offlineIntelligence: true,
    intelligenceSnapshotPath: task.intelPath,
    runTests: true,
    typecheck: true,
  });
  if (!report.runId)
    throw new Error(`planRemediation recorded no run for ${task.id}: ${report.summary}`);

  const reasons = report.results.flatMap((result) =>
    result.unresolvedReason ? [result.unresolvedReason] : [],
  );
  const notes = report.results.map(
    (result) =>
      `plan: ${result.packageName} ${result.strategy}${result.toVersion ? ` -> ${result.toVersion}` : ""}${result.unresolvedReason ? ` (${result.unresolvedReason})` : ""}`,
  );
  if (report.results.length === 0) notes.push(`plan: ${report.summary}`);
  return { runId: report.runId, reasons, notes };
}

/** What a run reports about applying: whether it claims a fix, and the reasons it gives when not. */
export function describeRun(run: RunReport): {
  claimed: boolean;
  reasons: string[];
  notes: string[];
} {
  return {
    claimed: run.items.some((item) => item.status === "applied"),
    reasons: run.items.flatMap((item) => (item.unresolvedReason ? [item.unresolvedReason] : [])),
    notes: [
      `apply: ${run.message}`,
      ...run.items
        .filter((item) => item.status === "failed")
        .map((item) => `apply: ${item.packageName} not applied: ${item.message.slice(0, 240)}`),
    ],
  };
}
