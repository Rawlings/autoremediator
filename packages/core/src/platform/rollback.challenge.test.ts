import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProjectSnapshot, restoreProjectSnapshotSync } from "./rollback.js";
import { applyDispositionAndContainment } from "../remediation/local/disposition.js";
import type { PatchResult } from "./types.js";

describe("Milestone 4 Challenge: Filesystem Rollback under Containment Mode", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "challenger-m4-rollback-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("stress-test git repository rollback: preserves pre-existing dirty files while reverting remediation mutations and removing untracked artifacts", async () => {
    // 1. Initialize real git repository
    execSync("git init", { cwd: testDir, stdio: "ignore" });
    execSync("git config user.email 'test@example.com'", { cwd: testDir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: testDir, stdio: "ignore" });

    // 2. Commit initial state
    const pkgJsonPath = join(testDir, "package.json");
    const srcDirPath = join(testDir, "src");
    mkdirSync(srcDirPath, { recursive: true });
    const srcFilePath = join(srcDirPath, "index.ts");
    const dirtyFilePath = join(testDir, "pre-existing-dirty.txt");

    writeFileSync(pkgJsonPath, JSON.stringify({ name: "my-app", version: "1.0.0" }, null, 2));
    writeFileSync(srcFilePath, "export const greeting = 'hello';\n");
    writeFileSync(dirtyFilePath, "clean content\n");

    execSync("git add .", { cwd: testDir, stdio: "ignore" });
    execSync("git commit -m 'initial commit'", { cwd: testDir, stdio: "ignore" });

    // 3. Create pre-existing dirty uncommitted modifications before remediation
    writeFileSync(dirtyFilePath, "dirty uncommitted modification by user\n");

    // 4. Capture pre-remediation snapshot
    const snapshot = await createProjectSnapshot(testDir);
    expect(snapshot.isGit).toBe(true);

    // 5. Simulate remediation actions (mutating tracked files and creating untracked files)
    // - Mutate tracked package.json
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        { name: "my-app", version: "2.0.0", dependencies: { vuln: "2.0.0" } },
        null,
        2,
      ),
    );
    // - Mutate tracked source file
    writeFileSync(srcFilePath, "export const greeting = 'mutated-by-remediation';\n");
    // - Create new nested patch artifact
    const patchSubDir = join(testDir, "patches", "nested", "sub");
    mkdirSync(patchSubDir, { recursive: true });
    const patchFilePath = join(patchSubDir, "vuln+1.0.0.patch");
    writeFileSync(patchFilePath, "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-a\n+b\n");
    // - Create new untracked file with spaces in filename
    const spacedFilePath = join(testDir, "untracked artifact with spaces.txt");
    writeFileSync(spacedFilePath, "temporary debugging output");

    // Verify disk is in mutated dirty state
    expect(readFileSync(srcFilePath, "utf8")).toContain("mutated-by-remediation");
    expect(existsSync(patchFilePath)).toBe(true);
    expect(existsSync(spacedFilePath)).toBe(true);

    // 6. Trigger containment rollback via applyDispositionAndContainment
    const mutatedResult: PatchResult = {
      packageName: "vuln",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      strategy: "version-bump",
      applied: true,
      dryRun: false,
      message: "Version bump simulated",
    };

    let rollbackHookCalled = false;
    const finalResult = applyDispositionAndContainment(mutatedResult, {
      containmentMode: true,
      exploitSignalTriggered: true,
      snapshot,
      onContainmentRollback: () => {
        rollbackHookCalled = true;
      },
    });

    // Verify containment policy semantics
    expect(rollbackHookCalled).toBe(true);
    expect(finalResult.disposition).toBe("escalate");
    expect(finalResult.applied).toBe(false);
    expect(finalResult.unresolvedReason).toBe("policy-blocked");

    // 7. Verify disk state after rollback:
    // Tracked package.json restored
    const restoredPkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    expect(restoredPkg.version).toBe("1.0.0");
    expect(restoredPkg.dependencies).toBeUndefined();

    // Tracked src/index.ts reverted to HEAD
    expect(readFileSync(srcFilePath, "utf8")).toBe("export const greeting = 'hello';\n");

    // Pre-existing dirty file preserved
    expect(readFileSync(dirtyFilePath, "utf8")).toBe("dirty uncommitted modification by user\n");

    // Untracked patch file and spaced file wiped
    expect(existsSync(patchFilePath)).toBe(false);
    expect(existsSync(spacedFilePath)).toBe(false);

    // Git status should only contain the pre-existing dirty file
    const gitStatus = execSync("git status --porcelain=v1 -uall", {
      cwd: testDir,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(gitStatus).toEqual(["M pre-existing-dirty.txt"]);
  });

  it("stress-test non-git directory rollback: restores manifests and removes newly created patch artifacts", async () => {
    // Non-git directory
    const pkgJsonPath = join(testDir, "package.json");
    writeFileSync(pkgJsonPath, JSON.stringify({ name: "standalone", version: "1.0.0" }));
    const pnpmLockPath = join(testDir, "pnpm-lock.yaml");
    writeFileSync(pnpmLockPath, "lockfileversion: 5.4\n");

    const snapshot = await createProjectSnapshot(testDir);
    expect(snapshot.isGit).toBe(false);

    // Mutate existing manifest
    writeFileSync(pkgJsonPath, JSON.stringify({ name: "standalone", version: "9.9.9" }));

    // Create newly created manifest & patch file
    const newLockPath = join(testDir, "package-lock.json");
    writeFileSync(newLockPath, '{"name": "lock"}');
    const patchesDir = join(testDir, "patches");
    mkdirSync(patchesDir, { recursive: true });
    const patchPath = join(patchesDir, "fix.patch");
    writeFileSync(patchPath, "diff --git a/a b/b\n");

    expect(existsSync(newLockPath)).toBe(true);
    expect(existsSync(patchPath)).toBe(true);

    // Synchronous rollback
    restoreProjectSnapshotSync(snapshot);

    // Restores original manifest
    expect(JSON.parse(readFileSync(pkgJsonPath, "utf8")).version).toBe("1.0.0");
    // Removes newly created manifest and patch
    expect(existsSync(newLockPath)).toBe(false);
    expect(existsSync(patchPath)).toBe(false);
  });

  it("stress-test git repository edge cases: unstaged modified files, untracked files, quoted filenames, spaces, and deletions across async and sync rollback", async () => {
    // 1. Initialize git repo
    execSync("git init", { cwd: testDir, stdio: "ignore" });
    execSync("git config user.email 'test@example.com'", { cwd: testDir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: testDir, stdio: "ignore" });

    // Tracked initial files
    const cleanTracked = join(testDir, "clean_tracked.txt");
    const dirtyTracked = join(testDir, "dirty_tracked.txt");
    const dirtySpacedTracked = join(testDir, "dirty spaced tracked.txt");
    const dirtyQuotedTracked = join(testDir, 'dirty "quoted" tracked.txt');
    const trackedToDelete = join(testDir, "deleted_tracked.txt");

    writeFileSync(cleanTracked, "clean tracked initial\n");
    writeFileSync(dirtyTracked, "dirty tracked initial\n");
    writeFileSync(dirtySpacedTracked, "dirty spaced initial\n");
    writeFileSync(dirtyQuotedTracked, "dirty quoted initial\n");
    writeFileSync(trackedToDelete, "to be deleted initial\n");

    execSync("git add .", { cwd: testDir, stdio: "ignore" });
    execSync("git commit -m 'initial commit'", { cwd: testDir, stdio: "ignore" });

    // 2. Pre-existing unstaged modifications by user
    writeFileSync(dirtyTracked, "user uncommitted edits dirty\n");
    writeFileSync(dirtySpacedTracked, "user uncommitted edits spaced\n");
    writeFileSync(dirtyQuotedTracked, "user uncommitted edits quoted\n");

    // 3. Pre-existing untracked files by user
    const preUntracked = join(testDir, "pre_untracked.txt");
    const preUntrackedSpaced = join(testDir, "pre untracked spaced.txt");
    const preUntrackedQuoted = join(testDir, 'pre "untracked" quoted.txt');
    writeFileSync(preUntracked, "pre untracked content\n");
    writeFileSync(preUntrackedSpaced, "pre untracked spaced content\n");
    writeFileSync(preUntrackedQuoted, "pre untracked quoted content\n");

    const statusBeforeInitial = execSync("git status --porcelain=v1 -uall", {
      cwd: testDir,
      encoding: "utf8",
    });

    // 4. Create snapshot
    const snapshot = await createProjectSnapshot(testDir);
    expect(snapshot.isGit).toBe(true);

    // 5. Remediation mutations:
    // - Modify clean tracked file
    writeFileSync(cleanTracked, "mutated by remediation\n");
    // - Delete a tracked file
    rmSync(trackedToDelete, { force: true });
    // - Add new untracked artifacts with spaces and quotes
    const newUntracked = join(testDir, "new_untracked.txt");
    const newUntrackedSpaced = join(testDir, "new untracked artifact with spaces.txt");
    const newUntrackedQuoted = join(testDir, 'new "untracked" with quotes.txt');
    writeFileSync(newUntracked, "remediation untracked 1\n");
    writeFileSync(newUntrackedSpaced, "remediation untracked spaced\n");
    writeFileSync(newUntrackedQuoted, "remediation untracked quoted\n");

    // 6. Test async rollback
    const { restoreProjectSnapshot } = await import("./rollback.js");
    await restoreProjectSnapshot(snapshot);

    // 7. Verify disk state after async rollback
    expect(readFileSync(cleanTracked, "utf8")).toBe("clean tracked initial\n");
    expect(readFileSync(dirtyTracked, "utf8")).toBe("user uncommitted edits dirty\n");
    expect(readFileSync(dirtySpacedTracked, "utf8")).toBe("user uncommitted edits spaced\n");
    expect(readFileSync(dirtyQuotedTracked, "utf8")).toBe("user uncommitted edits quoted\n");
    expect(readFileSync(trackedToDelete, "utf8")).toBe("to be deleted initial\n");

    expect(readFileSync(preUntracked, "utf8")).toBe("pre untracked content\n");
    expect(readFileSync(preUntrackedSpaced, "utf8")).toBe("pre untracked spaced content\n");
    expect(readFileSync(preUntrackedQuoted, "utf8")).toBe("pre untracked quoted content\n");

    expect(existsSync(newUntracked)).toBe(false);
    expect(existsSync(newUntrackedSpaced)).toBe(false);
    expect(existsSync(newUntrackedQuoted)).toBe(false);

    const statusAfterAsync = execSync("git status --porcelain=v1 -uall", {
      cwd: testDir,
      encoding: "utf8",
    });
    expect(statusAfterAsync).toBe(statusBeforeInitial);

    // 8. Test sync rollback under identical mutations
    writeFileSync(cleanTracked, "mutated by remediation for sync\n");
    rmSync(trackedToDelete, { force: true });
    writeFileSync(newUntracked, "remediation untracked sync 1\n");
    writeFileSync(newUntrackedSpaced, "remediation untracked sync spaced\n");
    writeFileSync(newUntrackedQuoted, "remediation untracked sync quoted\n");

    restoreProjectSnapshotSync(snapshot);

    expect(readFileSync(cleanTracked, "utf8")).toBe("clean tracked initial\n");
    expect(readFileSync(dirtyTracked, "utf8")).toBe("user uncommitted edits dirty\n");
    expect(readFileSync(dirtySpacedTracked, "utf8")).toBe("user uncommitted edits spaced\n");
    expect(readFileSync(dirtyQuotedTracked, "utf8")).toBe("user uncommitted edits quoted\n");
    expect(readFileSync(trackedToDelete, "utf8")).toBe("to be deleted initial\n");

    expect(existsSync(newUntracked)).toBe(false);
    expect(existsSync(newUntrackedSpaced)).toBe(false);
    expect(existsSync(newUntrackedQuoted)).toBe(false);

    const statusAfterSync = execSync("git status --porcelain=v1 -uall", {
      cwd: testDir,
      encoding: "utf8",
    });
    expect(statusAfterSync).toBe(statusBeforeInitial);
  });
});
