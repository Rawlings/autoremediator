import { type AutonomyStatus, type AutonomySummary, getAutonomy } from "../../../api/index.js";
import { logJson } from "../output.js";
import type { OutputFormat } from "../types.js";

export interface AutonomyCliOptions {
  cwd: string;
  outputFormat: OutputFormat;
  policy?: string;
}

/** The line reports print about the level their project was at. */
export function formatAutonomyLine(summary: AutonomySummary): string {
  const flags = [
    summary.autoMergeEligible ? "auto-merge eligible" : "",
    summary.escalate ? "escalate to a person" : "",
  ].filter(Boolean);
  return `Autonomy: ${summary.level} (${summary.name}); ceiling ${summary.ceiling}, earned ${summary.earned}${
    flags.length > 0 ? `; ${flags.join(", ")}` : ""
  }. ${summary.note}`;
}

const percent = (value: number | null): string =>
  value === null ? "no runs yet" : `${Math.round(value * 1000) / 10}%`;

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

function printStatus(status: AutonomyStatus): void {
  if (!status.configured) {
    out(status.message);
    return;
  }
  const evidence = status.evidence!;
  out(
    `Autonomy ${status.level} (${status.levelName}); ceiling ${status.ceiling}, earned ${status.earned}`,
  );
  out(
    `Allows: planning ${status.allows!.plan ? "yes" : "no"}, applying changes ${status.allows!.apply ? "yes" : "no"}`,
  );
  out(`Record: ${status.recordPath} (${evidence.events} event(s))`);
  if (status.recordError) out(`Problem: ${status.recordError}`);
  out(
    `Recent: ${evidence.outcomes} outcome(s) over ${evidence.runs} run(s); verified ${evidence.verifiedRuns} ` +
      `(tests passed in ${evidence.testsCoveredRuns}, type check in ${evidence.typecheckCoveredRuns}); ` +
      `failed ${evidence.failedRuns}; rollbacks or verifier failures ${evidence.incidentRuns}; success rate ${percent(evidence.successRate)}`,
  );
  if (status.cap) out(`Cap: ${status.cap.reason}`);
  const next = status.nextPromotion;
  if (next) {
    if (next.blockedByCeiling)
      out(
        `Next: ${next.to} is above the policy ceiling ${status.ceiling}; raise the ceiling in the policy file to allow it`,
      );
    else if (next.requirements.length === 0)
      out(
        `Next: ${next.to} once the cooldown ends${next.cappedUntil ? ` (${next.cappedUntil})` : ""}`,
      );
    else {
      out(`Next: ${next.to} needs`);
      for (const requirement of next.requirements) {
        out(
          `  ${requirement.met ? "met  " : "unmet"}  ${requirement.name}: ${requirement.required} (now ${requirement.actual})`,
        );
      }
    }
  }
}

function printExplain(status: AutonomyStatus): void {
  printStatus(status);
  if (!status.configured) return;
  out();
  out("Why this level");
  for (const reason of status.reasons ?? []) out(`  - ${reason}`);
  const settings = status.settings!;
  out();
  out("Settings (policy file `autonomy`)");
  out(
    `  ceiling ${settings.ceiling}; minVerifiedRuns ${settings.minVerifiedRuns}; window ${settings.window}; ` +
      `minSuccessRate ${settings.minSuccessRate}; cooldownDays ${settings.cooldownDays}; requireTestCoverage ${settings.requireTestCoverage}`,
  );
  out();
  const history = status.history ?? [];
  out(history.length === 0 ? "History: no promotions or demotions yet" : "History");
  for (const change of history) {
    const cause = change.eventSeq === undefined ? "cooldown" : `event #${change.eventSeq}`;
    out(`  ${change.at}  ${change.direction} ${change.from} -> ${change.to}  (${cause})`);
    out(`      ${change.reason}`);
    if (change.runIds.length > 0) out(`      runs: ${change.runIds.join(", ")}`);
  }
}

export async function runAutonomy(
  mode: "status" | "explain",
  opts: AutonomyCliOptions,
): Promise<void> {
  const status = getAutonomy({ cwd: opts.cwd, ...(opts.policy ? { policy: opts.policy } : {}) });
  if (opts.outputFormat === "json") {
    logJson(status);
    return;
  }
  if (mode === "status") printStatus(status);
  else printExplain(status);
}
