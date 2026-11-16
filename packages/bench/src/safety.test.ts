import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BENCH_WORK_DIR, run } from "./exec.ts";
import {
  assertContainedWorkRoot,
  isSecretEnvName,
  SANDBOXED_TEST_SCRIPT,
  scrubbedEnv,
} from "./safety.ts";
import { packDirectory } from "./tarball.ts";
import { NPMRC } from "./workspace.ts";

const made: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project with one test file and an optional dependency; returns the script's exit code and output. */
async function runSandboxed(testBody: string, outsideFile?: string) {
  const dir = scratch("bench-sandbox-");
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(dir, "node_modules", "dep", "package.json"),
    '{"name":"dep","version":"1.0.0"}',
  );
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "exports.answer = () => 42;\n");
  writeFileSync(
    join(dir, "test", "a.test.ts"),
    `import { test } from "node:test";\nimport { createRequire } from "node:module";\n${testBody}\n`,
  );
  const done = await run("sh", ["-c", SANDBOXED_TEST_SCRIPT], { cwd: dir });
  const result = { code: done.code, output: done.stdout + done.stderr };
  return { ...result, escaped: outsideFile !== undefined && existsSync(outsideFile) };
}

describe("the sandboxed test script", () => {
  it("lets a test read the project and load its dependencies", async () => {
    const result = await runSandboxed(
      `const dep = createRequire(import.meta.url)("dep") as { answer: () => number };\n` +
        `test("loads", () => { if (dep.answer() !== 42) throw new Error("wrong"); });`,
    );
    expect(result.code).toBe(0);
  });

  it("blocks writing a file, even beside the project", async () => {
    const outside = join(scratch("bench-outside-"), "written");
    const result = await runSandboxed(
      `import { writeFileSync } from "node:fs";\ntest("write", () => writeFileSync(${JSON.stringify(outside)}, "x"));`,
      outside,
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("ERR_ACCESS_DENIED");
    expect(result.escaped).toBe(false);
  });

  it("blocks starting a process", async () => {
    const result = await runSandboxed(
      `import { execSync } from "node:child_process";\ntest("spawn", () => { execSync("echo hi"); });`,
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("ERR_ACCESS_DENIED");
  });

  it("blocks the network", async () => {
    const result = await runSandboxed(
      `import { connect } from "node:net";\n` +
        `test("net", () => new Promise((resolve, reject) => { const s = connect(9, "127.0.0.1"); s.on("error", reject); s.on("connect", resolve); }));`,
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("ERR_ACCESS_DENIED");
  });

  it("blocks reading outside the project", async () => {
    const secret = join(scratch("bench-secret-"), "secret.txt");
    writeFileSync(secret, "hunter2");
    const result = await runSandboxed(
      `import { readFileSync } from "node:fs";\ntest("read", () => readFileSync(${JSON.stringify(secret)}, "utf8"));`,
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("ERR_ACCESS_DENIED");
  });
});

describe("assertContainedWorkRoot", () => {
  const allowed = () => [tmpdir(), BENCH_WORK_DIR];

  it("accepts a new directory inside the temp directory or the bench work directory", () => {
    expect(() =>
      assertContainedWorkRoot(join(tmpdir(), "bench-new", "run"), allowed()),
    ).not.toThrow();
    expect(() => assertContainedWorkRoot(join(BENCH_WORK_DIR, "123"), allowed())).not.toThrow();
  });

  it.each([["/"], [homedir()], [join(homedir(), "Documents", "x")], ["/etc/bench"]])(
    "refuses %s",
    (path) => {
      expect(() => assertContainedWorkRoot(path, allowed())).toThrow(/Refusing/);
    },
  );

  it("refuses the allowed parents themselves and a path that climbs out of them", () => {
    expect(() => assertContainedWorkRoot(tmpdir(), allowed())).toThrow(/Refusing/);
    expect(() => assertContainedWorkRoot(join(tmpdir(), "..", "elsewhere"), allowed())).toThrow(
      /Refusing/,
    );
  });

  it("refuses a directory that reaches outside through a symlink", () => {
    const base = scratch("bench-link-");
    const target = scratch("bench-link-target-");
    symlinkSync(realpathSync(target), join(base, "out"));
    expect(() => assertContainedWorkRoot(join(base, "out", "run"), [base])).toThrow(/Refusing/);
  });
});

describe("environment scrub", () => {
  it("drops credentials and keeps everything else", () => {
    const clean = scrubbedEnv({
      PATH: "/usr/bin",
      npm_config_cache: "/c",
      HTTP_PROXY: "http://127.0.0.1:9",
      GITHUB_TOKEN: "x",
      NPM_TOKEN: "x",
      ANTHROPIC_API_KEY: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      DB_PASSWORD: "x",
      AUTOREMEDIATOR_JWT_SECRET: "x",
    });
    expect(Object.keys(clean).toSorted()).toEqual(["HTTP_PROXY", "PATH", "npm_config_cache"]);
    expect(isSecretEnvName("NODE_AUTH_TOKEN")).toBe(true);
  });

  it("applies to every child the benchmark starts", async () => {
    const dir = scratch("bench-env-");
    const result = await run("node", ["-p", "String(process.env.BENCH_TEST_SECRET_TOKEN)"], {
      cwd: dir,
      env: { ...process.env, BENCH_TEST_SECRET_TOKEN: "leaked" },
    });
    expect(result.stdout.trim()).toBe("undefined");
  });
});

describe("install scripts", () => {
  it("never run: the project's .npmrc turns them off unless the task is a trap", () => {
    expect(NPMRC("http://127.0.0.1:1")).toContain("ignore-scripts=true");
    expect(NPMRC("http://127.0.0.1:1", { ignoreScripts: false })).not.toContain("ignore-scripts");
  });

  it("do not fire when installing with the flag the harness passes", async () => {
    const dir = scratch("bench-canary-");
    const dependency = join(dir, "dep");
    mkdirSync(dependency);
    const canary = join(dir, "CANARY");
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "canary-dep",
        version: "1.0.0",
        scripts: {
          postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(canary)},'ran')"`,
        },
      }),
    );
    writeFileSync(join(dir, "canary-dep-1.0.0.tgz"), packDirectory(dependency).data);
    const project = join(dir, "app");
    mkdirSync(project);
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "canary-dep": "file:../canary-dep-1.0.0.tgz" },
      }),
    );
    const cache = join(dir, "cache");
    const userConfig = join(dir, "user.npmrc");
    writeFileSync(userConfig, "");
    const result = await run(
      "npm",
      ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
      {
        cwd: project,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: dir,
          npm_config_cache: cache,
          NPM_CONFIG_USERCONFIG: userConfig,
        },
      },
    );
    expect([result.code, result.code === 0 ? "" : result.stderr]).toEqual([0, ""]);
    expect(existsSync(canary)).toBe(false);
    expect(readFileSync(join(project, "package-lock.json"), "utf8")).toContain("canary-dep");
  });
});
