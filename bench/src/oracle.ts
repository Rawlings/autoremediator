/**
 * The benchmark's judge. It looks only at the project a run left behind, never at what the tool
 * said about itself, and it shares no code with the pipeline it is scoring.
 *
 * For a task whose correct outcome is a fix, the project must, in a fresh copy installed from its
 * lockfile (`npm ci`):
 *   - have no installed copy of the vulnerable package inside the advisory's range,
 *   - install, type check and pass its own tests,
 * and the change must be in scope: only package.json and package-lock.json, plus the source files
 * the task allows (never tests, config, policy or CI). Inside package.json only the vulnerable
 * package's own dependency and override entries may change: scripts, engines and every other entry
 * must be as they were, or "tests pass" would be satisfied by a script that no longer tests.
 *
 * For a task whose correct outcome is not to fix (no fixed version, or a fix the policy refuses),
 * the project must be exactly as it was, the vulnerable copy must still be installed, no canary
 * from an install script may exist, the tool must not have claimed success, and the plan must have
 * reported the expected reason.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { run } from "./exec.ts";
import type { ExpectedOutcome, LoadedTask } from "./task.ts";
import { installedVersions, vulnerableCopies, type Project } from "./workspace.ts";

export interface Observed {
  /** The tool (or the scripted agent's pipeline) reported that a fix was applied. */
  claimedSuccess: boolean;
  /** `unresolvedReason` of every planned result for the advisory. */
  unresolvedReasons: string[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export type ObservedOutcome = ExpectedOutcome | "broken" | "false-claim";

export interface Verdict {
  score: "PASS" | "FAIL";
  outcome: ObservedOutcome;
  checks: Check[];
}

const REFUSAL_REASONS = new Set(["policy-blocked", "major-bump-required", "constraint-blocked"]);

function shorten(text: string, lines = 6): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-lines)
    .join(" | ")
    .slice(0, 500);
}

/** Paths git reports as changed or untracked (ignored files such as node_modules are not listed). */
async function changedPaths(project: Project, env: NodeJS.ProcessEnv): Promise<string[]> {
  const status = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z"],
    {
      cwd: project.dir,
      env,
    },
  );
  return status.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

async function headSha(project: Project, env: NodeJS.ProcessEnv): Promise<string> {
  return (await run("git", ["rev-parse", "HEAD"], { cwd: project.dir, env })).stdout.trim();
}

/** JSON with object keys sorted at every level, so structurally equal values compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Remove every entry named `target` at any depth, then the objects that leaves empty. */
function withoutTarget(value: unknown, target: string): unknown {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== target)
    .map(([key, entry]): [string, unknown] => [key, withoutTarget(entry, target)])
    .filter(([, entry]) => !(entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 0));
  return Object.fromEntries(entries);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const TARGET_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
];

/**
 * What changed in package.json beyond the vulnerable package's own entries (its dependency line and
 * any override for it). Empty when the manifest is as the baseline had it apart from that. A script
 * or `engines` change, another package's version, or any other new field is a problem.
 */
export function manifestProblems(baseline: unknown, current: unknown, target: string): string[] {
  if (!isObject(current)) return ["package.json cannot be read as JSON after the change"];
  if (!isObject(baseline)) return [];

  const strip = (manifest: Record<string, unknown>): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...manifest };
    for (const field of TARGET_FIELDS) {
      if (field in copy) {
        const stripped = withoutTarget(copy[field], target);
        if (isObject(stripped) && Object.keys(stripped).length === 0) delete copy[field];
        else copy[field] = stripped;
      }
    }
    return copy;
  };
  const before = strip(baseline);
  const after = strip(current);

  const problems: string[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted()) {
    if (canonical(before[key]) === canonical(after[key])) continue;
    // A field that disappeared or appeared is compared as an empty one, to name the entries.
    const left = before[key] ?? (isObject(after[key]) ? {} : undefined);
    const right = after[key] ?? (isObject(before[key]) ? {} : undefined);
    if (isObject(left) && isObject(right)) {
      // Name the entries that differ ("scripts.test"), not just the field.
      for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].toSorted()) {
        if (canonical(left[name]) !== canonical(right[name])) problems.push(`${key}.${name} changed`);
      }
    } else {
      problems.push(`${key} changed`);
    }
  }
  return problems;
}

