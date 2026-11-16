/**
 * `pnpm bench:corpus`: build and check the corpus. This is the only part of the benchmark
 * that touches the network, and only to read public data from the npm registry and OSV.
 *
 *   advisory <id> --package <name>   store a published OSV record (malware and withdrawn ones are refused)
 *   fetch <task-id> [--snapshot-date <iso>]   store the published packages and tarballs a task's project needs
 *   freeze <task-id>                 write the task's intel.json from the advisory it cites
 *   restore                          download every pinned tarball that is not cached yet, verified
 *   verify [--require-cache]         check everything committed against corpus/lock.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_TASKS_DIR } from "../task.ts";
import { curateProject, restoreCorpus } from "./curate.ts";
import { fetchBytes, fetchJson, osvUrl } from "./fetch.ts";
import { freezeTask, readAdvisory } from "./freeze.ts";
import { readLock } from "./lock.ts";
import { assertAdmissible, fixedVersionsOf, osvSchema } from "./osv.ts";
import { ADVISORY_DIR } from "./paths.ts";
import { verifyCorpus } from "./verify.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    package: { type: "string" },
    "snapshot-date": { type: "string" },
    "require-cache": { type: "boolean", default: false },
  },
});
const log = (line: string): void => void process.stdout.write(`${line}\n`);
const [command, target] = positionals;

async function main(): Promise<number> {
  if (command === "advisory" && target) {
    if (!values.package) throw new Error("advisory needs --package <name>");
    const record = osvSchema.parse(await fetchJson(fetchBytes, osvUrl(target)));
    assertAdmissible(record, values.package);
    mkdirSync(ADVISORY_DIR, { recursive: true });
    writeFileSync(join(ADVISORY_DIR, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    log(`stored ${record.id} (${record.aliases.join(", ")}): ${record.summary ?? ""}`);
    return 0;
  }
  if (command === "fetch" && target) {
    const task = JSON.parse(readFileSync(join(DEFAULT_TASKS_DIR, target, "task.json"), "utf8")) as {
      baseline?: { before?: string };
      package: string;
      osv: string;
    };
    const fixed = fixedVersionsOf(readAdvisory(task.osv), task.package);
    await curateProject(join(DEFAULT_TASKS_DIR, target, "project"), {
      snapshotDate: values["snapshot-date"] ?? readLock()?.snapshotDate ?? new Date().toISOString(),
      ...(task.baseline?.before ? { before: task.baseline.before } : {}),
      mustKeep: new Map([[task.package, fixed]]),
      get: fetchBytes,
      log,
    });
    return 0;
  }
  if (command === "freeze" && target) {
    freezeTask(join(DEFAULT_TASKS_DIR, target));
    log(`wrote ${target}/intel.json`);
    return 0;
  }
  if (command === "restore") {
    await restoreCorpus({ get: fetchBytes, log });
    return 0;
  }
  if (command === "verify") {
    const report = verifyCorpus({
      requireCache: values["require-cache"],
      tasksDir: DEFAULT_TASKS_DIR,
    });
    for (const problem of report.problems) log(`PROBLEM ${problem}`);
    log(
      `${report.versions} pinned versions, ${report.uncached} not cached, ${report.problems.length} problems`,
    );
    return report.problems.length === 0 ? 0 : 1;
  }
  log(
    "usage: bench:corpus advisory <id> --package <name> | fetch <task> | freeze <task> | restore | verify [--require-cache]",
  );
  return 2;
}

process.exitCode = await main().catch((error: unknown) => {
  log(`error: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
