/**
 * `RESULTS.md`: the page a reader sees first. It leads with what was measured, says plainly where
 * the pipeline stops, and ends with what the numbers do not show. Every figure comes from
 * `metrics.ts`, which reads only the results files.
 */
import { MODE_ROLES } from "../mode-info.ts";
import type { ResultFile, TaskResult } from "../results.ts";
import { DIMENSIONS, DIMENSION_IDS } from "../task.ts";
import { code, fraction, plural, seconds, table } from "./format.ts";
import type { LoadedResult } from "./load.ts";
import { scoredRows, shortfalls, sliceOf } from "./metrics.ts";
import type { ReportInput } from "./types.ts";

const DOCS = "../../docs/contributing/benchmark.md";

/** The result the headline numbers come from: the pipeline with no model. */
export function headlineOf(results: readonly LoadedResult[]): ResultFile | undefined {
  return results.find((entry) => entry.result.mode === "deterministic")?.result;
}

export function scopeOf(result: ResultFile): { rows: TaskResult[]; text: string } {
  const corpus = scoredRows(result, "corpus");
  if (corpus.length > 0) {
    return {
      rows: corpus,
      text: `${plural(corpus.length, "task")} built from published npm packages and their published advisories`,
    };
  }
  const all = scoredRows(result);
  return { rows: all, text: plural(all.length, "task") };
}

/** One sentence that says what the numbers add up to. */
export function headlineSentence(result: ResultFile): string {
  const slice = sliceOf(scopeOf(result).rows);
  const claims =
    slice.falseClaims === 0 && slice.leftBroken === 0
      ? "without a false claim of success or a broken project"
      : `with ${plural(slice.falseClaims, "false claim")} of success and ${plural(slice.leftBroken, "broken project")}`;
  const lead = `With no model, Autoremediator fixed ${slice.fixCorrect} of ${slice.fixExpected} vulnerable dependencies and correctly declined ${slice.holdCorrect} of ${slice.holdExpected} that could not be fixed safely, ${claims}.`;
  if (slice.needsRepair === 0) return `**${lead}**`;
  const one = slice.needsRepair === 1;
  const rest = `${one ? "The one it" : `The ${slice.needsRepair} it`} could not fix ${one ? "needs" : "need"} an edit to the project's own code, so ${one ? "it was" : "they were"} rolled back untouched and reported.`;
  return `**${lead}** ${rest}`;
}

function glance(result: ResultFile): string[] {
  const { rows, text } = scopeOf(result);
  const slice = sliceOf(rows);
  const files = slice.medianFixFiles === undefined ? "n/a" : String(slice.medianFixFiles);
  return [
    "## At a glance",
    "",
    headlineSentence(result),
    "",
    `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}, run with no model:`,
    "",
    table(
      ["Measure", "Result"],
      [
        ["Correct outcomes", `**${fraction(slice.correct, slice.tasks)}**`],
        [
          "Vulnerable dependencies fixed and verified",
          `**${fraction(slice.fixCorrect, slice.fixExpected)}**`,
        ],
        [
          "Cases with no safe fix, reported honestly",
          `**${fraction(slice.holdCorrect, slice.holdExpected)}**`,
        ],
        ["Fixes claimed that were not real", `**${slice.falseClaims}**`],
        ["Projects left broken", `**${slice.leftBroken}**`],
        [
          "Upgrades that need your own code changed, rolled back and reported",
          `**${slice.needsRepair}**`,
        ],
        ["Files changed by a fix (median)", `**${files}**`],
        [
          "Time per task (median)",
          `**${slice.medianMs === undefined ? "n/a" : seconds(slice.medianMs)}**`,
        ],
      ],
    ),
    "",
    "A fix counts only if an independent oracle, which shares no code with the tool, installs the",
    "result from its lockfile and the project's own type check and tests pass. A change that fails",
    "verification is rolled back, never kept.",
  ];
}

function byKind(input: ReportInput, headline: ResultFile): string[] {
  const model = input.results.find((entry) => entry.result.mode === "agent-model")?.result;
  const headers = [
    "Kind of problem",
    "Tasks",
    "From published data",
    "Correct, no model",
    ...(model ? ["With a model"] : []),
    "Otherwise",
  ];
  const rows = DIMENSION_IDS.flatMap((dimension) => {
    const mine = scoredRows(headline).filter((task) => task.dimension === dimension);
    if (mine.length === 0) return [];
    const slice = sliceOf(mine);
    const modelCell = model
      ? [
          fraction(
            scoredRows(model).filter(
              (task) => task.dimension === dimension && task.score === "PASS",
            ).length,
            scoredRows(model).filter((task) => task.dimension === dimension).length,
          ),
        ]
      : [];
    return [
      [
        DIMENSIONS[dimension],
        String(slice.tasks),
        String(mine.filter((task) => task.origin === "corpus").length),
        fraction(slice.correct, slice.tasks),
        ...modelCell,
        shortfalls(mine) || "all correct",
      ],
    ];
  });
  return ["## By kind of problem", "", table(headers, rows)];
}

