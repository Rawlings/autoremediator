/**
 * Guard tests for the committed results. They are what stops a hand-edited number, a stale table or
 * a benchmark that quietly stopped catching its own controls from being merged.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { latestPerMode, loadResultFiles, renderResults } from "./report.ts";
import { resultFileSchema, summarize, type ResultFile, type TaskResult } from "./results.ts";
import { appliesTo, loadTasks } from "./task.ts";

const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(benchDir, "results");

const row = (over: Partial<TaskResult> = {}): TaskResult => ({
  id: "01-x",
  title: "x",
  control: false,
  expected: "fixed",
  outcome: "fixed",
  score: "PASS",
  durationMs: 1200,
  steps: 0,
  pipelineClaimedSuccess: true,
  checks: [{ name: "tests", ok: true }],
  notes: [],
  ...over,
});

function file(tasks: TaskResult[], over: Partial<ResultFile> = {}): ResultFile {
  return {
    schemaVersion: 1,
    mode: "deterministic",
    date: "2026-01-02",
    startedAt: "2026-01-02T10:00:00.000Z",
    commit: "abcdef123456",
    dirty: false,
    autoremediatorVersion: "0.0.0",
    node: "v26.0.0",
    platform: "linux x64",
    tasks,
    summary: summarize(tasks),
    ...over,
  };
}

describe("results file format", () => {
  it("accepts a well-formed file", () => {
    expect(resultFileSchema.safeParse(file([row()])).success).toBe(true);
  });

  it("rejects a summary that was not computed from the rows", () => {
    const good = file([row(), row({ id: "02-y", score: "FAIL", outcome: "unresolved" })]);
    const edited = { ...good, summary: { ...good.summary, pass: 2, fail: 0 } };
    const parsed = resultFileSchema.safeParse(edited);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/summary does not match/);
  });

  it("rejects token counts from a scripted mode, which has no real tokens to count", () => {
    const parsed = resultFileSchema.safeParse(file([row({ tokens: { input: 10, output: 5 } })]));
    expect(parsed.success).toBe(false);
  });

  it("accepts tokens only for a real model run that names the model", () => {
    const tasks = [row({ tokens: { input: 10, output: 5 } })];
    expect(resultFileSchema.safeParse(file(tasks, { mode: "agent-model" })).success).toBe(false);
    expect(
      resultFileSchema.safeParse(file(tasks, { mode: "agent-model", model: "anthropic:x" }))
        .success,
    ).toBe(true);
  });

  it("requires controls to say whether they were caught, errors to say why, and ids to be unique", () => {
    expect(resultFileSchema.safeParse(file([row({ control: true })])).success).toBe(false);
    expect(
      resultFileSchema.safeParse(file([row({ outcome: "error", score: "FAIL" })])).success,
    ).toBe(false);
    expect(resultFileSchema.safeParse(file([row(), row()])).success).toBe(false);
  });

  it("ties each row's score to its checks: PASS only when every check is ok", () => {
    // The summary is recomputed from the edited row, so only the row-level rule can catch this.
    const forged = file([row({ checks: [{ name: "tests", ok: false, detail: "1 failed" }] })]);
    const parsed = resultFileSchema.safeParse(forged);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/PASS needs every check to be ok/);

    // And the reverse: a FAIL whose checks all passed was edited down.
    const lowered = file([row({ score: "FAIL" })]);
    expect(resultFileSchema.safeParse(lowered).success).toBe(false);
  });

  it("does not take a PASS with no checks, or a PASS whose outcome is not the expected one", () => {
    expect(resultFileSchema.safeParse(file([row({ checks: [] })])).success).toBe(false);
    expect(resultFileSchema.safeParse(file([row({ outcome: "broken" })])).success).toBe(false);
    expect(
      resultFileSchema.safeParse(
        file([row({ outcome: "error", score: "FAIL", checks: [], error: "x" })]),
      ).success,
    ).toBe(true);
    expect(
      resultFileSchema.safeParse(file([row({ outcome: "error", score: "PASS", error: "x" })]))
        .success,
    ).toBe(false);
  });

  it("does not take a control marked caught while it passed", () => {
    const control = row({ id: "ctl", control: true, controlCaught: true, outcome: "false-claim" });
    expect(resultFileSchema.safeParse(file([control])).success).toBe(false);
    expect(
      resultFileSchema.safeParse(
        file([{ ...control, score: "FAIL", checks: [{ name: "vuln-gone", ok: false }] }]),
      ).success,
    ).toBe(true);
  });

  it("rejects fields it does not know", () => {
    const withExtra = { ...file([row()]), invented: 1 };
    expect(resultFileSchema.safeParse(withExtra).success).toBe(false);
  });

  it("keeps controls out of the pass counts", () => {
    const summary = summarize([
      row(),
      row({ id: "ctl", control: true, score: "FAIL", controlCaught: true, outcome: "false-claim" }),
    ]);
    expect(summary).toMatchObject({
      tasks: 1,
      pass: 1,
      fail: 0,
      controls: { total: 1, caught: 1 },
      falseClaims: 0,
    });
  });
});

describe("committed results", () => {
  const loaded = loadResultFiles(resultsDir);
  const tasks = loadTasks();

  it("exist, and are well-formed (loading throws on a malformed file)", () => {
    expect(loaded.length).toBeGreaterThan(0);
    const modes = new Set(latestPerMode(loaded).map((entry) => entry.result.mode));
    expect(modes.has("deterministic")).toBe(true);
    expect(modes.has("agent-scripted")).toBe(true);
    expect(modes.has("host-scripted")).toBe(true);
  });

  it.each(loaded.map((entry) => [entry.file, entry.result] as const))(
    "%s covers every task for its mode, and the benchmark was sound when it ran",
    (_name, result) => {
      if (result.mode === "agent-model") return; // a real-model run may cover a subset of tasks
      const expectedIds = tasks
        .filter((task) => appliesTo(task, result.mode))
        .map((task) => task.id);
      expect(result.tasks.map((task) => task.id)).toEqual(expectedIds);

      // The controls are the proof that the judge catches false success; a file where one got
      // through, or where a task could not run at all, says nothing about the tool.
      for (const task of result.tasks) {
        expect(task.outcome, `${task.id} errored: ${task.error ?? ""}`).not.toBe("error");
        if (task.control) expect(task.controlCaught, `${task.id} was not caught`).toBe(true);
      }
    },
  );

  it("never reports a PASS for a task whose oracle checks failed", () => {
    for (const { file: name, result } of loaded) {
      for (const task of result.tasks.filter((candidate) => !candidate.control)) {
        if (task.score === "PASS") {
          expect(
            task.checks.every((check) => check.ok),
            `${name}: ${task.id}`,
          ).toBe(true);
        }
      }
    }
  });

  it("agree with bench/RESULTS.md, which is generated from them", () => {
    expect(readFileSync(join(benchDir, "RESULTS.md"), "utf8")).toBe(renderResults(loaded));
  });
});
