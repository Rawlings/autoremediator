/** `1 file`, `2 files`. Pass `plural` when adding "s" is not enough (`1 entry`, `2 entries`). */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
