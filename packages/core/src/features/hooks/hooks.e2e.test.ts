import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { installHooks } from "./index.js";

/**
 * Real git, real hooks: a temporary repository with a bare remote, hooks installed by
 * `installHooks`, and a stub `autoremediator` on PATH that records how it was called.
 */

let root: string;
let work: string;
let remote: string;
let stubDir: string;
let log: string;

const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  const result = await execa(file, args, {
    cwd: options.cwd ?? work,
    env: {
      ...GIT_ENV,
      PATH: `${stubDir}${delimiter}${process.env.PATH ?? ""}`,
      STUB_LOG: log,
      STUB_EXIT: "0",
      ...options.env,
    },
    extendEnv: true,
    reject: false,
    stdin: "ignore",
  });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const git = async (
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Run> => {
  const result = await run("git", args, options);
  if (result.exitCode !== 0 && !options.env?.EXPECT_FAILURE)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
};

function put(path: string, text: string, base = work): void {
  const target = join(base, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

async function commit(path: string, text: string, message = "change"): Promise<string> {
  put(path, text);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", message]);
  return (await git(["rev-parse", "HEAD"])).stdout;
}

const calls = (): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "hooks-e2e-"));
  work = join(root, "work");
  remote = join(root, "remote.git");
  stubDir = join(root, "bin");
  log = join(root, "stub.log");
  mkdirSync(work);
  mkdirSync(stubDir);
  // A stand-in CLI: logs its arguments, optionally prints, sleeps, and exits as told.
  const stub = join(stubDir, "autoremediator");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      'echo "$@" >> "$STUB_LOG"',
      '[ -n "$STUB_SLEEP" ] && sleep "$STUB_SLEEP"',
      String.raw`[ -n "$STUB_OUT" ] && printf "%s\n" "$STUB_OUT"`,
      'exit "$STUB_EXIT"',
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);

  await git(["init", "-q", "--bare", "-b", "main", remote], { cwd: root });
  await git(["init", "-q", "-b", "main"]);
  await git(["remote", "add", "origin", remote]);
  put("package.json", '{"name":"x","dependencies":{}}\n');
  put("package-lock.json", '{"lockfileVersion":3}\n');
  put("README.md", "x\n");
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "initial"]);
  await git(["push", "-q", "-u", "origin", "main"]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const DEGRADED = [
  "Delta scan against base: abc",
  "Net Risk Verdict: DEGRADED",
  "Summary: Delta scan against abc found 1 newly introduced vulnerability(ies)",
].join("\n");

describe("pre-push (plain git hook)", () => {
  beforeEach(async () => {
    await installHooks({ cwd: work, yes: true });
  });

  it("does not run the CLI when the push has no manifest or lockfile change", async () => {
    await commit("README.md", "changed\n");
    const push = await git(["push", "origin", "main"]);
    expect(push.exitCode).toBe(0);
    expect(calls()).toEqual([]);
  });

  it("runs diff --ci against the upstream when a lockfile changed, and lets a safe push through", async () => {
    const upstream = (await git(["rev-parse", "origin/main"])).stdout;
    await commit("package-lock.json", '{"lockfileVersion":3,"x":1}\n');
    const push = await git(["push", "origin", "main"], {
      env: { STUB_OUT: "Summary: no new vulnerabilities" },
    });
    expect(push.exitCode).toBe(0);
    expect(calls()).toEqual([`diff --ci --base ${upstream}`]);
    expect(push.stderr).toContain("autoremediator: no new vulnerabilities");
    expect((await git(["rev-parse", "main"])).stdout).toBe(
      (await git(["rev-parse", "main"], { cwd: remote })).stdout,
    );
  });

  it("blocks the push when the diff says the posture is degraded", async () => {
    const head = (await git(["rev-parse", "HEAD"])).stdout;
    await commit("package.json", '{"name":"x","dependencies":{"bad":"1.0.0"}}\n');
    const push = await git(["push", "origin", "main"], {
      env: { STUB_EXIT: "1", STUB_OUT: DEGRADED, EXPECT_FAILURE: "1" },
    });
    expect(push.exitCode).not.toBe(0);
    expect(push.stderr).toContain("push blocked");
    expect(push.stderr).toContain("Net Risk Verdict: DEGRADED");
    expect((await git(["rev-parse", "main"], { cwd: remote })).stdout).toBe(head);
  });

  it("AUTOREMEDIATOR_SKIP_HOOKS=1 skips the check", async () => {
    await commit("package-lock.json", '{"lockfileVersion":3,"x":2}\n');
    const push = await git(["push", "origin", "main"], {
      env: { AUTOREMEDIATOR_SKIP_HOOKS: "1", STUB_EXIT: "1", STUB_OUT: DEGRADED },
    });
    expect(push.exitCode).toBe(0);
    expect(calls()).toEqual([]);
  });

  it("does not block when the CLI fails for another reason", async () => {
    await commit("package-lock.json", '{"lockfileVersion":3,"x":3}\n');
    const failed = await git(["push", "origin", "main"], {
      env: { STUB_EXIT: "1", STUB_OUT: "[autoremediator] boom" },
    });
    expect(failed.exitCode).toBe(0);
    expect(failed.stderr).toContain("could not finish");
    await commit("package-lock.json", '{"lockfileVersion":3,"x":4}\n');
    const crashed = await git(["push", "origin", "main"], { env: { STUB_EXIT: "7" } });
    expect(crashed.exitCode).toBe(0);
    expect(crashed.stderr).toContain("exit 7");
  });

  it("never hangs: a CLI that outlives the time limit is stopped and the push goes through", async () => {
    await commit("package-lock.json", '{"lockfileVersion":3,"x":5}\n');
    const started = Date.now();
    const push = await git(["push", "origin", "main"], {
      env: { STUB_SLEEP: "20", AUTOREMEDIATOR_HOOK_TIMEOUT: "1" },
    });
    expect(push.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(push.stderr).toContain("stopped after 1 seconds");
  });

  it("skips quietly when the CLI is not available (no stub, no npx, nothing global)", async () => {
    await commit("package-lock.json", '{"lockfileVersion":3,"x":6}\n');
    const bare = join(root, "bare-path");
    mkdirSync(bare);
    for (const tool of [
      "git",
      "sh",
      "grep",
      "sed",
      "head",
      "cat",
      "rm",
      "mktemp",
      "sleep",
      "kill",
      "dirname",
      "env",
    ]) {
      const found = (await execa("sh", ["-c", `command -v ${tool}`], { reject: false })).stdout;
      if (found) await execa("ln", ["-s", found, join(bare, tool)], { reject: false });
    }
    const push = await execa("git", ["push", "origin", "main"], {
      cwd: work,
      env: { ...GIT_ENV, PATH: bare },
      extendEnv: false,
      reject: false,
      stdin: "ignore",
    });
    expect(push.exitCode).toBe(0);
    expect(push.stderr).toContain("the CLI is not available");
  });

  it("compares with origin/main when the branch has no upstream yet", async () => {
    const base = (await git(["rev-parse", "origin/main"])).stdout;
    await git(["checkout", "-q", "-b", "feature"]);
    await commit("package-lock.json", '{"lockfileVersion":3,"x":7}\n');
    const push = await git(["push", "origin", "feature"], { env: { STUB_OUT: "Summary: ok" } });
    expect(push.exitCode).toBe(0);
    expect(calls()).toEqual([`diff --ci --base ${base}`]);
  });

  describe("judges what is being pushed, not the checked-out branch", () => {
    const degraded = { STUB_EXIT: "1", STUB_OUT: DEGRADED };

    it("does not block deleting a remote branch while the checked-out branch is degraded", async () => {
      await git(["branch", "other"]);
      await git(["push", "-q", "origin", "other"]);
      await commit("package.json", '{"name":"x","dependencies":{"bad":"1.0.0"}}\n');
      const push = await git(["push", "origin", "--delete", "other"], { env: degraded });
      expect(push.exitCode).toBe(0);
      expect(calls()).toEqual([]);
    });

    it("does not block pushing a tag", async () => {
      await commit("package.json", '{"name":"x","dependencies":{"bad":"1.0.0"}}\n');
      await git(["tag", "v1"]);
      const push = await git(["push", "origin", "v1"], { env: degraded });
      expect(push.exitCode).toBe(0);
      expect(calls()).toEqual([]);
    });

    it("does not judge another branch by the checked-out one", async () => {
      await git(["branch", "other"]);
      await commit("package.json", '{"name":"x","dependencies":{"bad":"1.0.0"}}\n');
      const push = await git(["push", "origin", "other"], { env: degraded });
      expect(push.exitCode).toBe(0);
      expect(calls()).toEqual([]);
      expect(push.stderr).toContain("not the checked-out commit");
    });

    it("compares the pushed commit with what the remote already has, not with the upstream", async () => {
      const remoteTip = (await git(["rev-parse", "origin/main"])).stdout;
      await commit("README.md", "one\n");
      await git(["push", "-q", "origin", "main"]);
      await commit("package-lock.json", '{"lockfileVersion":3,"x":8}\n');
      // The remote-tracking ref is stale on purpose: git passes the remote's real tip on stdin.
      await git(["update-ref", "refs/remotes/origin/main", remoteTip]);
      const pushed = (await git(["rev-parse", "HEAD~1"])).stdout;
      const push = await git(["push", "origin", "main"], { env: { STUB_OUT: "Summary: ok" } });
      expect(push.exitCode).toBe(0);
      expect(calls()).toEqual([`diff --ci --base ${pushed}`]);
    });

    it("still blocks a degraded push of the checked-out branch", async () => {
      await commit("package.json", '{"name":"x","dependencies":{"bad":"1.0.0"}}\n');
      const push = await git(["push", "origin", "main"], {
        env: { ...degraded, EXPECT_FAILURE: "1" },
      });
      expect(push.exitCode).not.toBe(0);
      expect(push.stderr).toContain("push blocked");
    });
  });
});

describe("post-merge (plain git hook)", () => {
  beforeEach(async () => {
    await installHooks({ cwd: work, yes: true });
  });

  async function mergeLockfileChange(env: Record<string, string>): Promise<Run> {
    await git(["checkout", "-q", "-b", "feature"]);
    await commit("package-lock.json", '{"lockfileVersion":3,"merged":true}\n');
    await git(["checkout", "-q", "main"]);
    await commit("README.md", "main moved\n");
    return git(["merge", "--no-edit", "feature"], { env });
  }

  it("prints a one-line advisory when the merge changed a lockfile", async () => {
    const merge = await mergeLockfileChange({
      STUB_OUT: "Summary: Delta scan against ORIG_HEAD found 0 new vulnerabilities",
    });
    expect(merge.exitCode).toBe(0);
    expect(calls()).toEqual(["diff --base ORIG_HEAD"]);
    expect(merge.stderr).toContain(
      "autoremediator: dependencies changed in this merge. Delta scan against ORIG_HEAD found 0 new vulnerabilities",
    );
  });

  it("never fails the merge, even when the CLI does", async () => {
    const merge = await mergeLockfileChange({ STUB_EXIT: "1", STUB_OUT: DEGRADED });
    expect(merge.exitCode).toBe(0);
    expect(merge.stderr).toContain("run 'autoremediator diff --base ORIG_HEAD' to review");
  });

  it("stays silent when the merge did not touch dependencies", async () => {
    await git(["checkout", "-q", "-b", "feature"]);
    await commit("docs.md", "docs\n");
    await git(["checkout", "-q", "main"]);
    await commit("README.md", "main moved\n");
    const merge = await git(["merge", "--no-edit", "feature"]);
    expect(merge.exitCode).toBe(0);
    expect(calls()).toEqual([]);
    expect(merge.stderr).not.toContain("autoremediator");
  });

  it("is skipped with AUTOREMEDIATOR_SKIP_HOOKS=1", async () => {
    const merge = await mergeLockfileChange({ AUTOREMEDIATOR_SKIP_HOOKS: "1" });
    expect(merge.exitCode).toBe(0);
    expect(calls()).toEqual([]);
  });
});

describe("husky layout", () => {
  it("runs the existing script and then the block, under sh -e like husky 9", async () => {
    put(".husky/pre-push", 'echo "existing hook ran" >&2\n');
    await git(["config", "core.hooksPath", ".husky"]);
    const result = await installHooks({ cwd: work, yes: true });
    expect(result.manager).toBe("husky");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "hooks"]);
    await git(["push", "-q", "origin", "main"]);
    const base = (await git(["rev-parse", "origin/main"])).stdout;
    await commit("package.json", '{"name":"x","dependencies":{"a":"1"}}\n');

    const ok = await run("sh", ["-e", ".husky/pre-push"], { env: { PRE_COMMIT_FROM_REF: base } });
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr).toContain("existing hook ran");
    expect(calls()).toEqual([`diff --ci --base ${base}`]);

    const blocked = await run("sh", ["-e", ".husky/pre-push"], {
      env: { PRE_COMMIT_FROM_REF: base, STUB_EXIT: "1", STUB_OUT: DEGRADED },
    });
    expect(blocked.exitCode).toBe(1);

    // Git runs the hook itself when hooksPath is .husky, so a real push is blocked too.
    const push = await git(["push", "origin", "main"], {
      env: { STUB_EXIT: "1", STUB_OUT: DEGRADED, EXPECT_FAILURE: "1" },
    });
    expect(push.exitCode).not.toBe(0);
  });
});

