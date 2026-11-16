/**
 * The results file format and the numbers derived from it. A results file is the only record of a
 * benchmark run: `bench/RESULTS.md` is generated from these files and nothing else, and the guard
 * test recomputes every summary from the per-task rows and every row's verdict from its checks, so a
 * number that was not measured cannot be written by hand.
 */
import { z } from "zod";

import { DIMENSION_IDS, MODE_NAMES, OUTCOMES } from "./task.ts";

export const RESULT_SCHEMA_VERSION = 2;

const checkSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().optional(),
});

export const taskResultSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    /** A control is deliberately wrong and passes the benchmark by being scored FAIL. */
    control: z.boolean(),
    /** Where the task comes from: a published package and advisory, or a purpose-built fixture. */
    origin: z.enum(["corpus", "harness"]),
    dimension: z.enum(DIMENSION_IDS),
    expected: z.enum(OUTCOMES),
    outcome: z.enum([...OUTCOMES, "broken", "false-claim", "error"]),
    score: z.enum(["PASS", "FAIL"]),
    /** Controls only: scored FAIL for the intended reason. */
    controlCaught: z.boolean().optional(),
    durationMs: z.number().int().nonnegative(),
    /** Model turns (agent modes) or MCP tool calls (host mode); 0 where no agent is involved. */
    steps: z.number().int().nonnegative(),
    /** Files the run changed in the project (0 when it left the project alone). */
    changedFiles: z.number().int().nonnegative(),
    /** The pipeline or host reported that a fix was applied. */
    pipelineClaimedSuccess: z.boolean(),
    /** An agent told the verifier it was done (agent modes only). */
    agentClaimedSuccess: z.boolean().optional(),
    /** Real token counts; present only when a real model ran. Scripted modes never report tokens. */
    tokens: z
      .object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
      .optional(),
    checks: z.array(checkSchema),
    notes: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict();

export type TaskResult = z.infer<typeof taskResultSchema>;

const countSchema = z.object({
  pass: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const summarySchema = z
  .object({
    tasks: z.number().int().nonnegative(),
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    byExpected: z.object({ fixed: countSchema, unresolved: countSchema, refused: countSchema }),
    falseClaims: z.number().int().nonnegative(),
    controls: z.object({
      total: z.number().int().nonnegative(),
      caught: z.number().int().nonnegative(),
    }),
    totalDurationMs: z.number().int().nonnegative(),
  })
  .strict();

export type Summary = z.infer<typeof summarySchema>;

export const resultFileSchema = z
  .object({
    schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
    mode: z.enum(MODE_NAMES),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "not a date"),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    dirty: z.boolean(),
    autoremediatorVersion: z.string().min(1),
    node: z.string().min(1),
    platform: z.string().min(1),
    /** The model spec, for `agent-model` only. */
    model: z.string().optional(),
    tasks: z.array(taskResultSchema).min(1),
    summary: summarySchema,
  })
  .strict()
  .superRefine((file, ctx) => {
    const expected = summarize(file.tasks);
    if (JSON.stringify(expected) !== JSON.stringify(file.summary)) {
      ctx.addIssue({ code: "custom", message: "summary does not match the task rows" });
    }
    const ids = file.tasks.map((task) => task.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "duplicate task id" });
    for (const task of file.tasks) {
      if (task.tokens && file.mode !== "agent-model") {
        ctx.addIssue({
          code: "custom",
          message: `${task.id}: scripted modes cannot report tokens`,
        });
      }
      // A row's verdict is not free text: it must follow from its own checks, so editing `score`
      // alone (the summary is recomputed from it) cannot turn a failure into a pass.
      if (!task.control) {
        const allOk = task.checks.length > 0 && task.checks.every((check) => check.ok);
        if ((task.score === "PASS") !== allOk) {
          ctx.addIssue({
            code: "custom",
            message: `${task.id}: PASS needs every check to be ok (and at least one check), and a row whose checks all passed cannot be FAIL`,
          });
        }
        if (task.score === "PASS" && task.outcome !== task.expected) {
          ctx.addIssue({
            code: "custom",
            message: `${task.id}: a PASS must have the expected outcome (${task.expected}), not ${task.outcome}`,
          });
        }
      } else if (task.controlCaught === true && task.score !== "FAIL") {
        ctx.addIssue({
          code: "custom",
          message: `${task.id}: a control marked caught must have been scored FAIL`,
        });
      }
      if (task.control && task.controlCaught === undefined) {
        ctx.addIssue({ code: "custom", message: `${task.id}: a control needs controlCaught` });
      }
      if (task.outcome === "error" && task.error === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${task.id}: an error outcome needs an error message`,
        });
      }
    }
    if (file.mode === "agent-model" && !file.model) {
      ctx.addIssue({ code: "custom", message: "agent-model results must name the model" });
    }
  });

export type ResultFile = z.infer<typeof resultFileSchema>;

/** Every number in a summary, computed from the rows. */
export function summarize(tasks: readonly TaskResult[]): Summary {
  const scored = tasks.filter((task) => !task.control);
  const controls = tasks.filter((task) => task.control);
  const by = (expected: (typeof OUTCOMES)[number]) => {
    const rows = scored.filter((task) => task.expected === expected);
    return { pass: rows.filter((task) => task.score === "PASS").length, total: rows.length };
  };
  const pass = scored.filter((task) => task.score === "PASS").length;
  return {
    tasks: scored.length,
    pass,
    fail: scored.length - pass,
    byExpected: { fixed: by("fixed"), unresolved: by("unresolved"), refused: by("refused") },
    falseClaims: scored.filter((task) => task.outcome === "false-claim").length,
    controls: {
      total: controls.length,
      caught: controls.filter((task) => task.controlCaught === true).length,
    },
    totalDurationMs: tasks.reduce((sum, task) => sum + task.durationMs, 0),
  };
}
