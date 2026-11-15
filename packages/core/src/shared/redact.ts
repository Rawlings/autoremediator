import { isSecretEnvName } from "./exec/safe-exec.js";

/** Token formats that are recognisable by themselves, wherever they show up. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, // model provider keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Values of secret-looking environment variables, as long as they are distinctive enough to match. */
function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && isSecretEnvName(name)) values.add(value);
  }
  return [...values].toSorted((a, b) => b.length - a.length);
}

/**
 * Remove credentials from text that is about to be shown, stored or sent to a model. git is given its
 * auth header on the command line (older gits cannot take it from the environment), and a failed
 * command's error message repeats the whole command line, so anything that surfaces such an error
 * goes through here. So does the output of a project's own tests, which may print the environment.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
    .replaceAll(/(AUTHORIZATION:\s*(?:basic|bearer)\s+)[^\s'"]+/gi, "$1***")
    .replaceAll(/(\/\/)[^/@\s'"]+:[^@\s'"]+@/g, "$1***@");
  for (const pattern of TOKEN_PATTERNS) out = out.replaceAll(pattern, "***");
  for (const value of secretValues(env)) out = out.replaceAll(value, "***");
  return out;
}
