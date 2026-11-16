/**
 * Guard tests for the committed results. They are what stops a hand-edited number, a stale table or
 * a benchmark that quietly stopped catching its own controls from being merged.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readLock } from "./corpus/lock.ts";
import {
  loadResultFiles,
  renderReadmeBlock,
  renderReport,
  withReadmeBlock,
} from "./report/index.ts";
import { sliceOf } from "./report/metrics.ts";
import { resultFileSchema, summarize, type ResultFile, type TaskResult } from "./results.ts";
import { appliesTo, loadTasks } from "./task.ts";

const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(benchDir, "results");
const readmePath = join(benchDir, "..", "..", "README.md");

const row = (over: Partial<TaskResult> = {}): TaskResult => ({
  id: "01-x",
  title: "x",
  control: false,
  origin: "corpus",
  dimension: "patch-bump",
  expected: "fixed",
  outcome: "fixed",
  score: "PASS",
  durationMs: 1200,
  steps: 0,
  changedFiles: 2,
  pipelineClaimedSuccess: true,
  checks: [{ name: "tests", ok: true }],
  notes: [],
  ...over,
});

function file(tasks: TaskResult[], over: Partial<ResultFile> = {}): ResultFile {
  return {
    schemaVersion: 2,
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
  const input = () => {
    const snapshotDate = readLock()?.snapshotDate;
    return { results: loaded, tasks, ...(snapshotDate ? { snapshotDate } : {}) };
  };

  it("exist, one file per mode named <mode>.json, and are well-formed", () => {
    expect(loaded.length).toBeGreaterThan(0);
    const modes = new Set(loaded.map((entry) => entry.result.mode));
    expect(modes.has("deterministic")).toBe(true);
    expect(modes.has("agent-scripted")).toBe(true);
    expect(modes.has("host-scripted")).toBe(true);
    expect(loaded.map((entry) => entry.file)).toEqual(
      loaded.map((entry) => `${entry.result.mode}.json`),
    );
  });

  it.each(loaded.map((entry) => [entry.file, entry.result] as const))(
    "%s covers every task for its mode, and the benchmark was sound when it ran",
    (_name, result) => {
      if (result.mode === "agent-model") return; // a model run may cover a subset of tasks
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

  it("never report a PASS for a task whose oracle checks failed", () => {
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

  it("agree with every generated page, and leave no stale one behind", () => {
    const pages = renderReport(input());
    for (const [path, text] of pages) {
      const committed = existsSync(join(benchDir, path))
        ? readFileSync(join(benchDir, path), "utf8")
        : undefined;
      expect({ path, matches: committed === text }).toEqual({ path, matches: true });
    }
    const files = readdirSync(resultsDir).filter((name) => name.endsWith(".md"));
    expect(files.map((name) => `results/${name}`).toSorted()).toEqual(
      [...pages.keys()].filter((path) => path.startsWith("results/")).toSorted(),
    );
  });

  it("agree with the figures quoted in the repository README", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(withReadmeBlock(readme, renderReadmeBlock(input()))).toBe(readme);
  });
});

describe("headline figures", () => {
  const rows = [
    row({ id: "a", changedFiles: 2 }),
    row({ id: "b", changedFiles: 4 }),
    row({ id: "c", expected: "unresolved", outcome: "unresolved", changedFiles: 0 }),
    row({
      id: "d",
      score: "FAIL",
      outcome: "unresolved",
      changedFiles: 0,
      checks: [{ name: "vuln-gone", ok: false }],
    }),
    row({
      id: "e",
      score: "FAIL",
      outcome: "false-claim",
      changedFiles: 1,
      checks: [{ name: "tests", ok: false }],
    }),
  ];

  it("count fixes, honest refusals, false claims and broken projects separately", () => {
    expect(sliceOf(rows)).toMatchObject({
      tasks: 5,
      correct: 3,
      fixExpected: 4,
      fixCorrect: 2,
      holdExpected: 1,
      holdCorrect: 1,
      falseClaims: 1,
      leftBroken: 1,
      medianFixFiles: 3,
    });
  });

  it("have no median when nothing was fixed", () => {
    expect(
      sliceOf(rows.filter((candidate) => candidate.id === "d")).medianFixFiles,
    ).toBeUndefined();
  });
});

describe("the repository README block", () => {
  it("is replaced between its markers and nowhere else", () => {
    const readme = "before\n<!-- benchmark:start -->\nold\n<!-- benchmark:end -->\nafter\n";
    expect(withReadmeBlock(readme, "<!-- benchmark:start -->\nnew\n<!-- benchmark:end -->")).toBe(
      "before\n<!-- benchmark:start -->\nnew\n<!-- benchmark:end -->\nafter\n",
    );
  });

  it("refuses a README without the markers instead of guessing where to write", () => {
    expect(() => withReadmeBlock("no markers here", "x")).toThrow(/needs <!-- benchmark:start -->/);
  });
});
