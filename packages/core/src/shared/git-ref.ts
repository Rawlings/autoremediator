import { safeExeca } from "./exec/safe-exec.js";

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.codePointAt(index) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Refuse a caller-supplied git ref that git could read as an option (`--output=...`, `-p`) or that
 * carries control characters. Every ref that reaches git from outside must pass this first.
 */
export function assertSafeGitRef(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} is required: a git ref (commit, tag or branch).`);
  if (value.startsWith("-") || hasControlCharacter(value)) {
    throw new Error(`${name} is not a valid git ref: ${JSON.stringify(value)}.`);
  }
}

/** The commit a caller-supplied ref names. Throws for an unsafe or unresolvable ref. */
export async function resolveGitCommit(cwd: string, name: string, ref: string): Promise<string> {
  assertSafeGitRef(name, ref);
  const result = await safeExeca(
    "git",
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    {
      cwd,
      stdio: "pipe",
      reject: false,
    },
  );
  const sha = result.exitCode === 0 ? result.stdout.trim() : "";
  if (!sha) {
    throw new Error(
      `${name} ${JSON.stringify(ref)} is not a commit in this repository (is ${cwd} a git checkout, and does the ref exist?)`,
    );
  }
  return sha;
}
