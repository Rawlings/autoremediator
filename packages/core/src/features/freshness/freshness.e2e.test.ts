import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getRun, listRuns, rollbackRun } from "../runs/index.js";
import { freshnessReport } from "./report.js";
import { applyFreshness, planFreshnessStep } from "./step.js";
import { FreshnessRegistry } from "./testing/registry.js";

/**
 * Real git, real npm, a local registry on 127.0.0.1: no network. A project three majors behind on
 * `lib` (whose latest release breaks the project's test) and one minor behind on `other`.
 */

vi.setConfig({ hookTimeout: 60_000 });

let scratch: string;
const registry = new FreshnessRegistry();
const dirs: string[] = [];

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const run = async (cmd: string, args: string[], cwd: string): Promise<string> =>
  (await execa(cmd, args, { cwd, env: { ...process.env, ...GIT_ENV }, all: true })).all ?? "";

const POLICY = "allowMajorBumps: true\nfreshness:\n  maxMajorsBehind: 0\n  maxMinorsBehind: 0\n";
const CHECK = `let lib = {};\ntry { lib = require("lib"); } catch {}\nif (lib.broken) { console.error("lib@" + lib.version + " is broken"); process.exit(1); }\nconsole.log("ok " + lib.version);\n`;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "freshness-e2e-"));
  await registry.start();
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  for (const [version, files] of [
    ["1.0.0", {}],
    ["1.2.0", {}],
    ["2.0.0", {}],
    ["3.0.0", { "index.js": "module.exports = { broken: true, version: '3.0.0' };\n" }],
  ] as const) {
    await registry.publish({
      name: "lib",
      version,
      time: version === "1.0.0" ? old : undefined,
      files: { "index.js": `module.exports = { version: '${version}' };\n`, ...files },
    });
  }
  await registry.publish({ name: "other", version: "1.0.0" });
  await registry.publish({ name: "other", version: "1.1.0" });
});