describe("embedded in a hook manager's configuration", () => {
  it("lefthook: the YAML round trip keeps the script working", async () => {
    await installHooks({ cwd: work, yes: true, manager: "lefthook" });
    const config = parseYaml(readFileSync(join(work, "lefthook.yml"), "utf8")) as Record<
      string,
      { commands: { autoremediator: { run: string } } }
    >;
    const script = config["pre-push"]?.commands.autoremediator.run ?? "";
    const base = (await git(["rev-parse", "origin/main"])).stdout;
    await commit("package-lock.json", '{"lockfileVersion":3,"y":1}\n');

    const ok = await run("sh", ["-c", script], { env: { STUB_OUT: "Summary: fine" } });
    expect(ok.exitCode).toBe(0);
    expect(calls()).toEqual([`diff --ci --base ${base}`]);
    const blocked = await run("sh", ["-c", script], {
      env: { STUB_EXIT: "1", STUB_OUT: DEGRADED },
    });
    expect(blocked.exitCode).toBe(1);
  });

  it("pre-commit: runs as `sh -c <args>` and reads PRE_COMMIT_FROM_REF", async () => {
    await installHooks({ cwd: work, yes: true, manager: "pre-commit" });
    const config = parseYaml(readFileSync(join(work, ".pre-commit-config.yaml"), "utf8")) as {
      repos: Array<{ hooks: Array<{ id: string; entry: string; args: string[] }> }>;
    };
    const hook = config.repos[0]?.hooks.find(
      (candidate) => candidate.id === "autoremediator-pre-push",
    );
    expect(hook?.entry).toBe("sh -c");
    const base = (await git(["rev-parse", "HEAD"])).stdout;
    await commit("package.json", '{"name":"x","dependencies":{"z":"1"}}\n');
    const blocked = await run("sh", ["-c", hook?.args[0] ?? ""], {
      env: {
        PRE_COMMIT_FROM_REF: base,
        PRE_COMMIT_TO_REF: "HEAD",
        STUB_EXIT: "1",
        STUB_OUT: DEGRADED,
      },
    });
    expect(blocked.exitCode).toBe(1);
    expect(calls()).toEqual([`diff --ci --base ${base}`]);
    // An all-zero ref (a new branch) falls back to the upstream.
    const zero = await run("sh", ["-c", hook?.args[0] ?? ""], {
      env: {
        PRE_COMMIT_FROM_REF: "0000000000000000000000000000000000000000",
        STUB_OUT: "Summary: fine",
      },
    });
    expect(zero.exitCode).toBe(0);
    expect(calls().at(-1)).toBe(
      `diff --ci --base ${(await git(["rev-parse", "origin/main"])).stdout}`,
    );
  });
});

