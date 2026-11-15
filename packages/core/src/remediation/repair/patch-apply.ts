/**
 * The one way a proposed diff reaches an attempt's checkout, whoever proposed it: an agent through
 * `proposePatch`, or a recipe. Only project source may change, the patch must be plain text, stay
 * inside the checkout, and apply cleanly.
 */
import { resolve } from "node:path";

import { safeExeca } from "../../platform/safe-exec.js";
import { ScopeGuard, ScopeViolation } from "./scope-guard.js";

export const MAX_PATCH_BYTES = 200_000;

const FORBIDDEN_PATCH = [
  [/^GIT binary patch/m, "binary changes"],
  [/^Binary files /m, "binary changes"],
  [/^(old|new) mode /m, "file mode changes"],
  [/^(rename|copy) (from|to) /m, "renames and copies"],
  [/^new file mode 120000/m, "symbolic links"],
  // An existing link changed in place has no `new file mode` line, only the mode on its index line.
  [/^index \S+ 120000/m, "symbolic links"],
  [/^(deleted file mode|old mode|new mode) 120000/m, "symbolic links"],
] as const;

export interface AppliedPatch {
  /** The patch as applied (with its final newline), for undoing it. */
  text: string;
  /** Files changed, relative to the repository root. */
  files: string[];
}

/** Throws when a diff holds binary, mode, rename or symbolic link changes. */
export function assertPlainTextPatch(diff: string): void {
  for (const [pattern, what] of FORBIDDEN_PATCH) {
    if (pattern.test(diff))
      throw new Error(`The patch contains ${what}, which an attempt may not change.`);
  }
}

/** Check a diff against everything an attempt may change, then apply it to the checkout. */
export async function validateAndApplyPatch(checkout: string, diff: string): Promise<AppliedPatch> {
  if (diff.trim().length === 0) throw new Error("The patch is empty.");
  if (Buffer.byteLength(diff) > MAX_PATCH_BYTES)
    throw new Error(`The patch is larger than ${MAX_PATCH_BYTES} bytes.`);
  assertPlainTextPatch(diff);
  const text = diff.endsWith("\n") ? diff : `${diff}\n`;

  const top = (
    await safeExeca("git", ["rev-parse", "--show-toplevel"], { cwd: checkout, stdio: "pipe" })
  ).stdout.trim();
  let files: string[];
  try {
    const numstat = await safeExeca("git", ["apply", "--numstat", "-"], {
      cwd: top,
      input: text,
      stdio: "pipe",
    });
    files = numstat.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")[2] ?? "")
      .filter(Boolean);
  } catch (cause) {
    throw new Error("The patch is not a valid unified diff.", { cause });
  }
  if (files.length === 0) throw new Error("The patch changes no files.");

  const guard = new ScopeGuard(checkout);
  for (const file of files) {
    try {
      guard.assertWritable(resolve(top, file));
    } catch (error) {
      if (error instanceof ScopeViolation)
        throw new Error(`Patch refused: ${error.message}`, { cause: error });
      throw error;
    }
  }

  try {
    await safeExeca("git", ["apply", "--check", "-"], { cwd: top, input: text, stdio: "pipe" });
  } catch (cause) {
    throw new Error(
      "The patch does not apply to the checkout as it is now (read the files again and rebase it).",
      { cause },
    );
  }
  await safeExeca("git", ["apply", "-"], { cwd: top, input: text, stdio: "pipe" });
  return { text, files };
}

/** Take an applied patch back out, exactly. */
export async function undoPatch(checkout: string, applied: AppliedPatch): Promise<void> {
  const top = (
    await safeExeca("git", ["rev-parse", "--show-toplevel"], { cwd: checkout, stdio: "pipe" })
  ).stdout.trim();
  await safeExeca("git", ["apply", "-R", "-"], { cwd: top, input: applied.text, stdio: "pipe" });
}