function limits(headline: ResultFile): string[] {
  const misses = scoredRows(headline).filter((task) => task.score === "FAIL");
  if (misses.length === 0) return [];
  return [
    "## Where the pipeline stops without an agent",
    "",
    "These tasks need an edit to the project's own source. With no model the pipeline rolls the upgrade",
    "back, leaves the project as it found it and reports why; it never claims a fix it did not make.",
    "With an agent attached it can attempt the repair, and the verifier decides whether the change is kept.",
    "",
    ...misses.map((task) => {
      const what =
        task.outcome === "unresolved"
          ? "rolled back, project left untouched"
          : `ended as ${task.outcome}`;
      return `- [${task.title}](results/tasks.md#${task.id}): ${what}`;
    }),
  ];
}

function allModes(results: readonly LoadedResult[]): string[] {
  const rows = results.map(({ result }) => {
    const slice = sliceOf(scoredRows(result));
    return [
      `[${result.mode}](results/${result.mode}.md)`,
      MODE_ROLES[result.mode],
      `${fraction(slice.correct, slice.tasks)}${result.mode.endsWith("-scripted") ? " †" : ""}`,
      String(slice.falseClaims),
      String(slice.leftBroken),
      fraction(result.summary.controls.caught, result.summary.controls.total),
      slice.medianMs === undefined ? "n/a" : seconds(slice.medianMs),
    ];
  });
  return [
    "## Every mode",
    "",
    table(
      [
        "Mode",
        "What it measures",
        "Correct",
        "False claims",
        "Left broken",
        "Controls caught",
        "Median time",
      ],
      rows,
    ),
    "",
    "† The run is handed the known-good answer. These modes check that the machinery lets a correct",
    "repair through and stops a wrong one; they say nothing about how well a model repairs code.",
    "Controls are deliberately wrong runs that the benchmark must score as failures.",
  ];
}

function modelSection(results: readonly LoadedResult[]): string[] {
  const model = results.find((entry) => entry.result.mode === "agent-model")?.result;
  if (model) {
    const slice = sliceOf(scoredRows(model));
    return [
      "## Model results",
      "",
      `${model.model ?? "A model"} passed ${fraction(slice.correct, slice.tasks)} tasks; see [agent-model](results/agent-model.md).`,
    ];
  }
  return [
    "## Model results",
    "",
    "No run with a real model has been recorded yet, so nothing here says how well a model repairs a",
    `breaking upgrade. The ${code("agent-model")} mode is how one is added: see [the guide](${DOCS}).`,
  ];
}

function caveats(input: ReportInput): string[] {
  const snapshot = input.snapshotDate ? ` as of ${input.snapshotDate.slice(0, 10)}` : "";
  return [
    "## What these numbers do not show",
    "",
    "- The tasks are small projects written for the benchmark. A pass shows the pipeline handles that",
    "  shape of problem, not that it handles any particular repository.",
    `- Corpus tasks use published releases and advisories, frozen with the registry${snapshot}. Harness tasks`,
    "  cover cases that cannot come from published data, such as a release published an hour ago.",
    "- The sample is small. Read the counts, not the percentages.",
  ];
}

function pages(): string[] {
  return [
    "## More",
    "",
    "- [Task catalogue](results/tasks.md): every task, its advisory, its range and its expected outcome.",
    `- [How a task is scored, and how the benchmark keeps your machine safe](${DOCS}).`,
    "- Reproduce: `pnpm build && pnpm bench:corpus restore && pnpm bench`. The restore step downloads the pinned",
    "  package tarballs from the npm registry (about 30 MB) and checks each against `corpus/lock.json`; the",
    "  benchmark then runs offline and needs no key.",
  ];
}

export function renderOverview(input: ReportInput): string {
  const headline = headlineOf(input.results);
  const intro = [
    "# Benchmark results",
    "",
    "How well does Autoremediator fix vulnerable dependencies? This page answers with measurements from",
    "the open benchmark in `packages/bench`. Every figure is generated from the run files in",
    "[`results/`](results/); a test fails if this page is edited by hand or falls behind them.",
  ];
  if (!headline) return [...intro, "", "No results yet. Run `pnpm bench`.", ""].join("\n");
  return [
    ...intro,
    "",
    ...glance(headline),
    "",
    ...byKind(input, headline),
    ...(limits(headline).length > 0 ? ["", ...limits(headline)] : []),
    "",
    ...allModes(input.results),
    "",
    ...modelSection(input.results),
    "",
    ...caveats(input),
    "",
    ...pages(),
    "",
  ].join("\n");
}
