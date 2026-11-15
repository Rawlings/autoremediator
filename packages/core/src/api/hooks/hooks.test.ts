import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { getOperation } from "../../catalog/index.js";
import { installHooks } from "./index.js";
import {
  lefthookState,
  mergeLefthook,
  mergePreCommit,
  mergeShellBlock,
  preCommitState,
  removeLefthook,
  removePreCommit,
  removeShellBlock,
  shellBlockState,
} from "./merge.js";
import { BLOCK_BEGIN, BLOCK_END, hookBlock, hookVersionRange } from "./scripts.js";

const PRE_PUSH = hookBlock("pre-push");
const POST_MERGE = hookBlock("post-merge");

function content(result: ReturnType<typeof mergeShellBlock>): string {
  if (!("content" in result)) throw new Error(`expected content, got ${JSON.stringify(result)}`);
  return result.content;
}

describe("hookBlock", () => {
  it("is a marked block, and the same every time", () => {
    expect(PRE_PUSH.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(PRE_PUSH.endsWith(BLOCK_END)).toBe(true);
    expect(hookBlock("pre-push")).toBe(PRE_PUSH);
    expect(PRE_PUSH).not.toBe(POST_MERGE);
  });

  it("pins the version range to major.minor so patch releases do not look like drift", () => {
    expect(hookVersionRange("0.21.2")).toBe("^0.21.0");
    expect(hookVersionRange("1.4.9")).toBe("^1.4.0");
    expect(PRE_PUSH).toContain("autoremediator@^");
  });

  it("is valid POSIX sh, with the skip, timeout and offline guards", async () => {
    for (const block of [PRE_PUSH, POST_MERGE]) {
      const check = await execa("sh", ["-n"], { input: `#!/bin/sh\n${block}\n`, reject: false });
      expect(check.exitCode).toBe(0);
      expect(block).toContain("AUTOREMEDIATOR_SKIP_HOOKS");
      expect(block).toContain("AUTOREMEDIATOR_HOOK_TIMEOUT");
      expect(block).toContain("npx --no-install autoremediator");
      expect(block).toContain("the CLI is not available");
    }
  });

  it("quotes the project folder", () => {
    expect(hookBlock("pre-push", { projectDir: "apps/it's" })).toContain(
      String.raw`ar_dir='apps/it'\''s'`,
    );
  });
});

describe("mergeShellBlock / removeShellBlock", () => {
  it("creates an executable-style script for a missing file", () => {
    const text = content(mergeShellBlock(undefined, PRE_PUSH));
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain(PRE_PUSH);
    expect(shellBlockState(text, PRE_PUSH)).toBe("installed");
  });

  it("appends to an existing script and leaves what is there alone", () => {
    const existing = '#!/usr/bin/env bash\nnpm run lint\necho "done"\n';
    const text = content(mergeShellBlock(existing, PRE_PUSH));
    expect(text.startsWith(existing)).toBe(true);
    expect(text).toContain(PRE_PUSH);
  });

  it("is idempotent and refreshes a stale block in place", () => {
    const once = content(mergeShellBlock("#!/bin/sh\necho before\n", PRE_PUSH));
    expect(content(mergeShellBlock(once, PRE_PUSH))).toBe(once);
    const stale = once.replace("autoremediator_pre_push()", "autoremediator_old()");
    expect(shellBlockState(stale, PRE_PUSH)).toBe("modified");
    expect(content(mergeShellBlock(stale, PRE_PUSH))).toBe(once);
  });

  it("round-trips: uninstall gives back exactly what was there", () => {
    for (const original of [
      "#!/bin/sh\necho before\n",
      "#!/bin/sh\necho before",
      "echo no shebang\n\n\nmore\n",
    ]) {
      const installed = content(mergeShellBlock(original, PRE_PUSH));
      const removed = removeShellBlock(installed);
      expect(removed).toEqual({ content: original.endsWith("\n") ? original : `${original}\n` });
    }
  });

  it("removes a file that held only the block", () => {
    expect(removeShellBlock(content(mergeShellBlock(undefined, PRE_PUSH)))).toEqual({
      remove: true,
    });
    const v8 = content(
      mergeShellBlock(undefined, PRE_PUSH, { preamble: '. "$(dirname -- "$0")/_/husky.sh"' }),
    );
    expect(v8).toContain("husky.sh");
    expect(removeShellBlock(v8)).toEqual({ remove: true });
  });

  it("refuses files it cannot extend safely", () => {
    expect(mergeShellBlock(`#!/bin/sh\n${BLOCK_BEGIN}\necho x\n`, PRE_PUSH)).toHaveProperty(
      "conflict",
    );
    expect(mergeShellBlock(`#!/bin/sh\n${BLOCK_END}\n${BLOCK_BEGIN}\n`, PRE_PUSH)).toHaveProperty(
      "conflict",
    );
    expect(mergeShellBlock("#!/usr/bin/env node\nconsole.log(1)\n", PRE_PUSH)).toHaveProperty(
      "conflict",
    );
    expect(mergeShellBlock("#!/usr/bin/env python3\nprint(1)\n", PRE_PUSH)).toHaveProperty(
      "conflict",
    );
    expect(mergeShellBlock("#!/bin/sh\nnpm test\nexit 0\n", PRE_PUSH)).toHaveProperty("conflict");
    expect(mergeShellBlock("#!/bin/sh\nexec lefthook run pre-push\n", PRE_PUSH)).toHaveProperty(
      "conflict",
    );
    expect(removeShellBlock(`#!/bin/sh\n${BLOCK_BEGIN}\n`)).toHaveProperty("conflict");
  });

  it("accepts sh, bash, zsh and env shebangs", () => {
    for (const shebang of [
      "#!/bin/sh",
      "#!/bin/bash",
      "#!/usr/bin/env bash",
      "#!/usr/bin/env -S sh -e",
      "#!/bin/zsh",
    ]) {
      expect(mergeShellBlock(`${shebang}\necho 1\n`, PRE_PUSH)).toHaveProperty("content");
    }
  });

  it("reports state", () => {
    expect(shellBlockState(undefined, PRE_PUSH)).toBe("missing");
    expect(shellBlockState("#!/bin/sh\necho 1\n", PRE_PUSH)).toBe("missing");
    expect(shellBlockState(`${BLOCK_BEGIN}\n`, PRE_PUSH)).toBe("conflict");
  });
});

describe("lefthook", () => {
  const blocks = { "pre-push": PRE_PUSH, "post-merge": POST_MERGE };

  it("creates a config with a command per hook", () => {
    const merged = content(mergeLefthook(undefined, blocks));
    const parsed = parseYaml(merged) as Record<
      string,
      { commands: Record<string, { run: string }> }
    >;
    expect(parsed["pre-push"]?.commands.autoremediator?.run.trim()).toBe(PRE_PUSH);
    expect(parsed["post-merge"]?.commands.autoremediator?.run.trim()).toBe(POST_MERGE);
    expect(lefthookState(merged, "pre-push", PRE_PUSH)).toBe("installed");
  });

  it("keeps the user's commands and comments, and is idempotent", () => {
    const existing =
      "# our hooks\npre-push:\n  commands:\n    lint:\n      run: npm run lint # keep\noutput:\n  - success\n";
    const merged = content(mergeLefthook(existing, blocks));
    expect(merged).toContain("# our hooks");
    expect(merged).toContain("run: npm run lint # keep");
    expect(merged).toContain("output:");
    const parsed = parseYaml(merged) as Record<string, { commands: Record<string, unknown> }>;
    expect(Object.keys(parsed["pre-push"]?.commands ?? {})).toEqual(["lint", "autoremediator"]);
    expect(content(mergeLefthook(merged, blocks))).toBe(merged);
  });

  it("refreshes its own stale entry", () => {
    const merged = content(mergeLefthook(undefined, blocks));
    const stale = merged.replace("autoremediator_pre_push()", "autoremediator_old()");
    expect(lefthookState(stale, "pre-push", PRE_PUSH)).toBe("modified");
    expect(content(mergeLefthook(stale, blocks))).toBe(merged);
  });

  it("does not replace an entry it did not write", () => {
    const existing = "pre-push:\n  commands:\n    autoremediator:\n      run: echo mine\n";
    expect(mergeLefthook(existing, blocks)).toHaveProperty("conflict");
    expect(removeLefthook(existing, ["pre-push"])).toHaveProperty("conflict");
    expect(lefthookState(existing, "pre-push", PRE_PUSH)).toBe("conflict");
  });

  it("refuses invalid or non-mapping YAML", () => {
    expect(mergeLefthook("a: [", blocks)).toHaveProperty("conflict");
    expect(mergeLefthook("- a\n- b\n", blocks)).toHaveProperty("conflict");
    expect(mergeLefthook("pre-push: nope\n", blocks)).toHaveProperty("conflict");
  });

  it("adds a job when the hook uses the jobs syntax", () => {
    const existing = "pre-push:\n  jobs:\n    - name: lint\n      run: npm run lint\n";
    const merged = content(mergeLefthook(existing, { "pre-push": PRE_PUSH }));
    const parsed = parseYaml(merged) as {
      "pre-push": { jobs: Array<{ name: string; run: string }>; commands?: unknown };
    };
    expect(parsed["pre-push"].jobs.map((job) => job.name)).toEqual(["lint", "autoremediator"]);
    expect(parsed["pre-push"].commands).toBeUndefined();
    expect(lefthookState(merged, "pre-push", PRE_PUSH)).toBe("installed");
    expect(content(mergeLefthook(merged, { "pre-push": PRE_PUSH }))).toBe(merged);
    const removed = content(removeLefthook(merged, ["pre-push"]));
    expect(parseYaml(removed)).toEqual({
      "pre-push": { jobs: [{ name: "lint", run: "npm run lint" }] },
    });
  });

  it("uninstall removes only its entries, and the file when nothing else is left", () => {
    const own = content(mergeLefthook(undefined, blocks));
    expect(removeLefthook(own, ["pre-push", "post-merge"])).toEqual({ remove: true });
    const existing = "pre-push:\n  commands:\n    lint:\n      run: npm run lint\n";
    const merged = content(mergeLefthook(existing, blocks));
    expect(content(removeLefthook(merged, ["pre-push", "post-merge"]))).toBe(existing);
  });
});

describe("pre-commit framework", () => {
  const blocks = { "pre-push": PRE_PUSH, "post-merge": POST_MERGE };

  it("creates a config with local hooks for the push and merge stages", () => {
    const merged = content(mergePreCommit(undefined, blocks));
    const parsed = parseYaml(merged) as {
      repos: Array<{ repo: string; hooks: Array<Record<string, unknown>> }>;
    };
    expect(parsed.repos).toHaveLength(1);
    const [first, second] = parsed.repos[0]?.hooks ?? [];
    expect(first).toMatchObject({
      id: "autoremediator-pre-push",
      stages: ["pre-push"],
      language: "system",
      pass_filenames: false,
      always_run: true,
    });
    expect(second).toMatchObject({ id: "autoremediator-post-merge", stages: ["post-merge"] });
    const args = (first?.args ?? []) as string[];
    expect(String(args[0]).trim()).toBe(PRE_PUSH);
    expect(first?.entry).toBe("sh -c");
    expect(preCommitState(merged, "pre-push", PRE_PUSH)).toBe("installed");
  });

  it("joins an existing local repo and keeps the other repos", () => {
    const existing = [
      "repos:",
      "  - repo: https://github.com/pre-commit/pre-commit-hooks",
      "    rev: v4.5.0",
      "    hooks:",
      "      - id: trailing-whitespace",
      "  - repo: local",
      "    hooks:",
      "      - id: mine",
      "        name: mine",
      "        entry: ./mine.sh",
      "        language: system",
      "",
    ].join("\n");
    const merged = content(mergePreCommit(existing, blocks));
    const parsed = parseYaml(merged) as {
      repos: Array<{ repo: string; hooks: Array<{ id: string }> }>;
    };
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.repos[1]?.hooks.map((hook) => hook.id)).toEqual([
      "mine",
      "autoremediator-pre-push",
      "autoremediator-post-merge",
    ]);
    expect(content(mergePreCommit(merged, blocks))).toBe(merged);
    expect(content(removePreCommit(merged, ["pre-push", "post-merge"]))).toBe(existing);
  });

  it("appends a local repo when there is none, and removes it again", () => {
    const existing =
      "repos:\n  - repo: https://example.com/x\n    rev: v1\n    hooks:\n      - id: x\n";
    const merged = content(mergePreCommit(existing, { "pre-push": PRE_PUSH }));
    expect((parseYaml(merged) as { repos: unknown[] }).repos).toHaveLength(2);
    expect(content(removePreCommit(merged, ["pre-push"]))).toBe(existing);
  });

  it("refuses a hook id it did not write, and a repos that is not a list", () => {
    const existing =
      "repos:\n  - repo: local\n    hooks:\n      - id: autoremediator-pre-push\n        name: x\n        entry: x\n        language: system\n";
    expect(mergePreCommit(existing, blocks)).toHaveProperty("conflict");
    expect(removePreCommit(existing, ["pre-push"])).toHaveProperty("conflict");
    expect(mergePreCommit("repos: nope\n", blocks)).toHaveProperty("conflict");
    expect(mergePreCommit("repos: [\n", blocks)).toHaveProperty("conflict");
  });

  it("reports modified when the script differs", () => {
    const merged = content(mergePreCommit(undefined, blocks));
    expect(
      preCommitState(
        merged.replace("autoremediator_pre_push()", "autoremediator_x()"),
        "pre-push",
        PRE_PUSH,
      ),
    ).toBe("modified");
    expect(preCommitState(merged, "post-merge", POST_MERGE)).toBe("installed");
    expect(preCommitState("repos: []\n", "pre-push", PRE_PUSH)).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// installHooks against real repositories

let dir: string;
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

async function git(args: string[], cwd = dir): Promise<string> {
  const result = await execa("git", args, { cwd, env: GIT_ENV, extendEnv: true });
  return result.stdout;
}

function put(path: string, text: string, root = dir): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
const read = (path: string, root = dir): string => readFileSync(join(root, path), "utf8");

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hooks-"));
  await git(["init", "-q", "-b", "main"]);
  put("package.json", '{"name":"x"}\n');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("installHooks: plain git hooks", () => {
  it("reports a plan without writing unless yes is set", async () => {
    const plan = await installHooks({ cwd: dir });
    expect(plan).toMatchObject({
      manager: "git",
      action: "install",
      drift: true,
      applied: false,
      conflicts: [],
    });
    expect(plan.hooks.map((hook) => [hook.hook, hook.state])).toEqual([
      ["pre-push", "missing"],
      ["post-merge", "missing"],
    ]);
    expect(plan.changes.map((change) => change.path)).toEqual([
      ".git/hooks/pre-push",
      ".git/hooks/post-merge",
    ]);
    expect(plan.changes[0]?.diff).toContain("+# autoremediator:begin");
    expect(existsSync(join(dir, ".git/hooks/pre-push"))).toBe(false);
  });

  it("installs executable hooks, then reports no drift", async () => {
    const result = await installHooks({ cwd: dir, yes: true });
    expect(result.applied).toBe(true);
    for (const hook of ["pre-push", "post-merge"]) {
      expect(statSync(join(dir, ".git/hooks", hook)).mode & 0o111).not.toBe(0);
      expect(read(`.git/hooks/${hook}`)).toContain(BLOCK_BEGIN);
    }
    const again = await installHooks({ cwd: dir, yes: true });
    expect(again).toMatchObject({ drift: false, applied: false });
    expect(again.hooks.every((hook) => hook.state === "installed")).toBe(true);
  });

  it("handles only the hooks asked for", async () => {
    await installHooks({ cwd: dir, yes: true, hooks: ["pre-push"] });
    expect(existsSync(join(dir, ".git/hooks/pre-push"))).toBe(true);
    expect(existsSync(join(dir, ".git/hooks/post-merge"))).toBe(false);
  });

  it("check never writes", async () => {
    const result = await installHooks({ cwd: dir, check: true, yes: true });
    expect(result).toMatchObject({ drift: true, applied: false });
    expect(existsSync(join(dir, ".git/hooks/pre-push"))).toBe(false);
  });

  it("preserves an existing hook, and uninstall restores it exactly", async () => {
    const original = '#!/bin/sh\necho "my hook"\n';
    put(".git/hooks/pre-push", original);
    chmodSync(join(dir, ".git/hooks/pre-push"), 0o755);
    await installHooks({ cwd: dir, yes: true });
    expect(read(".git/hooks/pre-push").startsWith(original)).toBe(true);
    const removed = await installHooks({ cwd: dir, yes: true, uninstall: true });
    expect(removed.applied).toBe(true);
    expect(read(".git/hooks/pre-push")).toBe(original);
    expect(existsSync(join(dir, ".git/hooks/post-merge"))).toBe(false);
  });

  it("flags a hook that is installed but not executable as drift, and repairs it", async () => {
    await installHooks({ cwd: dir, yes: true });
    chmodSync(join(dir, ".git/hooks/pre-push"), 0o644);
    const status = await installHooks({ cwd: dir, check: true });
    expect(status.drift).toBe(true);
    expect(status.hooks.find((hook) => hook.hook === "pre-push")).toMatchObject({
      state: "modified",
    });
    await installHooks({ cwd: dir, yes: true });
    expect(statSync(join(dir, ".git/hooks/pre-push")).mode & 0o111).not.toBe(0);
  });

  it("does not switch a disabled hook of the user's back on by making it executable", async () => {
    const original = '#!/bin/sh\necho "old logic"\n';
    put(".git/hooks/pre-push", original);
    chmodSync(join(dir, ".git/hooks/pre-push"), 0o644);
    const result = await installHooks({ cwd: dir, yes: true });
    expect(result.conflicts).toEqual([".git/hooks/pre-push"]);
    expect(
      result.changes.find((change) => change.path === ".git/hooks/pre-push")?.reason,
    ).toContain("not executable");
    expect(read(".git/hooks/pre-push")).toBe(original);
    expect(statSync(join(dir, ".git/hooks/pre-push")).mode & 0o111).toBe(0);
    // The other hook is unaffected.
    expect(existsSync(join(dir, ".git/hooks/post-merge"))).toBe(true);
  });

  it("uninstall leaves a non-executable hook non-executable", async () => {
    const original = '#!/bin/sh\necho "old logic"\n';
    put(".git/hooks/pre-push", original);
    chmodSync(join(dir, ".git/hooks/pre-push"), 0o755);
    await installHooks({ cwd: dir, yes: true });
    chmodSync(join(dir, ".git/hooks/pre-push"), 0o644);
    await installHooks({ cwd: dir, yes: true, uninstall: true });
    expect(read(".git/hooks/pre-push")).toBe(original);
    expect(statSync(join(dir, ".git/hooks/pre-push")).mode & 0o111).toBe(0);
  });

  it("reports an edited block as modified and refreshes it", async () => {
    await installHooks({ cwd: dir, yes: true });
    put(
      ".git/hooks/post-merge",
      read(".git/hooks/post-merge").replace(
        "autoremediator_post_merge()",
        "autoremediator_edited()",
      ),
    );
    const status = await installHooks({ cwd: dir, check: true });
    expect(status.hooks.map((hook) => hook.state)).toEqual(["installed", "modified"]);
    await installHooks({ cwd: dir, yes: true });
    expect((await installHooks({ cwd: dir, check: true })).drift).toBe(false);
  });

  it("leaves a hook it cannot extend alone and reports a conflict", async () => {
    put(".git/hooks/pre-push", "#!/usr/bin/env node\nconsole.log('x')\n");
    const result = await installHooks({ cwd: dir, yes: true });
    expect(result.conflicts).toEqual([".git/hooks/pre-push"]);
    expect(result.hooks[0]).toMatchObject({ hook: "pre-push", state: "conflict" });
    expect(read(".git/hooks/pre-push")).toBe("#!/usr/bin/env node\nconsole.log('x')\n");
    expect(existsSync(join(dir, ".git/hooks/post-merge"))).toBe(true);
  });

  it("does not write through a symbolic link", async () => {
    put("shared-hook", "#!/bin/sh\necho shared\n");
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    symlinkSync(join(dir, "shared-hook"), join(dir, ".git/hooks/pre-push"));
    const result = await installHooks({ cwd: dir, yes: true });
    expect(result.conflicts).toEqual([".git/hooks/pre-push"]);
    expect(read("shared-hook")).toBe("#!/bin/sh\necho shared\n");
  });

  it("follows core.hooksPath", async () => {
    await git(["config", "core.hooksPath", ".githooks"]);
    const result = await installHooks({ cwd: dir, yes: true });
    expect(result.manager).toBe("git");
    expect(result.managerReason).toContain("core.hooksPath");
    expect(existsSync(join(dir, ".githooks/pre-push"))).toBe(true);
    expect(existsSync(join(dir, ".git/hooks/pre-push"))).toBe(false);
  });

  describe("a hooks folder shared with other repositories", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "hooks-home-"));
      mkdirSync(join(home, "shared-hooks"));
      writeFileSync(
        join(home, ".gitconfig"),
        `[core]\n\thooksPath = ${join(home, "shared-hooks")}\n`,
      );
      vi.stubEnv("HOME", home);
      vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, ".gitconfig"));
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });

    it("is a conflict, and nothing is written there, unless asked for", async () => {
      const result = await installHooks({ cwd: dir, yes: true });
      expect(result.applied).toBe(false);
      expect(result.conflicts).toHaveLength(2);
      expect(result.changes[0]?.reason).toContain("outside this repository");
      expect(result.changes[0]?.reason).toContain("--allow-shared-hooks-path");
      expect(existsSync(join(home, "shared-hooks/pre-push"))).toBe(false);
      expect(existsSync(join(home, "shared-hooks/post-merge"))).toBe(false);
    });

    it("is written with allowSharedHooksPath", async () => {
      const result = await installHooks({ cwd: dir, yes: true, allowSharedHooksPath: true });
      expect(result.applied).toBe(true);
      expect(result.conflicts).toEqual([]);
      expect(existsSync(join(home, "shared-hooks/pre-push"))).toBe(true);
    });

    it("a hooks folder inside the repository is not shared", async () => {
      await git(["config", "--local", "core.hooksPath", ".githooks"]);
      const result = await installHooks({ cwd: dir, yes: true });
      expect(result.applied).toBe(true);
      expect(existsSync(join(dir, ".githooks/pre-push"))).toBe(true);
    });
  });

  it("finds the shared hooks folder from a worktree whose .git is a file", async () => {
    await git(["commit", "-q", "--allow-empty", "-m", "init"]);
    const worktree = join(dir, "..", `${dir.split("/").at(-1)}-wt`);
    await git(["worktree", "add", "-q", worktree]);
    try {
      expect(statSync(join(worktree, ".git")).isFile()).toBe(true);
      const result = await installHooks({ cwd: worktree, yes: true });
      expect(result.applied).toBe(true);
      expect(existsSync(join(dir, ".git/hooks/pre-push"))).toBe(true);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("runs from a subfolder: hooks go to the repository, the project folder is baked in", async () => {
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    await installHooks({ cwd: join(dir, "apps/web"), yes: true });
    expect(read(".git/hooks/pre-push")).toContain("ar_dir='apps/web'");
  });

  it("fails clearly outside a repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "no-repo-"));
    try {
      await expect(installHooks({ cwd: outside })).rejects.toThrow(/not inside a git repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("installHooks: hook managers", () => {
  it("husky: writes .husky/<hook>, appends to an existing one, and uninstall restores it", async () => {
    put(".husky/pre-push", "npm test\n");
    const result = await installHooks({ cwd: dir, yes: true });
    expect(result.manager).toBe("husky");
    expect(read(".husky/pre-push").startsWith("npm test\n")).toBe(true);
    expect(read(".husky/pre-push")).toContain(BLOCK_BEGIN);
    expect(read(".husky/post-merge").startsWith("#!/bin/sh\n")).toBe(true);
    await installHooks({ cwd: dir, yes: true, uninstall: true });
    expect(read(".husky/pre-push")).toBe("npm test\n");
    expect(existsSync(join(dir, ".husky/post-merge"))).toBe(false);
  });

  it("husky: detected from core.hooksPath, and v8 files source husky.sh", async () => {
    await git(["config", "core.hooksPath", ".husky/_"]);
    put(".husky/_/husky.sh", "# husky\n");
    const result = await installHooks({ cwd: dir, yes: true });
    expect(result.manager).toBe("husky");
    expect(read(".husky/pre-push")).toContain('_/husky.sh"');
    expect(result.nextSteps).toEqual([]);
  });

  describe("husky in a subfolder", () => {
    const STUB = `#!/usr/bin/env sh\n. "\${0%/*}/h"\n`;

    it("husky 9: writes .husky/<hook> next to the generated _ folder, never into it", async () => {
      await git(["config", "core.hooksPath", "packages/app/.husky/_"]);
      put("packages/app/.husky/_/pre-push", STUB);
      put("packages/app/.husky/_/h", "# generated\n");
      const result = await installHooks({ cwd: dir, yes: true });
      expect(result.manager).toBe("husky");
      expect(result.changes.map((change) => change.path)).toEqual([
        "packages/app/.husky/pre-push",
        "packages/app/.husky/post-merge",
      ]);
      expect(read("packages/app/.husky/pre-push")).toContain(BLOCK_BEGIN);
      expect(read("packages/app/.husky/_/pre-push")).toBe(STUB);
      expect(existsSync(join(dir, "packages/app/.husky/_/post-merge"))).toBe(false);
      expect(existsSync(join(dir, ".husky"))).toBe(false);
    });

    it("husky 8: sources husky.sh from the subfolder's own _ folder", async () => {
      await git(["config", "core.hooksPath", "packages/app/.husky"]);
      put("packages/app/.husky/_/husky.sh", "# husky\n");
      const result = await installHooks({ cwd: dir, yes: true });
      expect(result.manager).toBe("husky");
      expect(read("packages/app/.husky/pre-push")).toContain('_/husky.sh"');
    });

    it("an absolute core.hooksPath into a .husky folder is found too", async () => {
      await git(["config", "core.hooksPath", join(dir, "packages/app/.husky/_")]);
      put("packages/app/.husky/_/h", "# generated\n");
      const result = await installHooks({ cwd: dir, yes: true });
      expect(result.manager).toBe("husky");
      expect(existsSync(join(dir, "packages/app/.husky/pre-push"))).toBe(true);
    });

    it("a folder that merely contains the letters is not husky", async () => {
      await git(["config", "core.hooksPath", "my.husky-hooks"]);
      expect((await installHooks({ cwd: dir })).manager).toBe("git");
    });
  });

  it("lefthook: merges into lefthook.yml and says to run lefthook install", async () => {
    put("lefthook.yml", "pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n");
    const result = await installHooks({ cwd: dir, yes: true });
    expect(result.manager).toBe("lefthook");
    expect(result.nextSteps[0]).toContain("lefthook install");
    const parsed = parseYaml(read("lefthook.yml")) as Record<string, unknown>;
    expect(Object.keys(parsed).toSorted()).toEqual(["post-merge", "pre-commit", "pre-push"]);
    expect((await installHooks({ cwd: dir, check: true })).drift).toBe(false);
    await installHooks({ cwd: dir, yes: true, uninstall: true });
    expect(read("lefthook.yml")).toBe(
      "pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n",
    );
  });

  it("pre-commit: adds local hooks and says how to activate them", async () => {
    put(
      ".pre-commit-config.yaml",
      "repos:\n  - repo: https://example.com/x\n    rev: v1\n    hooks:\n      - id: x\n",
    );
    const result = await installHooks({ cwd: dir, yes: true, hooks: ["pre-push"] });
    expect(result.manager).toBe("pre-commit");
    expect(result.nextSteps[0]).toContain("pre-commit install --hook-type pre-push");
    expect(read(".pre-commit-config.yaml")).toContain("autoremediator-pre-push");
    expect(read(".pre-commit-config.yaml")).not.toContain("autoremediator-post-merge");
  });

  it("prefers husky over lefthook over pre-commit, and --manager overrides", async () => {
    put(".pre-commit-config.yaml", "repos: []\n");
    expect((await installHooks({ cwd: dir })).manager).toBe("pre-commit");
    put("lefthook.yml", "output: []\n");
    expect((await installHooks({ cwd: dir })).manager).toBe("lefthook");
    mkdirSync(join(dir, ".husky"));
    expect((await installHooks({ cwd: dir })).manager).toBe("husky");
    expect((await installHooks({ cwd: dir, manager: "git" })).manager).toBe("git");
    const forced = await installHooks({ cwd: dir, manager: "pre-commit" });
    expect(forced.manager).toBe("pre-commit");
  });

  it("creates the configuration file when the manager is forced and has none", async () => {
    await installHooks({ cwd: dir, yes: true, manager: "lefthook" });
    expect(parseYaml(read("lefthook.yml"))).toHaveProperty("pre-push.commands.autoremediator.run");
  });

  it("leaves unparsable configuration alone", async () => {
    put("lefthook.yml", "pre-push: [\n");
    const result = await installHooks({ cwd: dir, yes: true });
    expect(result.conflicts).toEqual(["lefthook.yml"]);
    expect(read("lefthook.yml")).toBe("pre-push: [\n");
  });
});

describe("operation catalog", () => {
  it("registers installHooks for the command line and SDK only", () => {
    const operation = getOperation("installHooks");
    expect(operation).toBeDefined();
    expect(operation?.mcp).toBe(false);
    expect(operation?.http).toBeUndefined();
  });
});
