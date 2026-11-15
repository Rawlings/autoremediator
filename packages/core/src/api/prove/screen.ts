/**
 * A cheap read of a reproduction script before it runs, and the reason a kept script can be
 * reviewed in seconds.
 *
 * This is a tripwire and a style rule, not a security boundary: it is bypassable by anyone who
 * writes code to bypass it. The boundary is the sandbox (`sandbox.ts`) the script runs in. The
 * screen exists because a kept script is committed to `patches/` and later run by the existing
 * proof-of-fix check in the project, outside that sandbox, so a script that has no business
 * touching the network, processes or the environment should be refused rather than kept.
 *
 * It also refuses the shortcuts a model takes when it is rewarded for "fails before, passes after":
 * looking at the package version, and reading the package's own files, instead of calling its API.
 */

export const MAX_SCRIPT_CHARS = 20_000;

/** Modules a reproduction may load, besides the package under test. */
export const ALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "assert/strict",
  "buffer",
  "crypto",
  "events",
  "fs",
  "path",
  "querystring",
  "stream",
  "string_decoder",
  "timers",
  "url",
  "util",
  "zlib",
]);

interface Forbidden {
  pattern: RegExp;
  why: string;
}

const FORBIDDEN: readonly Forbidden[] = [
  { pattern: /\bprocess\s*\.\s*env\b/, why: "reads the environment (process.env)" },
  { pattern: /\bprocess\s*\.\s*(?:kill|binding|dlopen|chdir|mainModule|reallyExit|abort)\b/, why: "uses a process control API" },
  { pattern: /\bprocess\s*\.\s*versions?\b/, why: "inspects the Node.js version" },
  { pattern: /\b(?:eval|Function)\s*\(/, why: "evaluates code built from strings" },
  { pattern: /\bnew\s+Function\b/, why: "evaluates code built from strings" },
  { pattern: /\bconstructor\s*\.\s*constructor\b/, why: "reaches the Function constructor" },
  { pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/, why: "uses the network" },
  { pattern: /\bglobalThis\s*\[|\bglobal\s*\[|\bglobalThis\s*\.\s*process\b/, why: "reaches globals indirectly" },
  { pattern: /\bpackage\.json\b/, why: "reads the package manifest (the script must call the package, not look at its version)" },
  { pattern: /\.\s*version\b|\[\s*["'`]version["'`]\s*\]/, why: "reads a version (the script must call the package, not look at its version)" },
];

const SPECIFIER = /\brequire\s*\(\s*(["'`])([^"'`]*)\1\s*\)|\bimport\s*\(\s*(["'`])([^"'`]*)\3\s*\)|\bfrom\s*(["'`])([^"'`]*)\5|\bimport\s*(["'`])([^"'`]*)\7/g;
const DYNAMIC = /\brequire\s*\(\s*(?!["'`])|\bimport\s*\(\s*(?!["'`])|\brequire\s*\.\s*(?:resolve|cache|main)\b|\bmodule\s*\.\s*(?:require|constructor|children|parent)\b/;

export interface ScreenResult {
  ok: boolean;
  violations: string[];
}

function specifiersOf(script: string): string[] {
  const found: string[] = [];
  for (const match of script.matchAll(SPECIFIER)) {
    found.push(match[2] ?? match[4] ?? match[6] ?? match[8] ?? "");
  }
  return found;
}

/** Is `specifier` a module the script may load: a listed builtin, or the package under test? */
function allowedSpecifier(specifier: string, packageName: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (ALLOWED_BUILTINS.has(bare)) return true;
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

export function screenScript(
  script: string,
  context: { packageName: string; versions: readonly string[] },
): ScreenResult {
  const violations: string[] = [];
  if (script.trim() === "") return { ok: false, violations: ["the script is empty"] };
  if (script.length > MAX_SCRIPT_CHARS) {
    violations.push(`the script is longer than ${MAX_SCRIPT_CHARS} characters`);
  }
  if (script.includes("\0")) violations.push("the script contains a NUL byte");

  const specifiers = specifiersOf(script);
  for (const specifier of new Set(specifiers)) {
    if (!allowedSpecifier(specifier, context.packageName)) {
      violations.push(
        `loads "${specifier}", which is not ${context.packageName} or one of: ${[...ALLOWED_BUILTINS].join(", ")}`,
      );
    }
  }
  if (!specifiers.some((specifier) => specifier === context.packageName || specifier.startsWith(`${context.packageName}/`))) {
    violations.push(`never loads ${context.packageName}; a reproduction must exercise the package through its public API`);
  }
  if (DYNAMIC.test(script)) violations.push("loads a module by a computed name");

  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(script)) violations.push(why);
  }
  for (const version of context.versions) {
    if (script.includes(version)) {
      violations.push(`mentions the version ${version} (the script must behave differently because of the code, not because of a version it was told)`);
    }
  }
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}
