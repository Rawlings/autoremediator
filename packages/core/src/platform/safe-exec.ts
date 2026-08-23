import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";

export type SafeExecOptions = ExecaOptions & {
  timeoutMs?: number;
  allowNodeOptions?: boolean;
};

const DANGEROUS_ENV_VARS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PERL5OPT",
  "PERL5LIB",
  "PYTHONWARNINGS",
  "PYTHONPATH",
  "RUBYOPT",
  "RUBYLIB",
  "BASH_ENV",
  "ENV",
]);

/**
 * Sanitizes environment variables to prevent process-injection and supply chain attacks.
 */
export function sanitizeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  allowNodeOptions = false,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.includes("\0") || (typeof value === "string" && value.includes("\0"))) continue;
    if (DANGEROUS_ENV_VARS.has(key)) {
      if (key === "NODE_OPTIONS" && allowNodeOptions) {
        sanitized[key] = value;
      }
      continue;
    }
    sanitized[key] = value;
  }

  return sanitized;
}

/**
 * Validates command line arguments for safety (blocking null bytes and malformed tokens).
 */
export function validateCommandArguments(file: string, args: readonly string[] = []): void {
  if (file.includes("\0")) {
    throw new Error("Command execution blocked: executable path contains null bytes");
  }
  for (const arg of args) {
    if (arg.includes("\0")) {
      throw new Error(`Command execution blocked: argument contains null bytes: ${arg}`);
    }
  }
}

/**
 * Safe wrapper around execa that enforces environment sanitization, timeouts, and argument safety.
 */
export function safeExeca(
  file: string,
  args: readonly string[] = [],
  options: SafeExecOptions = {},
): ResultPromise {
  validateCommandArguments(file, args);

  const timeout =
    options.timeoutMs ?? (typeof options.timeout === "number" ? options.timeout : 60_000);
  const sanitizedEnv = sanitizeEnvironment(
    (options.env as NodeJS.ProcessEnv) ?? process.env,
    options.allowNodeOptions,
  );

  return execa(file, args as string[], {
    ...options,
    timeout,
    env: sanitizedEnv,
  });
}
