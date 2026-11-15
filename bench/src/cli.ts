#!/usr/bin/env node
/**
 * pnpm bench [--mode <name>[,<name>]] [--task <id>[,<id>]] [--model <provider:model>] [--keep]
 *            [--write | --no-write] [--list] [--report]
 *
 * Runs the benchmark tasks hermetically (local registry, offline advisory snapshots) and writes
 * `bench/results/<date>-<mode>.json` and `bench/RESULTS.md`. Without `--mode` it runs every mode
 * that needs no key. A run restricted with `--task` is printed but not saved unless `--write`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { applyHermeticEnv, run } from "./exec.ts";
import { DEFAULT_MODES } from "./modes/index.ts";
import { startRegistry } from "./registry.ts";
import { loadResultFiles, renderResults } from "./report.ts";
import { RESULT_SCHEMA_VERSION, summarize, type ResultFile } from "./results.ts";
import { runMode } from "./runner.ts";
import { loadTasks, MODE_NAMES, type LoadedTask, type ModeName } from "./task.ts";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = join(here, "..");
const repoRoot = join(benchDir, "..");
const resultsDir = join(benchDir, "results");

function parseModes(value: string | undefined): ModeName[] {
  if (value === undefined) return [...DEFAULT_MODES];
  return value.split(",").map((name) => {
    const mode = MODE_NAMES.find((candidate) => candidate === name.trim());
    if (!mode) throw new Error(`Unknown mode "${name}". Modes: ${MODE_NAMES.join(", ")}.`);
    return mode;
  });
}

function selectTasks(all: LoadedTask[], filter: string | undefined): LoadedTask[] {
  if (filter === undefined) return all;
  const wanted = filter.split(",").map((id) => id.trim());
  for (const id of wanted) {
    if (!all.some((task) => task.id === id)) {
      throw new Error(`Unknown task "${id}". Tasks: ${all.map((task) => task.id).join(", ")}.`);
    }
  }
  return all.filter((task) => wanted.includes(task.id));
}

async function gitState(): Promise<{ commit: string; dirty: boolean }> {
  const commit = (
    await run("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repoRoot })
  ).stdout.trim();
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoRoot,
  });
  const dirty = status.stdout
    .split("\n")
    .filter(Boolean)
    .some((line) => !/ bench\/(results\/|RESULTS\.md)/.test(line));
  return { commit, dirty };
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      task: { type: "string" },
      model: { type: "string" },
      keep: { type: "boolean", default: false },
      write: { type: "boolean" },
      list: { type: "boolean", default: false },
      report: { type: "boolean", default: false },
    },
    strict: true,
  });

  const allTasks = loadTasks();
  if (values.list) {
    for (const task of allTasks) {
      process.stdout.write(
        `${task.id}\t${task.control ? "control" : task.expect.outcome}\t${task.title}\n`,
      );
    }
    return;
  }
  if (values.report) {
    writeFileSync(join(benchDir, "RESULTS.md"), renderResults(loadResultFiles(resultsDir)));
    process.stdout.write("Regenerated bench/RESULTS.md from bench/results/*.json\n");
    return;
  }

  const modes = parseModes(values.mode);
  const model = values.model ?? undefined;
  if (modes.includes("agent-model") && !model) {
    throw new Error(
      "--mode agent-model needs --model <provider>:<model-id>, plus that provider's API key in the environment.",
    );
  }
  if (modes.includes("agent-model") && modes.length > 1) {
    throw new Error(
      "Run agent-model on its own: it needs the network, and the other modes run with every non-local request blocked.",
    );
  }
  const tasks = selectTasks(allTasks, values.task);
  const partial = values.task !== undefined;
  const save = values.write ?? !partial;

  const workRoot = join(benchDir, ".work", `${Date.now()}`);
  const hermeticEnv = applyHermeticEnv(workRoot, { allowNetwork: modes.includes("agent-model") });
  const registry = await startRegistry();
  const state = await gitState();
  const version = (
    JSON.parse(readFileSync(join(repoRoot, "packages", "core", "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  let harnessProblem = false;

  try {
    log(`registry ${registry.url} (fixtures only, no uplink); work dir ${workRoot}`);
    for (const mode of modes) {
      log(`\n== ${mode}${mode === "agent-model" ? ` (${model ?? ""})` : ""}`);
      const startedAt = new Date();
      const results = await runMode(tasks, mode, {
        workRoot,
        registryUrl: registry.url,
        hermeticEnv,
        ...(model ? { model } : {}),
        keep: values.keep,
        log,
      });
      const summary = summarize(results);
      // A FAIL is a measurement. A task that could not run, or a control the judge let through, means
      // the benchmark itself cannot be trusted, and that is what makes the command fail.
      if (results.some((r) => r.outcome === "error" || (r.control && r.controlCaught !== true))) {
        harnessProblem = true;
      }
      log(
        `  ${summary.pass}/${summary.tasks} PASS (fixed ${summary.byExpected.fixed.pass}/${summary.byExpected.fixed.total}, unresolved ${summary.byExpected.unresolved.pass}/${summary.byExpected.unresolved.total}, refused ${summary.byExpected.refused.pass}/${summary.byExpected.refused.total}); false claims ${summary.falseClaims}; controls caught ${summary.controls.caught}/${summary.controls.total}`,
      );

      if (!save) continue;
      const file: ResultFile = {
        schemaVersion: RESULT_SCHEMA_VERSION,
        mode,
        date: startedAt.toISOString().slice(0, 10),
        startedAt: startedAt.toISOString(),
        commit: state.commit,
        dirty: state.dirty,
        autoremediatorVersion: version,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        ...(mode === "agent-model" && model ? { model } : {}),
        tasks: results,
        summary,
      };
      mkdirSync(resultsDir, { recursive: true });
      const path = join(resultsDir, `${file.date}-${mode}.json`);
      writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
      log(`  wrote ${path.slice(repoRoot.length + 1)}`);
    }
    if (save) {
      writeFileSync(join(benchDir, "RESULTS.md"), renderResults(loadResultFiles(resultsDir)));
      log("\nwrote bench/RESULTS.md");
    } else {
      log("\n(partial run: nothing saved; pass --write to save)");
    }
    if (harnessProblem) {
      process.exitCode = 1;
      log(
        "\nThe benchmark itself has a problem: a task errored or a control was not caught (see above).",
      );
    }
  } finally {
    await registry.close();
    if (!values.keep) rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
