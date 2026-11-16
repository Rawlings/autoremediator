/** `results/<mode>.md`: one page per mode with every task's row. */
import { MODE_DESCRIPTIONS, MODE_ROLES } from "../mode-info.ts";
import type { TaskResult } from "../results.ts";
import { DIMENSIONS } from "../task.ts";
import { code, seconds, table } from "./format.ts";
import type { LoadedResult } from "./load.ts";
import { scoredRows, sliceOf } from "./metrics.ts";

function detail(task: TaskResult): string {
  if (task.error) return `error: ${task.error.split("\n")[0]?.slice(0, 120) ?? ""}`;
  const failed = task.checks.filter((check) => !check.ok).map((check) => check.name);
  if (task.agentClaimedSuccess && !task.pipelineClaimedSuccess && task.score === "FAIL") {
    return `agent claimed success, the verifier refused it; failed: ${failed.join(", ") || task.outcome}`;
  }
  if (task.control) return failed.length > 0 ? `failed: ${failed.join(", ")}` : "no check failed";
  return task.score === "FAIL" ? `failed: ${failed.join(", ") || task.outcome}` : "";
}

function cells(task: TaskResult): string[] {
  const caught = task.controlCaught ? "caught" : "NOT CAUGHT";
  return [
    `[${task.id}](tasks.md#${task.id})`,
    DIMENSIONS[task.dimension],
    task.expected,
    task.control ? `${task.score} (${caught})` : task.score,
    task.outcome,
    String(task.changedFiles),
    seconds(task.durationMs),
    String(task.steps),
    detail(task),
  ];
}

const HEADERS = [
  "Task",
  "Kind",
  "Expected",
  "Result",
  "Outcome",
  "Files changed",
  "Time",
  "Steps",
  "Detail",
];

export function renderModePage({ result }: LoadedResult): string {
  const { summary } = result;
  const corpus = result.tasks.filter((task) => !task.control && task.origin === "corpus");
  const harness = result.tasks.filter((task) => !task.control && task.origin === "harness");
  const controls = result.tasks.filter((task) => task.control);
  const tokens = result.tasks.flatMap((task) => (task.tokens ? [task.tokens] : []));
  const slice = sliceOf(scoredRows(result));
  const sections: string[] = [
    `# ${result.mode}`,
    "",
    `**${MODE_ROLES[result.mode]}.** ${MODE_DESCRIPTIONS[result.mode]}`,
    "",
    `Run on ${result.date} from commit ${result.commit}${result.dirty ? " (working tree had uncommitted changes)" : ""}; autoremediator ${result.autoremediatorVersion}; node ${result.node} on ${result.platform}.${result.model ? ` Model: ${result.model}.` : ""} Data: ${code(`${result.mode}.json`)}. [Back to the overview](../RESULTS.md).`,
    "",
    `**${summary.pass}/${summary.tasks} correct** (fixed ${summary.byExpected.fixed.pass}/${summary.byExpected.fixed.total}, unresolved ${summary.byExpected.unresolved.pass}/${summary.byExpected.unresolved.total}, refused ${summary.byExpected.refused.pass}/${summary.byExpected.refused.total}); false claims of success ${summary.falseClaims}; projects left broken ${slice.leftBroken}; controls caught ${summary.controls.caught}/${summary.controls.total}; total time ${seconds(summary.totalDurationMs)}${tokens.length > 0 ? `; tokens ${tokens.reduce((sum, t) => sum + t.input, 0)} in / ${tokens.reduce((sum, t) => sum + t.output, 0)} out` : ""}.`,
  ];
  if (corpus.length > 0) {
    sections.push(
      "",
      "## Corpus tasks",
      "",
      "Published npm releases and published advisories.",
      "",
      table(
        HEADERS,
        corpus.map((task) => cells(task)),
      ),
    );
  }
  if (harness.length > 0) {
    sections.push(
      "",
      "## Harness tasks",
      "",
      "Purpose-built fixtures for cases that cannot come from published data.",
      "",
      table(
        HEADERS,
        harness.map((task) => cells(task)),
      ),
    );
  }
  if (controls.length > 0) {
    sections.push(
      "",
      "## Controls",
      "",
      "Deliberately wrong runs that the benchmark must score as failures.",
      "",
      table(
        HEADERS,
        controls.map((task) => cells(task)),
      ),
    );
  }
  return `${sections.join("\n")}\n`;
}
