import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DataFormatError } from "../../shared/errors.js";
import { newRunId } from "./ids.js";
import { Ledger } from "./ledger.js";
import { RunStore } from "./run-store.js";

const dirs: string[] = [];
const project = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "run-schemas-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = { dirty: false, filesSha256: "abc" };

describe("run state read from disk", () => {
  it("reads back what it wrote", () => {
    const store = new RunStore(project());
    const created = store.create({ cwd: "/x", cveIds: ["CVE-2024-0001"], base });
    expect(store.load(created.runId)).toEqual(created);
  });

  it("names the file and the field when a run record is damaged", () => {
    const store = new RunStore(project());
    const { runId } = store.create({ cwd: "/x", cveIds: [], base });
    store.writeJson(runId, "run.json", { schemaVersion: 1, runId, status: "sideways" });
    expect(() => store.load(runId)).toThrow(DataFormatError);
    expect(() => store.load(runId)).toThrow(/run\.json is not in the expected format at status/);
  });

  it("lists the healthy runs and skips the damaged one", () => {
    const store = new RunStore(project());
    const good = store.create({ cwd: "/x", cveIds: [], base });
    const bad = store.create({ cwd: "/x", cveIds: [], base });
    writeFileSync(join(store.runDir(bad.runId), "run.json"), "{not json");
    expect(store.list().map((run) => run.runId)).toEqual([good.runId]);
  });

  it("refuses a ledger line that is not a step event", () => {
    const dir = project();
    const file = join(dir, "steps.jsonl");
    writeFileSync(file, `${JSON.stringify({ seq: "one" })}\n`);
    expect(() => new Ledger(file).read()).toThrow(/steps\.jsonl is not in the expected format/);
  });

  it("reports a missing run with a stable code", () => {
    const store = new RunStore(project());
    let thrown: unknown;
    try {
      store.load(newRunId());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "run-not-found",
      message: expect.stringMatching(/Run not found/),
    });
  });
});