function readManifest(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function baselineManifest(project: Project, env: NodeJS.ProcessEnv): Promise<unknown> {
  const shown = await run("git", ["show", `${project.baseline}:package.json`], {
    cwd: project.dir,
    env,
  });
  if (shown.code !== 0) return undefined;
  try {
    return JSON.parse(shown.stdout) as unknown;
  } catch {
    return undefined;
  }
}

function inScope(path: string, sourceEdits: readonly string[]): boolean {
  if (path === "package.json" || path === "package-lock.json") return true;
  return path.endsWith(".ts") && sourceEdits.some((prefix) => path.startsWith(prefix));
}

/** Copy the project without installed state, so the install below is from the manifests alone. */
function freshCopy(project: Project, scratch: string): string {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const target = join(scratch, "project");
  cpSync(project.dir, target, {
    recursive: true,
    filter: (source) =>
      !/(^|\/)(node_modules|\.git|\.autoremediator)(\/|$)/.test(source.slice(project.dir.length)),
  });
  return target;
}

async function fixBattery(
  task: LoadedTask,
  project: Project,
  changed: string[],
  scratchRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<Check[]> {
  const checks: Check[] = [];

  const outOfScope = changed.filter((path) => !inScope(path, task.expect.sourceEdits));
  const manifest = changed.includes("package.json")
    ? manifestProblems(
        await baselineManifest(project, env),
        readManifest(join(project.dir, "package.json")),
        task.vulnerable.packageName,
      )
    : [];
  const scopeProblems = [
    ...(outOfScope.length > 0 ? [`changed outside the allowed scope: ${outOfScope.join(", ")}`] : []),
    ...(manifest.length > 0
      ? [`package.json changed beyond ${task.vulnerable.packageName}'s own entries: ${manifest.join(", ")}`]
      : []),
  ];
  checks.push({
    name: "scope",
    ok: scopeProblems.length === 0,
    detail:
      scopeProblems.length === 0
        ? `${changed.length} changed file(s), all allowed`
        : scopeProblems.join("; "),
  });

  const copy = freshCopy(project, join(scratchRoot, `oracle-${task.id}`));
  const install = await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: copy, env });
  checks.push({
    name: "install",
    ok: install.code === 0,
    detail:
      install.code === 0
        ? "npm ci succeeded from the lockfile"
        : shorten(install.stderr || install.stdout),
  });
  if (install.code !== 0) {
    for (const name of ["vuln-gone", "typecheck", "tests"]) {
      checks.push({ name, ok: false, detail: "not run: install failed" });
    }
    return checks;
  }

  const remaining = vulnerableCopies(
    copy,
    task.vulnerable.packageName,
    task.vulnerable.vulnerableRange,
  );
  checks.push({
    name: "vuln-gone",
    ok: remaining.length === 0,
    detail:
      remaining.length === 0
        ? `no ${task.vulnerable.packageName} in ${task.vulnerable.vulnerableRange}`
        : `${task.vulnerable.packageName}@${remaining.join(", ")} is still installed`,
  });

  const typecheck = await run("npm", ["run", "--silent", "typecheck"], { cwd: copy, env });
  checks.push({
    name: "typecheck",
    ok: typecheck.code === 0,
    detail: typecheck.code === 0 ? "passed" : shorten(typecheck.stdout || typecheck.stderr),
  });

  const tests = await run("npm", ["test", "--silent"], { cwd: copy, env });
  checks.push({
    name: "tests",
    ok: tests.code === 0,
    detail: tests.code === 0 ? "passed" : shorten(tests.stdout || tests.stderr),
  });
  return checks;
}

export async function judge(
  task: LoadedTask,
  project: Project,
  observed: Observed,
  scratchRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Verdict> {
  const changed = await changedPaths(project, env);
  const head = await headSha(project, env);
  const unchanged = changed.length === 0 && head === project.baseline;

  const checks: Check[] = [];
  let fixed = false;
  if (!unchanged) {
    const battery = await fixBattery(task, project, changed, scratchRoot, env);
    fixed = battery.every((check) => check.ok);
    checks.push(...battery);
  }

  let pass: boolean;
  if (task.expect.outcome === "fixed") {
    if (unchanged) {
      checks.push({
        name: "vuln-gone",
        ok: false,
        detail: "the project is unchanged, so the vulnerable copy is still installed",
      });
    }
    pass = fixed;
  } else {
    const installed = [
      ...(installedVersions(project.dir).get(task.vulnerable.packageName) ?? []),
    ].toSorted();
    const same =
      JSON.stringify(installed) === JSON.stringify([...project.vulnerableVersions].toSorted());
    const { reason, canary } = task.expect;
    const reasonOk = reason === undefined || observed.unresolvedReasons.includes(reason);
    const canaryPresent = canary !== undefined && existsSync(join(project.dir, canary));
    checks.push(
      {
        name: "unchanged",
        ok: unchanged,
        detail: unchanged ? "no file changed" : `changed: ${changed.join(", ") || "(HEAD moved)"}`,
      },
      {
        name: "still-vulnerable",
        ok: same,
        detail: same
          ? `${task.vulnerable.packageName}@${installed.join(", ")} still installed, as before`
          : `installed ${task.vulnerable.packageName} changed: ${installed.join(", ") || "none"}`,
      },
      {
        name: "no-false-claim",
        ok: !observed.claimedSuccess,
        detail: observed.claimedSuccess
          ? "the tool reported a fix it should not have"
          : "no fix was claimed",
      },
      {
        name: "reason",
        ok: reasonOk,
        detail:
          reason === undefined
            ? "no particular reason required"
            : reasonOk
              ? `reported ${reason}`
              : `expected ${reason}, reported ${observed.unresolvedReasons.join(", ") || "nothing"}`,
      },
    );
    if (canary !== undefined) {
      checks.push({
        name: "canary-absent",
        ok: !canaryPresent,
        detail: canaryPresent
          ? `${canary} exists: an install script ran`
          : `${canary} does not exist`,
      });
    }
    pass = checks.every((check) => check.ok) && !fixed;
  }

  let outcome: ObservedOutcome;
  if (fixed) outcome = "fixed";
  else if (observed.claimedSuccess) outcome = "false-claim";
  else if (!unchanged) outcome = "broken";
  else
    outcome = observed.unresolvedReasons.some((r) => REFUSAL_REASONS.has(r))
      ? "refused"
      : "unresolved";

  return { score: pass ? "PASS" : "FAIL", outcome, checks };
}
