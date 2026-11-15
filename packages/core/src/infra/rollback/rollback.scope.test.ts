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

import {
  createProjectSnapshot,
  restoreProjectSnapshot,
  restoreProjectSnapshotSync,
} from "./rollback.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

describe("rollback scope", () => {
  let repo: string;
  let pkg: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "rollback-scope-")));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    pkg = join(repo, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(repo, "packages", "other"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"app"}\n');
    writeFileSync(join(repo, "packages", "other", "keep.txt"), "tracked\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  for (const [label, restore] of [
    ["async", restoreProjectSnapshot],
    ["sync", restoreProjectSnapshotSync],
  ] as const) {
    it(`${label}: only touches files inside the snapshot cwd when it is a repo subdirectory`, async () => {
      const snapshot = await createProjectSnapshot(pkg);

      // Run produces an artifact inside the project...
      writeFileSync(join(pkg, "generated.patch"), "x");
      writeFileSync(join(pkg, "stray.txt"), "run output");
      // ...while unrelated work elsewhere in the same repo must survive.
      writeFileSync(join(repo, "packages", "other", "wip.txt"), "someone else's work");
      writeFileSync(join(repo, "packages", "other", "keep.txt"), "edited elsewhere\n");

      await restore(snapshot);

      expect(existsSync(join(pkg, "generated.patch"))).toBe(false);
      expect(existsSync(join(pkg, "stray.txt"))).toBe(false);
      expect(readFileSync(join(repo, "packages", "other", "wip.txt"), "utf8")).toBe(
        "someone else's work",
      );
      expect(readFileSync(join(repo, "packages", "other", "keep.txt"), "utf8")).toBe(
        "edited elsewhere\n",
      );
    });
  }

  it("does not treat arbitrary 'lock'-containing source files as lockfiles", async () => {
    const snapshot = await createProjectSnapshot(pkg);
    writeFileSync(join(pkg, "clock.ts"), "export const now = Date.now;\n");
    writeFileSync(join(pkg, "blocklist.json"), "[]");
    // Not a git repo path: force the non-git branch by clearing the git flag.
    await restoreProjectSnapshot({ ...snapshot, isGit: false });
    expect(existsSync(join(pkg, "clock.ts"))).toBe(true);
    expect(existsSync(join(pkg, "blocklist.json"))).toBe(true);
  });

  it("restores binary lockfiles byte-for-byte", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0xc3, 0x28, 0x7f, 0x00]);
    writeFileSync(join(pkg, "bun.lockb"), bytes);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "lockb");
    const snapshot = await createProjectSnapshot(pkg);
    writeFileSync(join(pkg, "bun.lockb"), "garbage");
    await restoreProjectSnapshot(snapshot);
    expect(readFileSync(join(pkg, "bun.lockb")).equals(bytes)).toBe(true);
  });
});
