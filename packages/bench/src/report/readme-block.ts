/**
 * The few measured numbers quoted in the repository README. They are generated from the same
 * results files as the results pages and a test fails if the README block differs.
 */
import { fraction } from "./format.ts";
import { scoredRows, sliceOf } from "./metrics.ts";
import { headlineOf, scopeOf } from "./overview.ts";
import type { ReportInput } from "./types.ts";

export const README_START = "<!-- benchmark:start -->";
export const README_END = "<!-- benchmark:end -->";

export function renderReadmeBlock(input: ReportInput): string {
  const headline = headlineOf(input.results);
  if (!headline) return `${README_START}\nNo benchmark results yet.\n${README_END}`;
  const { rows, text } = scopeOf(headline);
  const slice = sliceOf(rows);
  const body = [
    `Measured with no model on ${text}:`,
    "",
    `- **${fraction(slice.fixCorrect, slice.fixExpected)}** vulnerable dependencies fixed and verified by an independent oracle.`,
    `- **${fraction(slice.holdCorrect, slice.holdExpected)}** cases with no safe fix handled honestly: left untouched, with the reason reported.`,
    `- **${slice.falseClaims}** fixes claimed that were not real, and **${slice.leftBroken}** projects left broken.`,
    `- Tasks that need an edit to your own source are rolled back untouched without a model; with an agent attached it attempts the repair and the verifier decides.`,
    "",
    `See the [full results](packages/bench/RESULTS.md) for each kind of problem, what is not yet covered, and how to reproduce them.`,
  ];
  return [README_START, ...body, README_END].join("\n");
}

/** `readme` with its marked block replaced by `block`; throws if the markers are missing. */
export function withReadmeBlock(readme: string, block: string): string {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `The README needs ${README_START} and ${README_END} around the benchmark figures`,
    );
  }
  return `${readme.slice(0, start)}${block}${readme.slice(end + README_END.length)}`;
}

export { scoredRows };
