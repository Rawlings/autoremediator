import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorktree, worktreeDiff, worktreeRoot } from "./worktree.js";

let dir: string;
let cache: string;
let env: NodeJS.ProcessEnv;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const write = (file: string, content: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wt-repo-"));
  cache = mkdtempSync(join(tmpdir(), "wt-cache-"));
  env = { XDG_CACHE_HOME: cache };
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  write("package.json", '{"name":"app"}');
  write("src/a.ts", "export const a = 1;\n");
  write(".gitignore", "node_modules\nsecret.env\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("checks the project out outside the repository, at HEAD", async () => {
    const wt = await createWorktree(dir, "attempt-1", env);
    try {
      expect(wt.path.startsWith(worktreeRoot(realpathSync(dir), env))).toBe(true);
      expect(wt.path.startsWith(realpathSync(dir))).toBe(false);
      expect(readFileSync(join(wt.path, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(wt.base).toBe(git("rev-parse", "HEAD").trim());
    } finally {
      await wt.remove();
    }
  });

  it("carries over uncommitted edits and untracked files, but not ignored ones", async () => {
    write("src/a.ts", "export const a = 2;\n");
    write("src/new.ts", "export const n = 1;\n");
    write("secret.env", "TOKEN=1\n");
    mkdirSync(join(dir, "node_modules"));
    write("node_modules/x.js", "x");

    const wt = await createWorktree(dir, "attempt-dirty", env);
    try {
      expect(readFileSync(join(wt.path, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
      expect(existsSync(join(wt.path, "src/new.ts"))).toBe(true);
      expect(existsSync(join(wt.path, "secret.env"))).toBe(false);
      expect(existsSync(join(wt.path, "node_modules"))).toBe(false);
      // The project itself is untouched.
      expect(git("status", "--porcelain")).toContain("src/a.ts");
    } finally {
      await wt.remove();
    }
  });

  it("starts a dirty project's checkout from its current state, so a diff is only the attempt's work", async () => {
    write("src/a.ts", "export const a = 2;\n");
    write("src/new.ts", "export const n = 1;\n");
    const wt = await createWorktree(dir, "dirty-base", env);
    try {
      expect(wt.base).not.toBe(git("rev-parse", "HEAD").trim());
      await expect(worktreeDiff(wt.path)).resolves.toBe("");

      writeFileSync(join(wt.path, "src/a.ts"), "export const a = 3;\n");
      const diff = await worktreeDiff(wt.path);
      expect(diff).toContain("-export const a = 2;");
      expect(diff).toContain("+export const a = 3;");
      expect(diff).not.toContain("new.ts");

      // It applies to the project as it is now, uncommitted changes and all.
      const patch = join(tmpdir(), "wt-dirty.patch");
      writeFileSync(patch, diff);
      execFileSync("git", ["apply", patch], { cwd: dir });
      rmSync(patch, { force: true });
      expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("export const a = 3;\n");
      // The checkout's helper commit is not on any branch of the project.
      expect(git("branch", "--contains", wt.base).trim()).toBe("");
    } finally {
      await wt.remove();
    }
  });

  it("keeps attempts isolated from each other and from the project", async () => {
    const one = await createWorktree(dir, "one", env);
    const two = await createWorktree(dir, "two", env);
    try {
      writeFileSync(join(one.path, "src/a.ts"), "changed in one\n");
      expect(readFileSync(join(two.path, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    } finally {
      await one.remove();
      await two.remove();
    }
  });

  it("maps a subdirectory project to the same subdirectory in the checkout", async () => {
    write("packages/app/package.json", '{"name":"sub"}');
    git("add", "-A");
    git("commit", "-q", "-m", "sub");
    const wt = await createWorktree(join(dir, "packages", "app"), "sub", env);
    try {
      expect(readFileSync(join(wt.path, "package.json"), "utf8")).toBe('{"name":"sub"}');
    } finally {
      await wt.remove();
    }
  });

  it("removes the checkout and its git registration", async () => {
    const wt = await createWorktree(dir, "gone", env);
    await wt.remove();
    await wt.remove();
    expect(existsSync(wt.path)).toBe(false);
    expect(git("worktree", "list")).not.toContain("gone");
  });

  it("explains itself outside a git repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "wt-plain-"));
    try {
      await expect(createWorktree(plain, "x", env)).rejects.toThrow(/git repository/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("worktreeDiff", () => {
  it("is empty without changes, and includes edits, new and deleted files", async () => {
    const wt = await createWorktree(dir, "diff", env);
    try {
      await expect(worktreeDiff(wt.path)).resolves.toBe("");

      writeFileSync(join(wt.path, "src/a.ts"), "export const a = 3;\n");
      writeFileSync(join(wt.path, "src/b.ts"), "export const b = 1;\n");
      rmSync(join(wt.path, "package.json"));
      const diff = await worktreeDiff(wt.path);
      expect(diff).toContain("+export const a = 3;");
      expect(diff).toContain("b/src/b.ts");
      expect(diff).toContain("deleted file mode");

      // The patch applies to the original project.
      writeFileSync(join(tmpdir(), "wt.patch"), diff);
      execFileSync("git", ["apply", "--check", join(tmpdir(), "wt.patch")], { cwd: dir });
      rmSync(join(tmpdir(), "wt.patch"), { force: true });
    } finally {
      await wt.remove();
    }
  });
});