afterAll(async () => {
  await registry.stop();
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function makeProject(dependencies: Record<string, string>, policy: string): Promise<string> {
  const dir = mkdtempSync(join(scratch, "app-"));
  dirs.push(dir);
  await run("git", ["init", "--quiet", "--initial-branch=main"], dir);
  await run("git", ["config", "user.email", "t@example.test"], dir);
  await run("git", ["config", "user.name", "t"], dir);
  writeFileSync(join(dir, ".npmrc"), `registry=${registry.url}/\n`);
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.autoremediator\n");
  writeFileSync(join(dir, "check.js"), CHECK);
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "autoremediator.yml"), policy);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "app", version: "1.0.0", private: true, scripts: { test: "node check.js" }, dependencies }, null, 2)}\n`,
  );
  await run("npm", ["install", "--no-audit", "--no-fund"], dir);
  await run("git", ["add", "--all"], dir);
  await run("git", ["commit", "--quiet", "-m", "init"], dir);
  return dir;
}

const installed = (dir: string, name: string): string =>
  (
    JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
const ranges = (dir: string): Record<string, string> =>
  (
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    }
  ).dependencies;

describe("freshness against a real project and registry", () => {
  it("reports how far behind each dependency is, from npm outdated and the registry's publish times", async () => {
    const cwd = await makeProject({ lib: "1.0.0", other: "1.0.0" }, POLICY);
    const report = await freshnessReport({ cwd });

    const lib = report.packages.find((entry) => entry.name === "lib")!;
    expect(lib).toMatchObject({
      status: "behind",
      installed: "1.0.0",
      latest: "3.0.0",
      majorsBehind: 2,
      releasesBehind: 3,
      ageDays: 400,
    });
    expect(report.packages.find((entry) => entry.name === "other")).toMatchObject({
      minorsBehind: 1,
      releasesBehind: 1,
    });
    expect(
      report.climbs.map(
        (climb) => `${climb.packageName}: ${climb.steps.map((step) => step.toVersion).join(" > ")}`,
      ),
    ).toEqual(["other: 1.1.0", "lib: 1.2.0 > 2.0.0 > 3.0.0"]);
    expect(report.score).toBe(Math.round(100 - (80 + 5) / 2));

    // With assess, the first step of each climb is rated by the real upgrade analysis on the registry's tarballs.
    const rated = await freshnessReport({ cwd, assess: true });
    expect(rated.climbs.map((climb) => climb.assessment?.breakability)).toEqual(["Low", "Low"]);
  }, 120_000);

  it("climbs in verified steps, one run each, and rolls back the step that breaks the tests", async () => {
    const cwd = await makeProject({ lib: "1.0.0", other: "1.0.0" }, POLICY);
    const result = await applyFreshness({ cwd, maxSteps: 5, runTests: true, allowHigh: true });

    expect(
      result.steps.map(
        (step) =>
          `${step.status}: ${step.step.packageName} ${step.step.fromVersion} -> ${step.step.toVersion}`,
      ),
    ).toEqual([
      "applied: other 1.0.0 -> 1.1.0",
      "applied: lib 1.0.0 -> 1.2.0",
      "applied: lib 1.2.0 -> 2.0.0",
      "failed: lib 2.0.0 -> 3.0.0",
    ]);
    expect(result.status).toBe("partial");

    const failed = result.steps[3]!;
    expect(failed.message).toMatch(/lib@3\.0\.0 is broken|failed/);
    expect(failed.rolledBack).toBe(true);
    expect(result.stopped.map((entry) => entry.packageName)).toEqual(["lib"]);

    // The project is where the last good step left it, on disk and in node_modules.
    expect(ranges(cwd)).toEqual({ lib: "2.0.0", other: "1.1.0" });
    expect(installed(cwd, "lib")).toBe("2.0.0");
    expect(installed(cwd, "other")).toBe("1.1.0");

    // Every step is its own run, and the failed one is closed as rolled back.
    const statuses = Object.fromEntries(
      result.steps.map((step) => [step.runId!, getRun({ cwd, runId: step.runId! }).run.status]),
    );
    expect(Object.values(statuses)).toEqual(["applied", "applied", "applied", "rolled-back"]);
    expect(listRuns({ cwd })).toHaveLength(4);

    // And an applied step can still be undone by itself.
    const second = result.steps[2]!.runId!;
    const undone = await rollbackRun({ cwd, runId: second });
    expect(undone.reinstalled).toBe(true);
    expect(ranges(cwd).lib).toBe("1.2.0");
    expect(installed(cwd, "lib")).toBe("1.2.0");
  }, 240_000);

  it("takes a single step by default, so a scheduled job leaves a small change", async () => {
    const cwd = await makeProject({ lib: "1.0.0", other: "1.0.0" }, POLICY);
    const result = await applyFreshness({ cwd, runTests: true, allowHigh: true });
    expect(result.steps).toHaveLength(1);
    expect(result.remaining.toSorted()).toEqual(["lib"]);
    expect(ranges(cwd)).toEqual({ lib: "1.0.0", other: "1.1.0" });
  }, 120_000);

  it("records a step as a plan that applyPlan carries out with the same verifier", async () => {
    const cwd = await makeProject({ other: "1.0.0" }, POLICY);
    const plan = await planFreshnessStep({ cwd, runTests: true });
    expect(plan.planned?.step).toMatchObject({ packageName: "other", toVersion: "1.1.0" });
    expect(ranges(cwd).other).toBe("1.0.0");

    const { applyPlan } = await import("../runs/index.js");
    const applied = await applyPlan({ cwd, runId: plan.planned!.runId });
    expect(applied.status).toBe("applied");
    expect(ranges(cwd).other).toBe("1.1.0");
    expect(installed(cwd, "other")).toBe("1.1.0");
  }, 120_000);

  it("refuses to apply below L2 and changes nothing", async () => {
    const cwd = await makeProject({ other: "1.0.0" }, `${POLICY}autonomy:\n  ceiling: L1\n`);
    await expect(applyFreshness({ cwd })).rejects.toThrow(/autonomy is L1/);
    expect(ranges(cwd).other).toBe("1.0.0");
    expect(existsSync(join(cwd, ".autoremediator", "runs"))).toBe(false);
  }, 120_000);

  it("opens one change request per step on its own branch and returns to the base branch", async () => {
    const cwd = await makeProject({ other: "1.0.0" }, POLICY);
    const bare = mkdtempSync(join(scratch, "bare-"));
    await run("git", ["init", "--bare", "--quiet", "--initial-branch=main"], bare);
    const remote = "https://gitlab.example.com/group/app.git";
    await run("git", ["config", `url.${bare}.insteadOf`, remote], cwd);
    await run("git", ["remote", "add", "origin", remote], cwd);
    await run("git", ["push", "--quiet", "origin", "main"], cwd);
    for (const [key, value] of Object.entries(GIT_ENV)) vi.stubEnv(key, value);

    const realFetch = globalThis.fetch;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://gitlab.example.com/")) {
        requests.push(url);
        return new Response(
          JSON.stringify({ web_url: "https://gitlab.example.com/group/app/-/merge_requests/1" }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return realFetch(input, init);
    });

    const result = await applyFreshness({
      cwd,
      runTests: true,
      changeRequest: { enabled: true, provider: "gitlab", token: "glpat-test", baseBranch: "main" },
    });

    expect(result.status).toBe("ok");
    const outcome = result.steps[0]!;
    expect(outcome.changeRequest).toMatchObject({
      created: true,
      branchName: "autoremediator/freshness-1.1.0-other",
      url: "https://gitlab.example.com/group/app/-/merge_requests/1",
    });
    expect(requests).toHaveLength(1);

    // The branch is on the remote with the bump; the working tree is back on main as it was.
    await expect(run("git", ["branch", "--list"], bare)).resolves.toContain(
      "autoremediator/freshness-1.1.0-other",
    );
    const onBranch = await run(
      "git",
      ["show", "autoremediator/freshness-1.1.0-other:package.json"],
      bare,
    );
    expect(onBranch).toContain('"other": "1.1.0"');
    const message = await run(
      "git",
      ["log", "-1", "--format=%B", "autoremediator/freshness-1.1.0-other"],
      bare,
    );
    expect(message).toContain("dependency freshness: other 1.0.0 -> 1.1.0");
    expect(message).toContain("Autoremediator-Run: run_");
    expect(message).not.toContain("Fixes-CVE");
    expect((await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim()).toBe("main");
    expect(ranges(cwd).other).toBe("1.0.0");
    expect(installed(cwd, "other")).toBe("1.0.0");
  }, 180_000);
});
