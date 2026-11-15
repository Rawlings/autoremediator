import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { discoverProjectFiles } from "../platform/rollback.js";
import { safeExeca } from "../platform/safe-exec.js";
import { sha256 } from "./hash.js";

/** What a plan or a finished run depends on: the manifests, lockfiles and patches, plus the policy. */
export interface RepoFingerprint {
  gitHead?: string;
  /** Uncommitted changes exist anywhere in the work tree. */
  dirty: boolean;
  /** Hash over every manifest, lockfile, patch and tsconfig file the tool may change. */
  filesSha256: string;
  /** Hash of the policy in force, when there is one. */
  policySha256?: string;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await safeExeca("git", args, { cwd, stdio: "pipe" });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

function policyContent(cwd: string, explicitPolicy?: string): string | undefined {
  if (explicitPolicy !== undefined) {
    const trimmed = explicitPolicy.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("---")) return explicitPolicy;
  }
  const path = explicitPolicy ?? join(cwd, ".github", "autoremediator.yml");
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

export async function fingerprintRepo(cwd: string, policy?: string): Promise<RepoFingerprint> {
  const files = discoverProjectFiles(cwd)
    .map((file) => relative(cwd, file))
    .toSorted();
  const lines = files.map((file) => {
    try {
      return `${file}\0${sha256(readFileSync(join(cwd, file)))}`;
    } catch {
      return `${file}\0unreadable`;
    }
  });

  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const status = head === undefined ? undefined : await git(cwd, ["status", "--porcelain"]);
  const policyText = policyContent(cwd, policy);

  return {
    ...(head ? { gitHead: head } : {}),
    dirty: Boolean(status && status.length > 0),
    filesSha256: sha256(lines.join("\n")),
    ...(policyText === undefined ? {} : { policySha256: sha256(policyText) }),
  };
}

/** Whether two fingerprints describe the same inputs to remediation (the commit itself may differ). */
export function sameInputs(a: RepoFingerprint, b: RepoFingerprint): boolean {
  return a.filesSha256 === b.filesSha256 && a.policySha256 === b.policySha256;
}
