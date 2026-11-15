/**
 * Runs tasks in a mode: materialize the project, let the mode act on it, then have the oracle judge
 * what is left. One registry serves the whole run.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

import { run } from "./exec.ts";
import { weakenedTest } from "./modes/controls.ts";
import { MODES } from "./modes/index.ts";
import type { ModeContext, ModeOutcome } from "./modes/types.ts";
import { judge, type Verdict } from "./oracle.ts";
import type { TaskResult } from "./results.ts";
import { appliesTo, type LoadedTask, type ModeName } from "./task.ts";
import { materialize } from "./workspace.ts";

export interface RunnerEnv {
  /** Everything for this invocation lives under here. */
  workRoot: string;
  registryUrl: string;
  hermeticEnv: Record<string, string>;
  model?: string;
  keep: boolean;
  log: (line: string) => void;
}

/** A fixture that is not healthy at baseline would make every result meaningless, so check it. */
async function assertHealthyBaseline(
  task: LoadedTask,
  dir: string,
  vulnerable: string[],
): Promise<void> {
  if (vulnerable.length === 0) {
    throw new Error(
      `${task.id}: baseline has no ${task.vulnerable.packageName} inside ${task.vulnerable.vulnerableRange}; the task would test nothing`,
    );
  }
  for (const script of ["typecheck", "test"]) {
    const result = await run("npm", ["run", "--silent", script], { cwd: dir });
    if (result.code !== 0) {
      throw new Error(
        `${task.id}: baseline ${script} fails before any change:\n${(result.stdout || result.stderr).slice(-600)}`,
      );
    }
  }
}

function controlCaught(task: LoadedTask, verdict: Verdict): boolean {
  if (verdict.score !== "FAIL") return false;
  if (task.control?.kind !== "weakened-test") return true;
  // Only the scope rule may fail: type check and tests must have passed, or the control proves less.
  const failed = verdict.checks.filter((check) => !check.ok).map((check) => check.name);
  return failed.length === 1 && failed[0] === "scope";
}

export async function runTask(
  task: LoadedTask,
  modeName: ModeName,
  env: RunnerEnv,
): Promise<TaskResult> {
  const workDir = join(env.workRoot, modeName, task.id);
  const base = {
    id: task.id,
    title: task.title,
    control: task.control !== undefined,
    expected: task.expect.outcome,
  } as const;

  try {
    const project = await materialize(task, workDir, env.registryUrl);
    await assertHealthyBaseline(task, project.dir, project.vulnerableVersions);

    const context: ModeContext = {
      task,
      project,
      workDir,
      registryUrl: env.registryUrl,
      hermeticEnv: env.hermeticEnv,
      ...(env.model ? { model: env.model } : {}),
    };

    const started = Date.now();
    const outcome: ModeOutcome =
      task.control?.kind === "weakened-test"
        ? await weakenedTest(context)
        : await MODES[modeName].run(context);
    const durationMs = Date.now() - started;

    const verdict = await judge(
      task,
      project,
      { claimedSuccess: outcome.claimedSuccess, unresolvedReasons: outcome.unresolvedReasons },
      join(workDir, "oracle"),
    );
    return {
      ...base,
      outcome: verdict.outcome,
      score: verdict.score,
      ...(task.control ? { controlCaught: controlCaught(task, verdict) } : {}),
      durationMs,
      steps: outcome.steps,
      pipelineClaimedSuccess: outcome.claimedSuccess,
      ...(outcome.agentClaimedSuccess === undefined
        ? {}
        : { agentClaimedSuccess: outcome.agentClaimedSuccess }),
      ...(outcome.tokens ? { tokens: outcome.tokens } : {}),
      checks: verdict.checks,
      notes: outcome.notes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      outcome: "error",
      score: "FAIL",
      ...(task.control ? { controlCaught: false } : {}),
      durationMs: 0,
      steps: 0,
      pipelineClaimedSuccess: false,
      checks: [],
      notes: [],
      error: message.slice(0, 1500),
    };
  } finally {
    if (!env.keep) rmSync(workDir, { recursive: true, force: true });
  }
}

export async function runMode(
  tasks: readonly LoadedTask[],
  modeName: ModeName,
  env: RunnerEnv,
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const task of tasks.filter((candidate) => appliesTo(candidate, modeName))) {
    const result = await runTask(task, modeName, env);
    env.log(
      `  ${result.score === "PASS" ? "PASS" : "FAIL"}  ${task.id.padEnd(28)} ${result.outcome.padEnd(12)} ${(result.durationMs / 1000).toFixed(1)}s${result.control ? (result.controlCaught ? "  (control caught)" : "  (CONTROL NOT CAUGHT)") : ""}${result.error ? `\n        ${result.error.split("\n")[0]}` : ""}`,
    );
    results.push(result);
  }
  return results;
}
