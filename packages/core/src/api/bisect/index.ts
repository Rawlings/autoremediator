import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { resolveInstallCommand } from "../../platform/package-manager/index.js";
import { safeExeca } from "../../platform/safe-exec.js";
import { LONG_RUNNING_TIMEOUT_MS } from "../../platform/timeouts.js";
import type { PackageManager } from "../../platform/types.js";
import { createRefWorktree } from "../../runs/worktree.js";
import type { applyPlan } from "../runs/index.js";
import { directDependencyNames, lockfileChanges, type ManifestLike } from "./changes.js";
import { ddmin, type Verdict } from "./ddmin.js";
import { applyPins, checkLockedVersions } from "./pins.js";
import { planRemedy } from "./remedy.js";
import { runProcess, sanitizeOutput, type ProcessResult } from "./shell.js";
import type {
  BisectCommandRecord,
  BisectedPackage,
  BisectOptions,
  BisectReport,
  BisectStatus,
  BisectStep,
  BisectStepKind,
} from "./types.js";

export type {
  BisectCommandRecord,
  BisectedPackage,
  BisectOptions,
  BisectRemedy,
  BisectReport,
  BisectSkippedChange,
  BisectStatus,
  BisectStep,
  BisectStepKind,
} from "./types.js";

export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
export const DEFAULT_MAX_STEPS = 30;

/** Replaceable pieces, for tests. */
export interface BisectDeps {
  /** Environment for the package manager and the command (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  applyPlanFn?: typeof applyPlan;
}

const LOCKFILES: ReadonlyArray<[file: string, manager: PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await safeExeca("git", args, {
    cwd,
    stdio: "pipe",
    reject: false,
    stripFinalNewline: false,
  });
  return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
}

async function showAt(top: string, commit: string, path: string): Promise<string | undefined> {
  const result = await git(top, ["show", `${commit}:${path}`]);
  return result.ok ? result.stdout : undefined;
}

function parseManifest(text: string | undefined): ManifestLike | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as ManifestLike;
  } catch {
    return undefined;
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.codePointAt(index) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function checkRef(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} is required: a git ref (commit, tag or branch).`);
  if (value.startsWith("-") || hasControlCharacter(value)) {
    throw new Error(`${name} is not a valid git ref: ${JSON.stringify(value)}.`);
  }
}

async function resolveCommit(top: string, name: string, ref: string): Promise<string> {
  const result = await git(top, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!result.ok)
    throw new Error(
      `${name} ref ${JSON.stringify(ref)} does not resolve to a commit in this repository.`,
    );
  return result.stdout.trim();
}

const updatedNames = (subset: readonly BisectedPackage[]): string[] =>
  subset.map((item) => item.packageName);

const describeUpdate = (item: BisectedPackage): string =>
  `${item.packageName} ${item.fromVersion} -> ${item.toVersion} (${item.dependencyScope})`;

function installArgv(manager: PackageManager, frozen: boolean, ignoreScripts: boolean): string[] {
  const argv = resolveInstallCommand(
    manager,
    { installMode: "standard", enforceFrozenLockfile: frozen },
    1,
  );
  if (manager === "npm") argv.push("--no-audit", "--no-fund");
  if (ignoreScripts) argv.push("--ignore-scripts");
  return argv;
}

/**
 * Find which package update in the lockfile diff between a good and a bad git ref makes a command
 * fail. Runs entirely in isolated git worktrees: install the good ref and check the command passes,
 * install the bad ref and check it fails, then hold subsets of the changed packages at their bad-ref
 * versions (everything else at its good-ref version) and narrow down with delta debugging. The
 * result names the package, or the smallest set that only fails together, and a plan that pins it back.
 */
export async function bisectLockfile(
  options: BisectOptions,
  deps: BisectDeps = {},
): Promise<BisectReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const env = deps.env ?? process.env;
  const signal = options.signal;

