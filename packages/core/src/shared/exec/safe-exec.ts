import { basename } from "node:path";

import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";

export type SafeExecOptions = ExecaOptions & {
  timeoutMs?: number;
  allowNodeOptions?: boolean;
  /**
   * Secret-looking variables to keep for this one command (exact names). Everything else that
   * `isSecretEnvName` matches is removed from the child's environment.
   */
  passEnv?: readonly string[];
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
 * Variables a package manager needs to authenticate to a private registry through `.npmrc`
 * (`//host/:_authToken=${NPM_TOKEN}`). They are kept so private-registry installs keep working;
 * they are still credentials, so they are the one deliberate exception to the secret scrub.
 */
const REGISTRY_AUTH_ENV =
  /^(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_.+|YARN_NPM_.+|PNPM_.*TOKEN|BUN_AUTH_TOKEN)$/i;

const SECRET_ENV_EXACT =
  /^(?:GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|CI_JOB_TOKEN|BITBUCKET_.*TOKEN|AZURE_DEVOPS_.*|SYSTEM_ACCESSTOKEN|ACTIONS_ID_TOKEN_REQUEST_.*|ACTIONS_RUNTIME_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ANTHROPIC_.*KEY|OPENAI_.*KEY|GOOGLE_GENERATIVE_AI_API_KEY|GEMINI_API_KEY|MISTRAL_API_KEY|COHERE_API_KEY|XAI_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY)$/i;
// Includes this tool's own credentials: AUTOREMEDIATOR_JWT_SECRET, _API_TOKENS, _NVD_API_KEY,
// _GITHUB_APP_PRIVATE_KEY, _WEBHOOK_SECRET, _EVIDENCE_SIGNING_KEY, _A2A_SIGNING_KEY. Its switches
// (AUTOREMEDIATOR_TRACE_*, _ALLOWED_ROOTS, _MODEL, ...) are not credentials and stay.
const SECRET_ENV_PATTERN =
  /(?:_API_KEY|_APIKEY|_PRIVATE_KEY|_SIGNING_KEY|_SECRET|_SECRET_KEY|_PASSWORD|_PASSWD|_ACCESS_TOKEN|_AUTH_TOKEN|_TOKENS?)$/i;

/** Whether an environment variable name looks like it carries a credential. */
export function isSecretEnvName(name: string): boolean {
  if (REGISTRY_AUTH_ENV.test(name)) return false;
  return SECRET_ENV_EXACT.test(name) || SECRET_ENV_PATTERN.test(name);
}

/**
 * Sanitizes environment variables to prevent process-injection and secret leakage into child
 * processes (installs, tests and scripts of code this tool does not control).
 */
export function sanitizeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  allowNodeOptions = false,
  passEnv: readonly string[] = [],
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  const pass = new Set(passEnv);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.includes("\0") || (typeof value === "string" && value.includes("\0"))) continue;
    if (DANGEROUS_ENV_VARS.has(key)) {
      if (key === "NODE_OPTIONS" && allowNodeOptions) {
        sanitized[key] = value;
      }
      continue;
    }
    if (isSecretEnvName(key) && !pass.has(key)) continue;
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
 * Yarn Berry has no command-line flag to skip lifecycle scripts, only `enableScripts`, which
 * `YARN_ENABLE_SCRIPTS` sets. Turn it off for `yarn install` unless the caller (or the user's
 * environment) already decided; `installScripts: all` in the policy is `YARN_ENABLE_SCRIPTS=1`.
 */
function withInstallScriptsOff(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const isYarnInstall = basename(file) === "yarn" && (args[0] === "install" || args.length === 0);
  if (!isYarnInstall || env["YARN_ENABLE_SCRIPTS"] !== undefined) return env;
  return { ...env, YARN_ENABLE_SCRIPTS: "0" };
}

/**
 * Safe wrapper around execa that enforces environment sanitization, timeouts, and argument safety.
 */
export function safeExeca<OptionsType extends SafeExecOptions = SafeExecOptions>(
  file: string,
  args: readonly string[] = [],
  options: OptionsType = {} as OptionsType,
): ResultPromise<OptionsType> {
  validateCommandArguments(file, args);

  const timeout =
    options.timeoutMs ?? (typeof options.timeout === "number" ? options.timeout : 60_000);
  const sanitizedEnv = sanitizeEnvironment(
    withInstallScriptsOff(file, args, options.env ?? process.env),
    options.allowNodeOptions,
    options.passEnv,
  );

  return execa(file, args as string[], {
    ...options,
    timeout,
    // Without this execa merges process.env back in, undoing the sanitization above.
    extendEnv: false,
    env: sanitizedEnv,
  }) as unknown as ResultPromise<OptionsType>;
}
