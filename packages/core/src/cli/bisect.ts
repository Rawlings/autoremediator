import { bisectLockfile, EXIT_CODES, type BisectReport } from "../api/index.js";
import { logJson } from "./output.js";
import type { OutputFormat } from "./types.js";

export interface BisectCliOptions {
  cwd: string;
  good: string;
  bad?: string;
  command: string;
  timeout?: number;
  maxSteps?: number;
  packageManager?: string;
  ignoreScripts?: boolean;
  apply?: boolean;
  outputFormat: OutputFormat;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function describeStep(step: BisectReport["steps"][number], report: BisectReport): string {
  const names = step.updated.slice(0, 4).join(", ") + (step.updated.length > 4 ? ", ..." : "");
  let subject: string;
  switch (step.kind) {
    case "good-ref": {
      subject = "good ref";
      break;
    }
    case "bad-ref": {
      subject = "bad ref";
      break;
    }
    case "all-updates": {
      subject = `good ref + all ${step.updated.length} updates`;
      break;
    }
    case "without-culprit": {
      subject = `good ref + every update except ${report.culprits.length === 1 ? "the culprit" : "the culprits"}`;
      break;
    }
    case "subset": {
      subject = `good ref + ${step.updated.length} update(s): ${names}`;
      break;
    }
  }
  const detail = step.run
    ? `exit ${step.run.exitCode ?? "killed"}${step.run.timedOut ? ", timed out" : ""}, ${seconds(step.run.durationMs)}`
    : step.phase;
  const note = step.note ? `\n      ${step.note}` : "";
  return `  ${String(step.step).padStart(2)}. ${step.outcome.padEnd(10)} ${subject}  [${detail}]${note}`;
}

/** The report as a person reads it: what was tried, what it showed, what to do next. */
export function describeBisect(report: BisectReport): string {
  const untestable = report.skipped.length > 0 ? `, ${report.skipped.length} not testable one by one` : "";
  const lines = [
    `Lockfile bisect ${report.good.commit.slice(0, 12)}..${report.bad.commit.slice(0, 12)}  (${report.packageManager}, ${report.updates.length} changed package version(s)${untestable})`,
    `Command: ${report.command}`,
    "",
    ...report.steps.map((step) => describeStep(step, report)),
    "",
    report.summary,
  ];

  const failing = report.steps.find((step) => step.kind === "bad-ref" && step.outcome === "fail");
  if (failing?.outputTail && report.status !== "not-reproducible") {
    lines.push("", "Output of the failing run:", ...failing.outputTail.split("\n").map((line) => `  | ${line}`));
  }
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  if (report.stopped === "max-steps") lines.push(`Stopped at ${report.maxSteps} steps; raise --max-steps to narrow it further.`);

  const remedy = report.remedy;
  if (remedy) {
    for (const pin of remedy.pins) lines.push(`Pin back: ${pin.packageName}@${pin.version} (${pin.strategy})`);
    for (const skipped of remedy.notPlanned) lines.push(`Not planned: ${skipped.packageName}: ${skipped.reason}`);
    if (remedy.applied) {
      lines.push(`Applied through run ${remedy.runId}: ${remedy.applied.status}. ${remedy.applied.note}`);
    } else if (remedy.runId) {
      lines.push(
        `Plan ${remedy.planId} recorded as run ${remedy.runId}; nothing was changed.`,
        `  Review: ${remedy.nextCommands[0]}`,
        `  Apply:  ${remedy.nextCommands[1]}`,
      );
    }
  }
  return lines.join("\n");
}

/** Exit codes: 0 culprit found, 1 nothing found, 130 interrupted. */
export async function runBisect(opts: BisectCliOptions): Promise<void> {
  const controller = new AbortController();
  // The first Ctrl-C stops the search and lets it remove its checkouts; a second one gives up waiting
  // (exiting still removes the checkouts, synchronously).
  const interrupt = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const report = await bisectLockfile({
      cwd: opts.cwd,
      good: opts.good,
      command: opts.command,
      ...(opts.bad ? { bad: opts.bad } : {}),
      ...(opts.timeout === undefined ? {} : { timeoutSeconds: opts.timeout }),
      ...(opts.maxSteps === undefined ? {} : { maxSteps: opts.maxSteps }),
      ...(opts.packageManager ? { packageManager: opts.packageManager as "npm" | "pnpm" | "yarn" } : {}),
      ...(opts.ignoreScripts ? { ignoreScripts: true } : {}),
      ...(opts.apply ? { apply: true } : {}),
      signal: controller.signal,
    });
    if (opts.outputFormat === "json") logJson(report);
    else process.stdout.write(`${describeBisect(report)}\n`);
    const found = report.status === "culprit" || report.status === "culprit-set";
    process.exitCode = report.stopped === "interrupted" ? 130 : found ? EXIT_CODES.ok : EXIT_CODES.failed;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
