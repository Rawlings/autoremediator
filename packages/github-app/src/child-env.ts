/**
 * The environment handed to every process the app starts (git, package managers, the project's own
 * tests). Those processes run code the app does not control: a dependency's install script, a test
 * from a repository it was asked to fix. The app's private key, webhook secret and tokens are in
 * its own environment, so they are left out.
 */
const REGISTRY_AUTH_ENV =
  /^(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_.+|YARN_NPM_.+|PNPM_.*TOKEN|BUN_AUTH_TOKEN)$/i;
const SECRET_ENV_EXACT =
  /^(?:GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|CI_JOB_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ANTHROPIC_.*KEY|OPENAI_.*KEY)$/i;
const SECRET_ENV_PATTERN =
  /(?:_API_KEY|_APIKEY|_PRIVATE_KEY|_SIGNING_KEY|_SECRET|_SECRET_KEY|_PASSWORD|_PASSWD|_ACCESS_TOKEN|_AUTH_TOKEN|_TOKENS?)$/i;
const INJECTION_ENV = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
]);

function isSecret(name: string): boolean {
  if (REGISTRY_AUTH_ENV.test(name)) return false;
  return SECRET_ENV_EXACT.test(name) || SECRET_ENV_PATTERN.test(name);
}

/** `env` without credentials or process-injection variables, plus `extra`. */
export function childEnvironment(
  extra: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || INJECTION_ENV.has(name) || isSecret(name)) continue;
    out[name] = value;
  }
  return { ...out, ...extra };
}

/**
 * Git configuration that sends `token` to github.com for one command, through the environment
 * (`GIT_CONFIG_*`, git 2.31+). Unlike a token in the clone URL it is neither in the process list
 * nor written to `.git/config`, where the repository's own code could read it.
 */
export function gitAuthEnvironment(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}
