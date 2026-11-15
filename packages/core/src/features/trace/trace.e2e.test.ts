/**
 * End-to-end: real node processes run a fixture project with fake installed packages, with the
 * built trace hook injected. Needs `pnpm build` first, like the MCP server and hook tests.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { writeTraceFixture } from "../../../test/trace-fixture.js";
import { readTraceFile } from "./fold.js";
import type { TracePackage } from "./types.js";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HOOK = join(CORE, "dist/features/trace/register.js");
const WATCH = "cjs-fn,cjs-obj,cjs-class,cjs-frozen,cjs-getter,cjs-never,@scope/esm-pkg";

// Each test starts real processes, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

let project: string;
let counter = 0;

beforeAll(() => {
  if (!existsSync(HOOK)) {
    throw new Error(`Trace hook build artifact not found at ${HOOK}. Run pnpm build first.`);
  }
  project = mkdtempSync(join(tmpdir(), "ar-trace-e2e-"));
  writeTraceFixture(project);
  // Lets the tests load the hook by its published name, `autoremediator/trace`.
  symlinkSync(CORE, join(project, "node_modules/autoremediator"), "dir");
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
  trace: string;
}

function node(args: string[], env: Record<string, string | undefined> = {}, cwd = project): Run {
  const trace = join(project, `trace-${String(counter++)}.jsonl`);
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", AUTOREMEDIATOR_TRACE_FILE: trace, ...env },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, trace };
}

const hooked = (script: string, calls = true, extra: Record<string, string> = {}): Run =>
  node(["--import", HOOK, script], {
    AUTOREMEDIATOR_TRACE_PACKAGES: WATCH,
    ...(calls ? { AUTOREMEDIATOR_TRACE_CALLS: "1" } : {}),
    ...extra,
  });

function plain(script: string): Run {
  const result = spawnSync(process.execPath, [script], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, trace: "" };
}

const byName = (packages: TracePackage[], name: string): TracePackage => {
  const found = packages.find((pkg) => pkg.name === name);
  if (!found) throw new Error(`${name} not in trace: ${packages.map((p) => p.name).join(", ")}`);
  return found;
};

describe("the hook does not change what the program does", () => {
  for (const script of ["main.cjs", "main.mjs"]) {
    it(`${script}: same stdout, stderr and exit code with call counting on`, () => {
      const baseline = plain(script);
      const traced = hooked(script);
      expect(baseline.status).toBe(0);
      expect(traced.status).toBe(baseline.status);
      expect(traced.stdout).toBe(baseline.stdout);
      expect(traced.stderr).toBe("");
      expect(baseline.stderr).toBe("");
    });
  }

  it("keeps instanceof, new, new.target, identity and static private fields intact", () => {
    const result = JSON.parse(hooked("main.cjs").stdout) as { cls: unknown[] };
    // [instanceof, getter, static factory instanceof, factory field, private next x2, private
    //  peek, abstract guard message, subclass instanceof, prototype identity, constructor identity]
    expect(result.cls).toEqual([true, 4, true, 3, 1, 2, 2, "abstract", true, true, true]);
  });

  it("does nothing without AUTOREMEDIATOR_TRACE_FILE", () => {
    const result = node(["--import", HOOK, "main.cjs"], { AUTOREMEDIATOR_TRACE_FILE: "" });
    expect(result.stdout).toBe(plain("main.cjs").stdout);
    expect(existsSync(result.trace)).toBe(false);
  });

  it("fails open when the trace file cannot be written", () => {
    const result = hooked("main.cjs", true, {
      AUTOREMEDIATOR_TRACE_FILE: join(project, "no-such-dir", "trace.jsonl"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(plain("main.cjs").stdout);
    expect(result.stderr).toBe("");
  });

  it("preserves the program's own exit code and error output", () => {
    writeFileSync(join(project, "exits.cjs"), `require("cjs-obj"); process.exit(7);`);
    writeFileSync(join(project, "throws.cjs"), `require("cjs-obj"); throw new Error("boom");`);
    expect(hooked("exits.cjs").status).toBe(7);
    const thrown = hooked("throws.cjs");
    const reference = plain("throws.cjs");
    expect(thrown.status).toBe(reference.status);
    expect(thrown.stderr.split("\n")[0]).toBe(reference.stderr.split("\n")[0]);
    // The exit code does not stop the trace being written.
    expect(byName(readTraceFile(hooked("exits.cjs").trace).packages, "cjs-obj").entries).toEqual([
      "index.js",
    ]);
  });
});

describe("CommonJS", () => {
  it("records packages, versions, entry points and who loaded them", () => {
    const report = readTraceFile(hooked("main.cjs").trace);
    expect(report.packages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      "cjs-class@3.1.0",
      "cjs-fn@1.2.3",
      "cjs-frozen@1.0.0",
      "cjs-getter@1.0.0",
      "cjs-inner@1.4.0",
      "cjs-obj@2.0.0",
      "cjs-outer@1.0.0",
    ]);
    expect(byName(report.packages, "cjs-obj")).toMatchObject({
      entries: ["index.js"],
      dependents: ["(app)"],
      formats: ["cjs"],
    });
    // cjs-inner is only ever required by cjs-outer.
    expect(byName(report.packages, "cjs-inner").dependents).toEqual(["cjs-outer"]);
    expect(report.processes).toBe(1);
    expect(report.partialEsm).toBe(false);
  });

  it("does not record a package that was never loaded", () => {
    const report = readTraceFile(hooked("main.cjs").trace);
    expect(report.packages.some((pkg) => pkg.name === "cjs-never")).toBe(false);
    const withNever = readTraceFile(hooked("main.cjs", true, { USE_NEVER: "1" }).trace);
    expect(withNever.packages.some((pkg) => pkg.name === "cjs-never")).toBe(true);
  });

  it("counts calls to function, object and getter exports by name", () => {
    const report = readTraceFile(hooked("main.cjs").trace);
    expect(byName(report.packages, "cjs-fn").calls).toEqual({ default: 2, helper: 1 });
    const obj = byName(report.packages, "cjs-obj");
    // obj.add(1, 2) once directly and once through this.add() inside self().
    expect(obj.calls).toMatchObject({ add: 2, self: 1 });
    expect(obj.calls?.mul).toBeUndefined();
    expect(byName(report.packages, "cjs-getter").calls).toEqual({ lazy: 1, plain: 1 });
  });

  it("leaves classes alone and says so", () => {
    const cls = byName(readTraceFile(hooked("main.cjs").trace).packages, "cjs-class");
    expect(cls.unwrapped).toEqual({
      Base: "class-or-constructor-function",
      Guarded: "class-or-constructor-function",
      Widget: "class-or-constructor-function",
    });
    expect(cls.calls).toEqual({});
  });

  it("leaves frozen exports alone and says so", () => {
    const frozen = byName(readTraceFile(hooked("main.cjs").trace).packages, "cjs-frozen");
    expect(frozen.unwrapped).toEqual({ frozenFn: "frozen-export" });
    expect(frozen.calls).toEqual({});
  });

  it("records no call data when call counting is off", () => {
    const report = readTraceFile(hooked("main.cjs", false).trace);
    expect(report.callTracing.enabled).toBe(false);
    expect(report.packages.every((pkg) => pkg.calls === undefined)).toBe(true);
    expect(report.packages.length).toBeGreaterThan(0);
  });

  it("counts only the packages it is asked to watch", () => {
    const run = node(["--import", HOOK, "main.cjs"], {
      AUTOREMEDIATOR_TRACE_PACKAGES: "cjs-fn",
      AUTOREMEDIATOR_TRACE_CALLS: "1",
    });
    const report = readTraceFile(run.trace);
    expect(byName(report.packages, "cjs-fn").calls).toEqual({ default: 2, helper: 1 });
    expect(byName(report.packages, "cjs-obj").calls).toBeUndefined();
  });
});

describe("ES modules", () => {
  it("records the package, its format and counts exports, re-exports and aliases", () => {
    const report = readTraceFile(hooked("main.mjs").trace);
    const esm = byName(report.packages, "@scope/esm-pkg");
    expect(esm).toMatchObject({ version: "4.5.6", entries: ["index.js"], formats: ["esm"] });
    expect(esm.calls).toMatchObject({ esmFn: 1, default: 1, libFn: 1, renamed: 1, aliased: 1 });
    // Never called, but visible through `export *`.
    expect(esm.calls?.hidden).toBe(0);
  });

  it("reports what it cannot count instead of guessing", () => {
    const esm = byName(readTraceFile(hooked("main.mjs").trace).packages, "@scope/esm-pkg");
    expect(esm.unwrapped).toEqual({
      EsmWidget: "class-or-constructor-function",
      esmConst: "const-binding",
    });
  });

  it("counts named and default imports from CommonJS packages", () => {
    const report = readTraceFile(hooked("main.mjs").trace);
    expect(byName(report.packages, "cjs-fn").calls?.default).toBe(1);
    expect(byName(report.packages, "cjs-obj").calls).toMatchObject({ add: 1, mul: 1 });
    expect(byName(report.packages, "cjs-obj").formats).toEqual(["cjs"]);
  });

  it("does not instrument ES modules unless asked to count calls", () => {
    const run = hooked("main.mjs", false);
    expect(run.stdout).toBe(plain("main.mjs").stdout);
    expect(byName(readTraceFile(run.trace).packages, "@scope/esm-pkg").calls).toBeUndefined();
  });
});

describe("how the hook is loaded", () => {
  it("works with --require (CommonJS preload)", () => {
    const run = node(["--require", HOOK, "main.cjs"], {
      AUTOREMEDIATOR_TRACE_PACKAGES: "cjs-obj",
      AUTOREMEDIATOR_TRACE_CALLS: "1",
    });
    expect(run.stdout).toBe(plain("main.cjs").stdout);
    expect(byName(readTraceFile(run.trace).packages, "cjs-obj").calls?.self).toBe(1);
  });

  it("works through NODE_OPTIONS and the published name autoremediator/trace", () => {
    const run = node(["main.mjs"], { NODE_OPTIONS: "--import autoremediator/trace" });
    expect(run.stdout).toBe(plain("main.mjs").stdout);
    expect(run.stderr).toBe("");
    expect(readTraceFile(run.trace).packages.map((pkg) => pkg.name)).toContain("@scope/esm-pkg");

    const required = node(["--require", "autoremediator/trace", "main.cjs"]);
    expect(required.stderr).toBe("");
    expect(readTraceFile(required.trace).packages.map((pkg) => pkg.name)).toContain("cjs-fn");
  });
});

describe("several processes and threads", () => {
  it("folds appends from child processes and worker threads into one trace", () => {
    mkdirSync(join(project, "multi"), { recursive: true });
    writeFileSync(
      join(project, "multi/child.cjs"),
      `const o = require("cjs-obj"); for (let i = 0; i < 5; i++) o.add(i, 1);`,
    );
    writeFileSync(
      join(project, "multi/parent.cjs"),
      `
const { spawnSync } = require("node:child_process");
const { Worker } = require("node:worker_threads");
for (let i = 0; i < 3; i++) spawnSync(process.execPath, [require("node:path").join(__dirname, "child.cjs")], { stdio: "inherit" });
const w = new Worker(require("node:path").join(__dirname, "child.cjs"));
w.on("exit", () => console.log("done"));
`,
    );
    const run = node(["multi/parent.cjs"], {
      NODE_OPTIONS: `--import ${new URL(`file://${HOOK}`).href}`,
      AUTOREMEDIATOR_TRACE_PACKAGES: "cjs-obj",
      AUTOREMEDIATOR_TRACE_CALLS: "1",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("done\n");
    const report = readTraceFile(run.trace);
    // parent + 3 children + 1 worker thread.
    expect(report.processes).toBe(5);
    expect(report.skippedLines).toBe(0);
    expect(byName(report.packages, "cjs-obj").calls?.add).toBe(20);
  });
});