  checkRef("good", options.good);
  const badRef = options.bad?.trim() || "HEAD";
  checkRef("bad", badRef);
  if (!options.command?.trim())
    throw new Error("command is required: the shell command that fails at the bad ref.");
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!(timeoutSeconds > 0)) throw new Error("timeoutSeconds must be greater than zero.");
  if (!Number.isInteger(maxSteps) || maxSteps < 1)
    throw new Error("maxSteps must be a whole number of at least 1.");
  if (options.packageManager && !["npm", "pnpm", "yarn"].includes(options.packageManager)) {
    throw new Error(
      `bisect supports npm, pnpm and yarn (classic) lockfiles; ${options.packageManager} is not supported.`,
    );
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!top) throw new Error("bisect needs a git repository: this directory is not one.");
  const sub = relative(realpathSync(top), realpathSync(cwd)).split(sep).join("/");
  const inRepo = (file: string) => (sub ? `${sub}/${file}` : file);

  const goodCommit = await resolveCommit(top, "good", options.good);
  const badCommit = await resolveCommit(top, "bad", badRef);
  if (goodCommit === badCommit)
    throw new Error("good and bad are the same commit: there is nothing to bisect.");

  // Which lockfile, hence which package manager.
  let lockfile: string | undefined;
  let manager: PackageManager | undefined;
  for (const [file, candidate] of LOCKFILES) {
    if (options.packageManager && candidate !== options.packageManager) continue;
    if ((await git(top, ["cat-file", "-e", `${badCommit}:${inRepo(file)}`])).ok) {
      lockfile = file;
      manager = candidate;
      break;
    }
  }
  if (!lockfile || !manager) {
    throw new Error(
      `No supported lockfile (${LOCKFILES.map(([file]) => file).join(", ")}) at ${badRef} in ${sub || "the repository root"}.`,
    );
  }
  if (manager === "bun") {
    throw new Error(
      "bisect cannot read bun lockfiles yet; npm, pnpm and yarn (classic) are supported.",
    );
  }
  const goodLock = await showAt(top, goodCommit, inRepo(lockfile));
  const badLock = await showAt(top, badCommit, inRepo(lockfile));
  if (goodLock === undefined) {
    throw new Error(
      `${lockfile} does not exist at ${options.good}: there is no lockfile to compare against.`,
    );
  }
  if (badLock === undefined) throw new Error(`${lockfile} does not exist at ${badRef}.`);
  if (manager === "yarn" && (goodLock.includes("__metadata:") || badLock.includes("__metadata:"))) {
    throw new Error("bisect reads yarn classic (v1) lockfiles only; this one is from yarn berry.");
  }
  const goodManifestText = await showAt(top, goodCommit, inRepo("package.json"));
  if (goodManifestText === undefined)
    throw new Error(`package.json does not exist at ${options.good}.`);
  const badManifest = parseManifest(await showAt(top, badCommit, inRepo("package.json")));

  const { updates, skipped } = lockfileChanges(
    lockfile,
    goodLock,
    badLock,
    directDependencyNames(badManifest),
  );

  const steps: BisectStep[] = [];
  const warnings: string[] = [];
  let stepsUsed = 0;
  let stopped: BisectReport["stopped"];

  const finish = (partial: {
    status: BisectStatus;
    summary: string;
    culprits?: BisectedPackage[];
    holdingBackFixes?: boolean;
    remedy?: BisectReport["remedy"];
  }): BisectReport => ({
    schemaVersion: "1",
    status: partial.status,
    summary: partial.summary,
    good: { ref: options.good, commit: goodCommit },
    bad: { ref: badRef, commit: badCommit },
    packageManager: manager,
    lockfile,
    command: sanitizeOutput(options.command, { env, maxChars: 4000 }),
    updates,
    skipped,
    culprits: partial.culprits ?? [],
    ...(partial.holdingBackFixes === undefined
      ? {}
      : { holdingBackFixes: partial.holdingBackFixes }),
    steps,
    stepsUsed,
    maxSteps,
    ...(stopped ? { stopped } : {}),
    ...(partial.remedy ? { remedy: partial.remedy } : {}),
    warnings,
    startedAt,
    durationMs: Date.now() - started,
  });

  const skippedNote =
    skipped.length > 0
      ? ` ${skipped.length} other locked package(s) were added or removed or have several versions and cannot be tried one at a time.`
      : "";
  if (updates.length === 0) {
    return finish({
      status: "no-changes",
      summary: `No package has a different locked version between ${goodCommit.slice(0, 12)} and ${badCommit.slice(0, 12)} in ${lockfile}.${skippedNote}`,
    });
  }

  // ---- checkouts: always removed, also when interrupted -----------------------------------------
  const unique = `bisect-${process.pid}-${Date.now().toString(36)}`;
  const liveRoots = new Set<string>();
  const exitCleanup = () => {
    for (const path of liveRoots) rmSync(path, { recursive: true, force: true });
    spawnSync("git", ["worktree", "prune"], { cwd: top, stdio: "ignore" });
  };
  process.on("exit", exitCleanup);
  const removers: Array<() => Promise<void>> = [];

  const timeoutMs = Math.round(timeoutSeconds * 1000);
  const installTimeoutMs = Math.max(LONG_RUNNING_TIMEOUT_MS, timeoutMs);
  const ignoreScripts = options.ignoreScripts === true;
  const paths: Array<[string, string]> = [];

  const tail = (text: string, max: number) => sanitizeOutput(text, { env, paths, maxChars: max });
  const record = (display: string, result: ProcessResult): BisectCommandRecord => ({
    command: sanitizeOutput(display, { env, paths, maxChars: 4000 }),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  });

  try {
    const goodTree = await createRefWorktree(cwd, `${unique}-good`, goodCommit, env);
    removers.push(goodTree.remove);
    liveRoots.add(goodTree.root);
    paths.push([goodTree.root, "<checkout>"]);
    const badTree = await createRefWorktree(cwd, `${unique}-bad`, badCommit, env);
    removers.push(badTree.remove);
    liveRoots.add(badTree.root);
    paths.push([badTree.root, "<checkout>"]);

    for (const tree of [goodTree, badTree]) {
      if (!existsSync(join(tree.path, "package.json"))) {
        throw new Error(
          `package.json does not exist in ${sub || "the repository root"} at ${tree === goodTree ? options.good : badRef}.`,
        );
      }
    }

    let pnpmMajor: number | undefined;
    if (manager === "pnpm") {
      const version = await runProcess({
        argv: ["pnpm", "--version"],
        cwd: goodTree.path,
        env,
        timeoutMs: 60_000,
        signal,
      });
      const major = Number.parseInt(version.output.trim().split(".")[0] ?? "", 10);
      pnpmMajor = Number.isNaN(major) ? undefined : major;
    }

    const lockName = lockfile;
    const activeManager = manager;

    /**
     * Install and run the command in a checkout. `pinned` is the set of packages to hold at their bad-ref
     * version on top of the good ref; `undefined` means the checkout is installed exactly as committed.
     */
    const evaluate = async (
      tree: { path: string; root: string },
      kind: BisectStepKind,
      commit: string,
      pinned: readonly BisectedPackage[] | undefined,
    ): Promise<{ step: BisectStep; verdict: Verdict }> => {
      const stepNumber = steps.length + 1;
      const base = {
        step: stepNumber,
        kind,
        updated: pinned ? updatedNames(pinned) : kind === "bad-ref" ? updatedNames(updates) : [],
      };
      const done = (
        outcome: BisectStep["outcome"],
        phase: BisectStep["phase"],
        outputTail: string,
        extra: Partial<BisectStep> = {},
      ) => {
        const step: BisectStep = { ...base, outcome, phase, outputTail, ...extra };
        steps.push(step);
        return { step, verdict: outcome };
      };

      // A fresh copy of the commit: no leftovers from the previous state, no installed packages.
      const reset = await git(tree.root, ["reset", "--hard", "--quiet", commit]);
      const clean = await git(tree.root, ["clean", "-fdxq"]);
      if (!reset.ok || !clean.ok) {
        return done("unresolved", "install", tail(reset.stderr + clean.stderr, 600), {
          note: "could not reset the checkout",
        });
      }

      if (pinned) {
        try {
          applyPins(
            {
              dir: tree.path,
              packageManager: activeManager,
              ...(pnpmMajor === undefined ? {} : { pnpmMajor }),
            },
            pinned.map((item) => ({ packageName: item.packageName, version: item.toVersion })),
          );
        } catch (error) {
          return done("unresolved", "pins", "", {
            note: `could not write the pins: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      const frozen = pinned === undefined;
      const argv = installArgv(activeManager, frozen, ignoreScripts);
      const install = await runProcess({
        argv,
        cwd: tree.path,
        env,
        timeoutMs: installTimeoutMs,
        signal,
      });
      const installRecord = record(argv.join(" "), install);
      if (install.aborted)
        return done("unresolved", "install", tail(install.output, 600), {
          install: installRecord,
          note: "interrupted",
        });
      if (install.exitCode !== 0) {
        // An install that fails in a state taken from a commit is a broken build. In a combination
        // we made up it only says the combination cannot be installed.
        return done(frozen ? "fail" : "unresolved", "install", tail(install.output, 1500), {
          install: installRecord,
          note: install.timedOut
            ? "install timed out"
            : frozen
              ? "install failed"
              : "install failed in this combination of versions",
        });
      }

      if (pinned) {
        const lockPath = join(tree.path, lockName);
        const content = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : undefined;
        if (content === undefined) {
          return done("unresolved", "pins", "", {
            install: installRecord,
            note: `the install did not write ${lockName}, so the versions cannot be checked`,
          });
        }
        const mismatches = checkLockedVersions(
          lockName,
          content,
          updates,
          new Set(updatedNames(pinned)),
        );
        if (mismatches.length > 0) {
          const shown = mismatches
            .slice(0, 3)
            .map(
              (item) =>
                `${item.packageName} should be ${item.expected} but the lockfile has ${item.found.join(", ") || "nothing"}`,
            )
            .join("; ");
          return done("unresolved", "pins", "", {
            install: installRecord,
            note: `the package manager did not install the requested versions (${shown}${mismatches.length > 3 ? `; and ${mismatches.length - 3} more` : ""})`,
          });
        }
      }

      const run = await runProcess({
        shell: options.command,
        cwd: tree.path,
        env,
        timeoutMs,
        signal,
      });
      const runRecord = record(options.command, run);
      if (run.aborted)
        return done("unresolved", "command", tail(run.output, 600), {
          install: installRecord,
          run: runRecord,
          note: "interrupted",
        });
      const passed = run.exitCode === 0;
      return done(passed ? "pass" : "fail", "command", tail(run.output, passed ? 400 : 1500), {
        install: installRecord,
        run: runRecord,
        ...(run.timedOut
          ? { note: `the command was killed after ${timeoutSeconds}s and counts as failing` }
          : {}),
      });
    };

    const interrupted = () => signal?.aborted === true;
    const incomplete = (summary: string, culprits?: BisectedPackage[]): BisectReport => {
      stopped ??= interrupted() ? "interrupted" : undefined;
      return finish({ status: "incomplete", summary, ...(culprits ? { culprits } : {}) });
    };

    // ---- 1. the good ref must pass, the bad ref must fail --------------------------------------
    const good = await evaluate(goodTree, "good-ref", goodCommit, undefined);
    if (interrupted()) return incomplete("Interrupted before the good ref was checked.");
    if (good.verdict !== "pass") {
      return finish({
        status: "not-reproducible",
        summary: `Not reproducible: the command does not pass at the good ref ${goodCommit.slice(0, 12)} (${good.step.phase}${good.step.note ? `: ${good.step.note}` : ""}), so there is nothing to bisect from.`,
      });
    }
    const bad = await evaluate(badTree, "bad-ref", badCommit, undefined);
    if (interrupted()) return incomplete("Interrupted before the bad ref was checked.");
    if (bad.verdict === "pass") {
      return finish({
        status: "not-reproducible",
        summary: `Not reproducible: the command passes at the bad ref ${badCommit.slice(0, 12)} (flaky, or it depends on something outside the repository such as the network or a newer registry release).`,
      });
    }
    await badTree.remove();
    liveRoots.delete(badTree.root);

    // ---- 2. every update applied to the good ref must reproduce the failure --------------------
    const attempt = async (
      kind: BisectStepKind,
      subset: readonly BisectedPackage[],
    ): Promise<Verdict> => {
      stepsUsed++;
      return (await evaluate(goodTree, kind, goodCommit, subset)).verdict;
    };

    const all = await attempt("all-updates", updates);
    if (interrupted())
      return incomplete(
        "Interrupted while checking that the lockfile updates reproduce the failure.",
      );
    if (all !== "fail") {
      const last = steps.at(-1);
      return finish({
        status: "not-attributable",
        summary:
          all === "pass"
            ? `The command fails at ${badCommit.slice(0, 12)} but passes with all ${updates.length} changed package version(s) applied to ${goodCommit.slice(0, 12)}: the failure does not come from a version change of a package locked at both refs. Look at the source changes between the refs, or at the ${skipped.length} added, removed or multi-version package(s).`
            : `Could not build the bad ref's package versions on top of the good ref${last?.note ? ` (${last.note})` : ""}, so the failure could not be attributed to individual updates.`,
      });
    }

    // ---- 3. narrow down ------------------------------------------------------------------------
    const reserved = maxSteps > 2 ? 1 : 0; // a step kept for the final check
    const search =
      updates.length === 1
        ? {
            minimal: [...updates],
            evaluations: 0,
            complete: true as boolean,
            stoppedBecause: undefined as "budget" | "stopped" | undefined,
          }
        : await ddmin(
            updates,
            (item) => item.packageName,
            (subset) => attempt("subset", subset),
            {
              maxEvaluations: Math.max(maxSteps - stepsUsed - reserved, 0),
              shouldStop: interrupted,
            },
          );
    if (search.stoppedBecause === "budget") stopped = "max-steps";
    if (search.stoppedBecause === "stopped" || interrupted()) stopped = "interrupted";

    const culprits = search.minimal;
    const names = culprits.map(
      (item) => `${item.packageName} ${item.fromVersion} -> ${item.toVersion}`,
    );
    if (!search.complete && culprits.length > 1) {
      if (stopped === "max-steps")
        warnings.push(
          `Stopped at the limit of ${maxSteps} steps; raise maxSteps to narrow it further.`,
        );
      else if (stopped === undefined)
        warnings.push(
          "Some combinations of versions could not be installed, so the set may not be minimal.",
        );
      return incomplete(
        `Narrowed ${updates.length} updates down to ${culprits.length} that still fail (${names.join("; ")}), but not to a minimal set.`,
        culprits,
      );
    }
    if (!search.complete && stopped === undefined) {
      warnings.push(
        "Some combinations of versions could not be installed; the culprit is certain, but other updates may also break the command.",
      );
    }

    // ---- 4. confirm that holding the culprits back is what fixes it -----------------------------
    let holdingBackFixes: boolean | undefined;
    if (culprits.length === updates.length) {
      holdingBackFixes = true; // the good ref itself, which passed
    } else if (!interrupted() && stepsUsed < maxSteps) {
      const rest = updates.filter(
        (item) => !culprits.some((culprit) => culprit.packageName === item.packageName),
      );
      const verdict = await attempt("without-culprit", rest);
      if (verdict === "pass") holdingBackFixes = true;
      else if (verdict === "fail") {
        holdingBackFixes = false;
        warnings.push(
          "The command still fails with the culprits held back: other updates also break it, or the command is flaky.",
        );
      } else {
        warnings.push("Could not check that holding the culprits back makes the command pass.");
      }
    }

    if (interrupted()) {
      return incomplete(
        `Interrupted after narrowing the failure down to ${names.join("; ")}.`,
        culprits,
      );
    }

    // ---- 5. the remedy: a plan that pins the culprits back --------------------------------------
    const remedy = await planRemedy({
      cwd,
      packageManager: manager,
      lockfile,
      culprits,
      goodCommit,
      badCommit,
      command: options.command,
      apply: options.apply === true,
      ...(deps.applyPlanFn ? { applyPlanFn: deps.applyPlanFn } : {}),
    });

    const single = culprits.length === 1;
    const summary = single
      ? `${describeUpdate(culprits[0]!)} breaks the command. Holding it at ${culprits[0]?.fromVersion} ${holdingBackFixes ? "makes it pass" : "is not enough on its own"}.`
      : `These ${culprits.length} updates break the command only together: ${culprits.map((item) => describeUpdate(item)).join("; ")}.`;
    return finish({
      status: single ? "culprit" : "culprit-set",
      summary,
      culprits,
      ...(holdingBackFixes === undefined ? {} : { holdingBackFixes }),
      remedy,
    });
  } finally {
    process.off("exit", exitCleanup);
    await Promise.allSettled(removers.map((remove) => remove()));
    liveRoots.clear();
  }
}
