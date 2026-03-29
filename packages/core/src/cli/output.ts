export function logJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function formatCountMap(counts: Record<string, number> | undefined): string | undefined {
  if (!counts) return undefined;

  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (entries.length === 0) return undefined;

  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}
