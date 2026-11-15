import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { foldTraceRecords, foldTraceText, parseTraceLines, readTraceFile } from "./fold.js";
import type { TraceRecord } from "./types.js";

const proc = (over: Partial<Extract<TraceRecord, { t: "proc" }>> = {}): TraceRecord => ({
  v: 1,
  t: "proc",
  pid: 1,
  main: true,
  at: "2026-01-01T00:00:00.000Z",
  node: "26.0.0",
  calls: true,
  listed: ["lodash"],
  observes: "hooks",
  ...over,
});

const pkg = (
  name: string,
  over: Partial<Extract<TraceRecord, { t: "pkg" }>> = {},
): TraceRecord => ({
  v: 1,
  t: "pkg",
  name,
  version: "1.0.0",
  entries: ["index.js"],
  dependents: ["(app)"],
  formats: ["cjs"],
  ...over,
});

const calls = (
  name: string,
  counts: Record<string, number>,
  over: Partial<Extract<TraceRecord, { t: "calls" }>> = {},
): TraceRecord => ({
  v: 1,
  t: "calls",
  name,
  version: "1.0.0",
  calls: counts,
  wrapped: Object.keys(counts),
  unwrapped: {},
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("foldTraceRecords", () => {
  it("sums call deltas across processes and flushes", () => {
    const report = foldTraceRecords([
      proc({ pid: 1 }),
      pkg("lodash"),
      calls("lodash", { template: 2 }),
      proc({ pid: 2 }),
      pkg("lodash"),
      calls("lodash", { template: 3, merge: 1 }),
      calls("lodash", { template: 4 }),
    ]);
    expect(report.processes).toBe(2);
    expect(report.packages).toHaveLength(1);
    expect(report.packages[0]?.calls).toEqual({ merge: 1, template: 9 });
  });

  it("unions entries, dependents and formats", () => {
    const report = foldTraceRecords([
      proc(),
      pkg("a", { entries: ["index.js"], dependents: ["(app)"], formats: ["cjs"] }),
      pkg("a", { entries: ["lib/x.js"], dependents: ["b"], formats: ["esm"] }),
    ]);
    expect(report.packages[0]).toMatchObject({
      entries: ["index.js", "lib/x.js"],
      dependents: ["(app)", "b"],
      formats: ["cjs", "esm"],
    });
  });

  it("is independent of record order", () => {
    const records = [
      proc({ pid: 1 }),
      pkg("a"),
      calls("a", { f: 2 }),
      proc({ pid: 2 }),
      pkg("b", { version: "2.0.0" }),
      calls("a", { f: 5, g: 1 }),
    ];
    const forward = foldTraceRecords(records, { createdAt: "x" });
    const backward = foldTraceRecords(records.toReversed(), { createdAt: "x" });
    expect(backward).toEqual(forward);
  });

  it("keeps different versions of one package apart", () => {
    const report = foldTraceRecords([
      proc(),
      pkg("a", { version: "1.0.0" }),
      pkg("a", { version: "2.0.0" }),
      calls("a", { f: 1 }, { version: "2.0.0" }),
    ]);
    expect(report.packages.map((p) => `${p.name}@${p.version}`)).toEqual(["a@1.0.0", "a@2.0.0"]);
    expect(report.packages[0]?.calls).toBeUndefined();
    expect(report.packages[1]?.calls).toEqual({ f: 1 });
  });

  it("keeps a wrapped export that was never called at zero, and the first reason it was skipped", () => {
    const report = foldTraceRecords([
      proc(),
      pkg("a"),
      calls("a", {}, { wrapped: ["never"], unwrapped: { Cls: "class-or-constructor-function" } }),
      calls("a", {}, { unwrapped: { Cls: "another reason" } }),
    ]);
    expect(report.packages[0]?.calls).toEqual({ never: 0 });
    expect(report.packages[0]?.unwrapped).toEqual({ Cls: "class-or-constructor-function" });
  });

  it("reports whether call counting ran and which packages it watched", () => {
    expect(foldTraceRecords([proc({ calls: false, listed: [] }), pkg("a")]).callTracing).toEqual({
      enabled: false,
      packages: [],
    });
    expect(
      foldTraceRecords([proc({ listed: ["b", "a"] }), proc({ listed: ["a", "c"] })]).callTracing,
    ).toEqual({ enabled: true, packages: ["a", "b", "c"] });
  });

  it("flags processes that could only observe CommonJS", () => {
    expect(foldTraceRecords([proc({ observes: "cjs-only" })]).partialEsm).toBe(true);
    expect(foldTraceRecords([proc()]).partialEsm).toBe(false);
  });

  it("reports zero processes for an empty trace", () => {
    expect(foldTraceRecords([]).processes).toBe(0);
  });
});

describe("parsing", () => {
  it("skips and counts lines that are not records, including a torn last line", () => {
    const good = JSON.stringify(proc());
    const { records, skipped } = parseTraceLines(
      `${good}\nnot json\n{"v":2,"t":"proc"}\n${good.slice(0, 10)}`,
    );
    expect(records).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it("folds text and records the command", () => {
    const text = [proc(), pkg("a")].map((r) => JSON.stringify(r)).join("\n");
    const report = foldTraceText(text, { argv: ["node", "x"], exitCode: 0 });
    expect(report.command).toEqual({ argv: ["node", "x"], exitCode: 0 });
    expect(report.packages).toHaveLength(1);
  });
});

describe("readTraceFile", () => {
  function write(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ar-fold-"));
    dirs.push(dir);
    const path = join(dir, "t.json");
    writeFileSync(path, content);
    return path;
  }

  it("reads the raw JSONL the hook writes", () => {
    const path = write(
      [proc(), pkg("a"), calls("a", { f: 1 })].map((r) => JSON.stringify(r)).join("\n"),
    );
    expect(readTraceFile(path).packages[0]?.calls).toEqual({ f: 1 });
  });

  it("reads a folded report, including a single-line one", () => {
    const folded = foldTraceRecords([proc(), pkg("a")]);
    expect(readTraceFile(write(JSON.stringify(folded, null, 2))).packages).toHaveLength(1);
    expect(readTraceFile(write(JSON.stringify(folded))).packages).toHaveLength(1);
  });

  it("refuses a file that is not a trace, naming the file", () => {
    const path = write('{"hello":"world"}');
    expect(() => readTraceFile(path)).toThrow(/is not an Autoremediator trace/);
    expect(() => readTraceFile(join(tmpdir(), "does-not-exist-ar.json"))).toThrow(
      /Cannot read trace file/,
    );
  });
});
