/**
 * Benchmark tasks. A task is a directory under `bench/tasks/<id>/`:
 *
 *   task.json     what it is and what the correct outcome is (validated below)
 *   intel.json    the advisory, in the offline intelligence snapshot format
 *   project/      the consumer project, committed without node_modules or a lockfile
 *   oracle/files/ the known-good repair (project source) for tasks that need one
 *
 * A control task has no project of its own: `base` names the task it reuses, and `control` says how
 * it is deliberately wrong. A control passes the benchmark when it is scored FAIL.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TASKS_DIR = join(here, "..", "tasks");

export const MODE_NAMES = [
  "deterministic",
  "agent-scripted",
  "host-scripted",
  "agent-model",
] as const;
export type ModeName = (typeof MODE_NAMES)[number];

export const OUTCOMES = ["fixed", "unresolved", "refused"] as const;
export type ExpectedOutcome = (typeof OUTCOMES)[number];

const expectSchema = z
  .object({
    outcome: z.enum(OUTCOMES),
    /** The `unresolvedReason` the plan must report (unresolved and refused tasks). */
    reason: z.string().min(1).optional(),
    /** Path prefixes of project source the correct fix may change (default: none). */
    sourceEdits: z.array(z.string().min(1)).default([]),
    /** A file that exists only if an install script ran; its presence fails the task. */
    canary: z.string().min(1).optional(),
  })
  .strict();

const controlSchema = z
  .object({
    kind: z.enum(["false-claim", "weakened-test"]),
    modes: z.array(z.enum(MODE_NAMES)).min(1),
  })
  .strict();

const taskFileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1),
    /** Controls reuse another task's project, advisory and oracle. */
    base: z.string().optional(),
    advisory: z
      .string()
      .regex(/^CVE-\d{4}-\d{1,7}$/)
      .optional(),
    expect: expectSchema,
    control: controlSchema.optional(),
  })
  .strict()
  .refine((task) => (task.control ? task.base !== undefined : task.advisory !== undefined), {
    message: "a task needs an advisory; a control needs a base task",
  });

const intelEntrySchema = z.object({
  packageName: z.string().min(1),
  vulnerableRange: z.string().min(1),
  firstPatchedVersion: z.string().optional(),
});

export interface LoadedTask {
  id: string;
  title: string;
  description: string;
  advisory: string;
  expect: z.infer<typeof expectSchema>;
  control?: z.infer<typeof controlSchema>;
  /** Directory holding project/, intel.json and oracle/ (the base task's, for a control). */
  dir: string;
  projectDir: string;
  intelPath: string;
  /** The vulnerable package and range, read from the advisory snapshot. */
  vulnerable: { packageName: string; vulnerableRange: string };
  /** Relative path -> contents of the known-good repair; empty when the task needs none. */
  oracleFiles: Map<string, string>;
}

function readOracleFiles(dir: string): Map<string, string> {
  const root = join(dir, "oracle", "files");
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).toSorted()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(root, full).split("\\").join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return out;
}

function loadOne(id: string, tasksDir: string, seen: string[] = []): LoadedTask {
  const dir = join(tasksDir, id);
  const taskPath = join(dir, "task.json");
  if (!existsSync(taskPath)) throw new Error(`Unknown task: ${id} (no ${taskPath})`);
  const parsed = taskFileSchema.safeParse(JSON.parse(readFileSync(taskPath, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `Invalid ${taskPath}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  const file = parsed.data;
  if (file.id !== id)
    throw new Error(`${taskPath}: id "${file.id}" does not match its directory "${id}"`);

  if (file.base !== undefined) {
    if (seen.includes(file.base) || file.base === id) throw new Error(`Task ${id}: base cycle`);
    const base = loadOne(file.base, tasksDir, [...seen, id]);
    if (base.control) throw new Error(`Task ${id}: base ${file.base} is itself a control`);
    return {
      ...base,
      id,
      title: file.title,
      description: file.description,
      expect: file.expect,
      ...(file.control ? { control: file.control } : {}),
    };
  }

  const intelPath = join(dir, "intel.json");
  const advisory = file.advisory;
  if (!advisory) throw new Error(`${taskPath}: missing advisory`);
  const intel = JSON.parse(readFileSync(intelPath, "utf8")) as Record<string, unknown>;
  const entry = intelEntrySchema.safeParse(intel[advisory]);
  if (!entry.success) throw new Error(`${intelPath}: no usable entry for ${advisory}`);

  return {
    id,
    title: file.title,
    description: file.description,
    advisory,
    expect: file.expect,
    dir,
    projectDir: join(dir, "project"),
    intelPath,
    vulnerable: {
      packageName: entry.data.packageName,
      vulnerableRange: entry.data.vulnerableRange,
    },
    oracleFiles: readOracleFiles(dir),
  };
}

export function listTaskIds(tasksDir: string = DEFAULT_TASKS_DIR): string[] {
  return readdirSync(tasksDir)
    .filter((entry) => existsSync(join(tasksDir, entry, "task.json")))
    .toSorted();
}

export function loadTasks(tasksDir: string = DEFAULT_TASKS_DIR): LoadedTask[] {
  return listTaskIds(tasksDir).map((id) => loadOne(id, tasksDir));
}

export function loadTask(id: string, tasksDir: string = DEFAULT_TASKS_DIR): LoadedTask {
  return loadOne(id, tasksDir);
}

/** A control runs only in the modes it names; every ordinary task runs in every mode. */
export function appliesTo(task: LoadedTask, mode: ModeName): boolean {
  return task.control ? task.control.modes.includes(mode) : true;
}
