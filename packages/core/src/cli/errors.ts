/** True when the command line asks for JSON output, so errors should be machine-readable too. */
export function wantsJson(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output-format") return argv[i + 1] === "json";
    if (arg === "--output-format=json") return true;
  }
  return false;
}

/**
 * Render a fatal error for stderr. Under `--output-format json` it is one JSON line, so an agent
 * parsing stdout never has to scrape prose to learn why a command failed.
 */
export function formatCliError(error: unknown, json: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!json) return `[autoremediator] ${message}\n`;
  const name = error instanceof Error ? error.name : "Error";
  return `${JSON.stringify({ error: { name, message } })}\n`;
}
