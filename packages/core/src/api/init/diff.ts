/** Minimal line diff for showing a file change. Files `init` writes are small, so LCS is fine. */
export function renderDiff(path: string, before: string | undefined, after: string): string {
  const a = before === undefined ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  if (before === after) return "";

  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => Array.from<number>({ length: cols }).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      lines.push(`+${b[j]}`);
      j += 1;
    } else {
      lines.push(`-${a[i]}`);
      i += 1;
    }
  }
  return [`--- ${before === undefined ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`, ...lines].join("\n");
}
