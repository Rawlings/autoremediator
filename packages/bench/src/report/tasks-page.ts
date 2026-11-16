/** `results/tasks.md`: every task, what it checks and what the correct outcome is. */
import { DIMENSIONS, type LoadedTask } from "../task.ts";
import { code, table } from "./format.ts";

const ADVISORY_URL = "https://github.com/advisories/";

function advisoryCell(task: LoadedTask): string {
  return task.osv ? `[${task.advisory}](${ADVISORY_URL}${task.osv})` : task.advisory;
}

function outcomeCell(task: LoadedTask): string {
  const { outcome, reason } = task.expect;
  return reason ? `${outcome} (${reason})` : outcome;
}

function summaryTable(tasks: readonly LoadedTask[]): string {
  return table(
    ["Task", "Kind", "Package", "Advisory", "Vulnerable", "First fixed", "Correct outcome"],
    tasks.map((task) => [
      `[${task.id}](#${task.id})`,
      DIMENSIONS[task.dimension],
      code(task.vulnerable.packageName),
      advisoryCell(task),
      code(task.vulnerable.vulnerableRange),
      task.firstPatchedVersion ? code(task.firstPatchedVersion) : "none",
      outcomeCell(task),
    ]),
  );
}

function detail(task: LoadedTask): string {
  const lines = [`### ${task.id}`, "", `**${task.title}.** ${task.description}`];
  if (task.baselineBefore) {
    lines.push("", `The project's lockfile is resolved as of ${task.baselineBefore}.`);
  }
  if (task.expect.sourceEdits.length > 0) {
    lines.push("", `A correct fix may edit: ${task.expect.sourceEdits.map(code).join(", ")}.`);
  }
  return lines.join("\n");
}

export function renderTasksPage(tasks: readonly LoadedTask[]): string {
  const scored = tasks.filter((task) => !task.control);
  const corpus = scored.filter((task) => task.origin === "corpus");
  const harness = scored.filter((task) => task.origin === "harness");
  const controls = tasks.filter((task) => task.control);
  const parts = [
    "# Task catalogue",
    "",
    "Every task in the benchmark. [Back to the overview](../RESULTS.md).",
    "",
    "## Corpus tasks",
    "",
    "Built from a published npm release and the published advisory for it. Advisory records are stored as",
    "OSV publishes them and the packages are served with the registry's own integrity hashes.",
    "",
    corpus.length > 0 ? summaryTable(corpus) : "None yet.",
    "",
    ...corpus.flatMap((task) => [detail(task), ""]),
    "## Harness tasks",
    "",
    "Purpose-built fixtures for cases that cannot come from published data. Their advisories are",
    "invented (`CVE-2099-*`) and their packages exist only in the benchmark.",
    "",
    summaryTable(harness),
    "",
    ...harness.flatMap((task) => [detail(task), ""]),
    "## Controls",
    "",
    "Deliberately wrong runs. A control passes the benchmark by being scored as a failure.",
    "",
    ...controls.flatMap((task) => [
      `### ${task.id}`,
      "",
      `**${task.title}.** ${task.description}`,
      "",
    ]),
  ];
  return `${parts.join("\n").trimEnd()}\n`;
}
