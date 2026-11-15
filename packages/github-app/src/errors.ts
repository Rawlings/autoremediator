/** The message of a caught value. `catch` gives `unknown`, so anything may arrive here. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
