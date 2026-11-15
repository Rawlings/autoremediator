/**
 * End-to-end through the built CLI and SDK: `autoremediator trace run`, `traceRun`, and
 * `checkReachability` with the trace they produce. Needs `pnpm build` first.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { writeTraceFixture } from "../../../test/trace-fixture.js";
import type { TraceReport } from "./types.js";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = join(CORE, "dist/surfaces/cli/index.js");
const SDK = pathToFileURL(join(CORE, "dist/api/index.js")).href;

// Each test starts real processes, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

let project: string;

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`CLI build artifact not found at ${CLI}. Run pnpm build first.`);
  }
  project = mkdtempSync(join(tmpdir(), "ar-trace-cli-"));
  writeTraceFixture(project);
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

function cli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

const readTrace = (path = ".autoremediator/trace.json"): TraceReport =>
  JSON.parse(readFileSync(join(project, path), "utf8")) as TraceReport;

describe("autoremediator trace run", () => {
  it("runs the project's tests with node --test, traces the test processes and keeps the exit code", () => {
    const run = cli(["trace", "run", "--packages", "cjs-obj", "--calls", "--", "node", "--test"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("uses cjs-obj");
    expect(run.stdout).toContain("Traced: node --test (exit 0");
    expect(run.stdout).toContain("cjs-obj@2.0.0: add x1");
    expect(run.stdout).toContain("Trace written to .autoremediator/trace.json");
    const report = readTrace();
    expect(report.command).toEqual({ argv: ["node", "--test"], exitCode: 0 });
    expect(report.packages.map((pkg) => pkg.name)).toEqual(["cjs-obj"]);
    expect(report.packages[0]?.calls).toEqual({ add: 1 });
  });

  it("accepts the command without -- when options come first", () => {
    const run = cli(["trace", "run", "--out", "t2.json", "node", "main.cjs"]);
    expect(run.status).toBe(0);
    expect(readTrace("t2.json").packages.length).toBeGreaterThan(5);
  });

  it("returns the traced command's exit code and still writes the trace", () => {
    const run = cli([
      "trace",
      "run",
      "--out",
      "t3.json",
      "--",
      "node",
      "-e",
      "require('cjs-fn'); process.exit(7)",
    ]);
    expect(run.status).toBe(7);
    const report = readTrace("t3.json");
    expect(report.command?.exitCode).toBe(7);
    expect(report.packages.map((pkg) => pkg.name)).toEqual(["cjs-fn"]);
  });

  it("prints a JSON result on stdout alone, moving the command's output to stderr", () => {
    const run = cli([
      "trace",
      "run",
      "--output-format",
      "json",
      "--out",
      "t4.json",
      "--",
      "node",
      "main.cjs",
    ]);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { exitCode: number; report: TraceReport };
    expect(parsed.exitCode).toBe(0);
    expect(parsed.report.packages.length).toBeGreaterThan(5);
    expect(run.stderr).toContain('"transitive":"inner"');
  });

  it("traces a command that is not node, through the processes it starts", () => {
    const run = cli([
      "trace",
      "run",
      "--out",
      "t5.json",
      "--",
      "sh",
      "-c",
      "node main.cjs > /dev/null",
    ]);
    expect(run.status).toBe(0);
    expect(readTrace("t5.json").processes).toBe(1);
  });

  it("says so when no process loaded the hook", () => {
    const run = cli(["trace", "run", "--out", "t6.json", "--", "sh", "-c", "true"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("No process reported to the trace hook");
    expect(readTrace("t6.json").processes).toBe(0);
  });

  it("fails loudly on --calls without --packages and on a command that does not exist", () => {
    const noPackages = cli(["trace", "run", "--calls", "--", "node", "main.cjs"]);
    expect(noPackages.status).not.toBe(0);
    expect(noPackages.stderr).toContain("Counting calls needs the packages to watch");
    const missing = cli(["trace", "run", "--", "definitely-not-a-command-ar"]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Could not run");
  });
});

describe("traceRun SDK", () => {
  it("returns the folded report, exit code and captured output", async () => {
    const sdk = (await import(/* @vite-ignore */ SDK)) as typeof import("../../api/index.js");
    const result = await sdk.traceRun({
      command: ["node", "main.mjs"],
      cwd: project,
      packages: ["@scope/esm-pkg"],
      calls: true,
      out: "sdk-trace.json",
    });
    expect(result.exitCode).toBe(0);
    expect(result.traceFile).toBe(join(project, "sdk-trace.json"));
    expect(JSON.parse(result.stdout ?? "{}")).toHaveProperty("esm");
    const esm = result.report.packages.find((pkg) => pkg.name === "@scope/esm-pkg");
    expect(esm?.calls).toMatchObject({ esmFn: 1, libFn: 1 });
  });

  it("validates its input", async () => {
    const sdk = (await import(/* @vite-ignore */ SDK)) as typeof import("../../api/index.js");
    await expect(sdk.traceRun({ command: [] })).rejects.toThrow(/needs a command/);
    await expect(sdk.traceRun({ command: ["node"], packages: ["a b"] })).rejects.toThrow(
      /Invalid package name/,
    );
  });
});