describe("the built command line", () => {
  const cli = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../dist/surfaces/cli/index.js",
  );

  it.skipIf(!existsSync(cli))(
    "install, status, drift, uninstall: output and exit codes",
    async () => {
      const hook = (args: string[]): Promise<Run> =>
        run("node", [cli, "hook", ...args, "--cwd", work]);

      const plan = await hook(["install"]);
      console.log(
        `$ autoremediator hook install (no --yes, no terminal)\n${plan.stdout}\nexit ${plan.exitCode}\n`,
      );
      expect(plan.exitCode).toBe(3);
      expect(existsSync(join(work, ".git/hooks/pre-push"))).toBe(false);

      const missing = await hook(["status"]);
      console.log(`$ autoremediator hook status\n${missing.stdout}\nexit ${missing.exitCode}\n`);
      expect(missing.exitCode).toBe(1);

      const installed = await hook(["install", "--yes"]);
      console.log(
        `$ autoremediator hook install --yes\n${installed.stdout}\nexit ${installed.exitCode}\n`,
      );
      expect(installed.exitCode).toBe(0);
      expect(existsSync(join(work, ".git/hooks/pre-push"))).toBe(true);

      const ok = await hook(["status"]);
      console.log(`$ autoremediator hook status\n${ok.stdout}\nexit ${ok.exitCode}\n`);
      expect(ok.exitCode).toBe(0);

      put(
        ".git/hooks/post-merge",
        readFileSync(join(work, ".git/hooks/post-merge"), "utf8").replace(
          "autoremediator_post_merge()",
          "autoremediator_edited()",
        ),
      );
      const drift = await hook(["status", "--output-format", "json"]);
      expect(drift.exitCode).toBe(1);
      expect(JSON.parse(drift.stdout)).toMatchObject({
        drift: true,
        hooks: [{ state: "installed" }, { state: "modified" }],
      });

      const bad = await hook(["install", "--hooks", "pre-commit"]);
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr).toContain("Unknown hook: pre-commit");

      const removed = await hook(["uninstall", "--yes"]);
      console.log(
        `$ autoremediator hook uninstall --yes\n${removed.stdout}\nexit ${removed.exitCode}\n`,
      );
      expect(removed.exitCode).toBe(0);
      expect(existsSync(join(work, ".git/hooks/pre-push"))).toBe(false);
      expect((await hook(["status"])).exitCode).toBe(1);
    },
    60_000,
  );
});

