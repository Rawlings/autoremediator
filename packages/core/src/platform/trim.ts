/**
 * Linear-time replacements for `value.replace(/^c+|c+$/g, "")`. Regexes with a trailing
 * quantified anchor backtrack quadratically on long runs of `c`, which is a ReDoS risk when
 * the input is user-controlled.
 */
export function trimChar(
  value: string,
  char: string,
  side: "both" | "start" | "end" = "both",
): string {
  let start = 0;
  let end = value.length;
  if (side !== "end") {
    while (start < end && value[start] === char) start++;
  }
  if (side !== "start") {
    while (end > start && value[end - 1] === char) end--;
  }
  return value.slice(start, end);
}
