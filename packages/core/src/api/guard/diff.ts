import { collectDependencyChanges } from "../../scanner/delta-scan.js";
import { resolveGitCommit } from "../../platform/git-ref.js";
import { safeExeca } from "../../platform/safe-exec.js";
import type { DeltaDependencyChange } from "../../platform/types.js";
import { guardPackage, type GuardDeps, defaultGuardDeps } from "./index.js";
import { guardExitCode } from "./hook.js";
import type { GuardOptions, GuardReport, GuardVerdict } from "./types.js";

export interface GuardDiffOptions extends GuardOptions {
  /** Git ref to compare the working tree with. Default `HEAD`. A branch name is compared at the merge base. */
  baseRef?: string;
  /** Also guard packages that only the lockfile gained (transitive dependencies). Default false. */
  includeTransitive?: boolean;
  /** Most lookups in flight at once. Default 8. */
  concurrency?: number;
}

export interface GuardDiffSkipped {
  packageName: string;
  /** The version or range as written in the manifest. */
  version: string;
  reason: string;
}

export interface GuardDiffResult {
  schemaVersion: "1.0";
  /** The ref the working tree was compared with (the merge base when one was found). */
  baseRef: string;
  /** Dependencies added or changed that were looked at. */
  checked: number;
  skipped: GuardDiffSkipped[];
  verdict: GuardVerdict;
  reports: GuardReport[];
}

/** Version fields that name something other than a registry release: nothing to look up. */
const LOCAL_PROTOCOL = /^(?:workspace|link|file|portal|catalog):/;
const NON_REGISTRY = /^(?:[a-z][a-z0-9+.-]*:|\.{0,2}\/|~\/|[\w.-]+\/[\w.-]+$)/i;

/**
 * The spec `guardPackage` should judge for a changed dependency, or why there is none.
 * `npm:` aliases and plain ranges are registry packages; URLs, git and `owner/repo` forms are passed
 * on as they are so the guard says it cannot check them; workspace, link, file and catalog entries
 * are local and skipped.
 */
export function specForChange(change: DeltaDependencyChange): { spec: string } | { skip: string } {
  const version = change.newVersion?.trim();
  if (!version) return { skip: "no version" };
  if (LOCAL_PROTOCOL.test(version)) return { skip: `${version.split(":")[0]}: dependencies are not registry packages` };
  if (version.startsWith("npm:")) return { spec: `${change.packageName}@${version}` };
  if (NON_REGISTRY.test(version)) return { spec: version };
  return { spec: `${change.packageName}@${version}` };
}

async function resolveBase(cwd: string, ref: string): Promise<string> {
  const commit = await resolveGitCommit(cwd, "baseRef", ref);
  // Compare with where this branch left the base, so work that landed on the base since does not show up as ours.
  const base = await safeExeca("git", ["merge-base", commit, "HEAD"], { cwd, reject: false });
  const sha = base.exitCode === 0 ? base.stdout.trim() : "";
  return sha || commit;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()));
  return results;
}

/**
 * Guard the dependencies a change adds: those added or changed in `package.json` since `baseRef`
 * (and, with `includeTransitive`, those the lockfile gained). Host independent, so it fits a
 * pre-commit hook, a pull request check, or an agent that edited a manifest instead of running an
 * install command.
 */
export async function guardGitDiff(
  options: GuardDiffOptions = {},
  deps: GuardDeps = defaultGuardDeps,
): Promise<GuardDiffResult> {
  const cwd = options.cwd ?? process.cwd();
  const baseRef = await resolveBase(cwd, options.baseRef ?? "HEAD");
  const { dependencyChanges } = await collectDependencyChanges(cwd, baseRef);

  const specs = new Map<string, string>();
  const skipped: GuardDiffSkipped[] = [];
  for (const change of dependencyChanges) {
    if (change.changeType === "removed" || change.changeType === "downgraded") continue;
    if (change.dependencyType === "transitive" && !options.includeTransitive) continue;
    // A peer dependency is a range the consumer must satisfy, not something this package installs.
    if (change.dependencyType === "peerDependencies") continue;
    const target = specForChange(change);
    if ("skip" in target) {
      skipped.push({ packageName: change.packageName, version: change.newVersion ?? "", reason: target.skip });
    } else {
      specs.set(target.spec, change.packageName);
    }
  }

  const reports = await mapLimit([...specs.keys()], options.concurrency ?? 8, (spec) =>
    guardPackage(spec, { ...options, cwd }, deps),
  );
  const code = guardExitCode(reports);
  return {
    schemaVersion: "1.0",
    baseRef,
    checked: reports.length,
    skipped,
    verdict: code === 4 ? "block" : code === 3 ? "warn" : "allow",
    reports,
  };
}
