/** Small formatting helpers shared by the results pages. */

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (high === undefined) return undefined;
  return sorted.length % 2 === 1 || low === undefined ? high : (low + high) / 2;
}

export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [line(headers), line(headers.map(() => "---")), ...rows.map((row) => line(row))].join(
    "\n",
  );
}

export const code = (text: string): string => `\`${text}\``;

/** `a/b`, or `n/a` when there is nothing to count. */
export const fraction = (part: number, total: number): string =>
  total === 0 ? "n/a" : `${part}/${total}`;
