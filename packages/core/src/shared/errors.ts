/**
 * Errors: one way to read a message out of a caught value, and one base class for the errors this
 * package throws on purpose. Callers match on `code` (or the class), never on message text.
 */

/** The message of a caught value. `catch` gives `unknown`, so anything may arrive here. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AutoremediatorErrorOptions {
  /** The error that caused this one; kept so a log shows the whole chain. */
  cause?: unknown;
}

/**
 * Base class for errors thrown on purpose. `code` is a stable, machine-readable identifier
 * (`"run-not-found"`) that surfaces map to exit codes, HTTP statuses and MCP error results.
 */
export class AutoremediatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: AutoremediatorErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
  }
}

/** A thing the caller named does not exist (a run, an attempt, a patch file). */
export class NotFoundError extends AutoremediatorError {
  constructor(what: string, options: AutoremediatorErrorOptions = {}) {
    super("not-found", `${what} not found`, options);
  }
}

/** The caller's input is not valid; the message says which field and why. */
export class InvalidInputError extends AutoremediatorError {
  constructor(message: string, options: AutoremediatorErrorOptions = {}) {
    super("invalid-input", message, options);
  }
}

/** Stored or received data does not have the shape we expect (see `readJsonFile`). */
export class DataFormatError extends AutoremediatorError {
  constructor(message: string, options: AutoremediatorErrorOptions = {}) {
    super("data-format", message, options);
  }
}