describe("the real CLI behind the pre-push hook", () => {
  const cli = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../dist/surfaces/cli/index.js",
  );
  // Needs the built CLI and, to be meaningful, the network (OSV); opt in with AUTOREMEDIATOR_E2E_REAL=1.
  const enabled = existsSync(cli) && process.env.AUTOREMEDIATOR_E2E_REAL === "1";

  it.skipIf(!enabled)(
    "a lockfile change goes through the real `autoremediator diff --ci`",
    async () => {
      writeFileSync(
        join(stubDir, "autoremediator"),
        `#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`,
      );
      await installHooks({ cwd: work, yes: true });
      const lock = (version: string): string =>
        JSON.stringify({
          name: "x",
          lockfileVersion: 3,
          packages: {
            "": { name: "x", dependencies: { lodash: version } },
            "node_modules/lodash": { version },
          },
        });
      put("package.json", '{"name":"x","dependencies":{"lodash":"4.17.21"}}\n');
      await commit("package-lock.json", lock("4.17.21"));
      const push = await git(["push", "origin", "main"], {
        env: { AUTOREMEDIATOR_HOOK_TIMEOUT: "120", EXPECT_FAILURE: "1" },
      });
      console.log(`real CLI push: exit ${push.exitCode}\n${push.stderr}`);
      expect([0, 1]).toContain(push.exitCode);
    },
    150_000,
  );
});