describe("reachability with a trace", () => {
  it("combines the static scan with runtime evidence from a trace of this project", () => {
    // Static scan of the fixture: nothing under the project root references cjs-never or cjs-obj
    // in a way a call graph can see for `unused`, but the trace did load cjs-obj.
    cli([
      "trace",
      "run",
      "--packages",
      "cjs-obj",
      "--calls",
      "--out",
      "reach.json",
      "--",
      "node",
      "main.cjs",
    ]);

    const called = JSON.parse(
      cli([
        "reachability",
        "--package",
        "cjs-obj",
        "--symbol",
        "add",
        "--trace-file",
        "reach.json",
        "--output-format",
        "json",
      ]).stdout,
    ) as {
      status: string;
      evidenceKind: string;
      runtime: { verdict: string; calls: { count: number } };
    };
    expect(called.evidenceKind).toBe("both");
    expect(called.runtime.verdict).toBe("called-in-tests");
    expect(called.runtime.calls.count).toBe(2);

    const notCalled = JSON.parse(
      cli([
        "reachability",
        "--package",
        "cjs-obj",
        "--symbol",
        "unused",
        "--trace-file",
        "reach.json",
        "--output-format",
        "json",
      ]).stdout,
    ) as { runtime: { verdict: string } };
    expect(notCalled.runtime.verdict).toBe("loaded-not-called-in-tests");

    const never = JSON.parse(
      cli([
        "reachability",
        "--package",
        "cjs-never",
        "--trace-file",
        "reach.json",
        "--output-format",
        "json",
      ]).stdout,
    ) as { runtime: { verdict: string; caveat: string } };
    expect(never.runtime.verdict).toBe("not-loaded-in-tests");
    expect(never.runtime.caveat).toMatch(/not proof/);
  });

  it("promotes a static not-reachable to reachable when the trace saw the call, and keeps the static answer", () => {
    cli([
      "trace",
      "run",
      "--packages",
      "cjs-obj",
      "--calls",
      "--out",
      "promote.json",
      "--",
      "node",
      "main.cjs",
    ]);
    const withoutTrace = JSON.parse(
      cli(["reachability", "--package", "cjs-obj", "--symbol", "self", "--output-format", "json"])
        .stdout,
    ) as { status: string };
    // The static scan cannot follow `const obj = require("cjs-obj"); obj.self()`.
    expect(withoutTrace.status).toBe("not-reachable");

    const promoted = JSON.parse(
      cli([
        "reachability",
        "--package",
        "cjs-obj",
        "--symbol",
        "self",
        "--trace-file",
        "promote.json",
        "--output-format",
        "json",
      ]).stdout,
    ) as {
      status: string;
      staticStatus: string;
      reachabilityBasis: string;
      justification?: string;
      evidenceKind: string;
    };
    expect(promoted).toMatchObject({
      status: "reachable",
      staticStatus: "not-reachable",
      reachabilityBasis: "runtime-call-observed",
      evidenceKind: "both",
    });
    expect(promoted.justification).toBeUndefined();
  });

  it("never turns a static reachable into not-reachable, whatever the trace says", () => {
    cli([
      "trace",
      "run",
      "--packages",
      "cjs-obj",
      "--calls",
      "--out",
      "never.json",
      "--",
      "node",
      "-e",
      "1",
    ]);
    const result = JSON.parse(
      cli([
        "reachability",
        "--package",
        "cjs-obj",
        "--symbol",
        "add",
        "--trace-file",
        "never.json",
        "--output-format",
        "json",
      ]).stdout,
    ) as { status: string; runtime: { verdict: string } };
    expect(result.status).toBe("reachable");
    expect(result.runtime.verdict).toBe("not-loaded-in-tests");
  });

  it("is unchanged without a trace, apart from naming its evidence as static", () => {
    const plain = JSON.parse(
      cli(["reachability", "--package", "cjs-obj", "--output-format", "json"]).stdout,
    ) as { evidenceKind: string; runtime?: unknown; staticStatus?: unknown };
    expect(plain.evidenceKind).toBe("static");
    expect(plain.runtime).toBeUndefined();
    expect(plain.staticStatus).toBeUndefined();
  });

  it("refuses a trace file that is not a trace", () => {
    writeFileSync(join(project, "bad.json"), "{}");
    const run = cli(["reachability", "--package", "cjs-obj", "--trace-file", "bad.json"]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("is not an Autoremediator trace");
  });
});
