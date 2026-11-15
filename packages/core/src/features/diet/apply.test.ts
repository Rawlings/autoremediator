import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { verify } from "../verify/verifier.js";
import { removeCommand, removeUnusedDependenciesWith, type DietDeps } from "./apply.js";
import { installed, makeProject, removeProjects } from "./testing/project.js";

afterEach(removeProjects);

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });

/** Commit the project so the verifier's scope check can tell what a change touched. */
function commit(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

/**
 * A project with one used dependency, one certainly unused, one probably unused (a plugin nothing
 * names), and rimraf, which is replaceable but used. The package manager is replaced by an edit of
 * package.json and the lockfile, which is all `npm uninstall` does to files that are tracked.
 */
function fixture(extra: Record<string, string | object> = {}): string {
  const dir = makeProject({
    "package.json": {
      name: "app",
      version: "1.0.0",
      engines: { node: ">=20" },
      scripts: { test: "node index.js" },
      dependencies: {
        used: "^1.0.0",
        orphan: "^1.0.0",
        "eslint-plugin-maybe": "^1.0.0",
        rimraf: "^6.0.0",
      },
    },
    "package-lock.json": `${JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { used: "^1.0.0", orphan: "^1.0.0" } } } }, null, 2)}\n`,
    "index.js": 'require("used"); require("rimraf");\n',
    ".gitignore": "node_modules\n.autoremediator\n",
    ...extra,
  });
  installed(dir, { used: true, orphan: true, "eslint-plugin-maybe": true, rimraf: true });
  commit(dir);
  return dir;
}

function fakeRemove(edit?: (dir: string) => void): DietDeps["remove"] {
  return async ({ root, names }) => {
    const manifest = JSON.parse(read(root, "package.json")) as {
      dependencies: Record<string, string>;
    };
    for (const name of names) delete manifest.dependencies[name];
    writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(root, "package-lock.json"),
      `${JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: manifest.dependencies } } }, null, 2)}\n`,
    );
    edit?.(root);
  };
}

/** The real verifier, limited to the checks that need no registry or install. */
const realVerify: DietDeps["verify"] = (request) =>
  verify({ ...request, checks: ["scope", "policy", "tests"] });

const deps = (overrides: Partial<DietDeps> = {}): DietDeps => ({
  remove: fakeRemove(),
  reinstall: vi.fn(async () => undefined),
  verify: realVerify,
  ...overrides,
});

describe("removeUnusedDependencies", () => {
  it("removes only the certainly-unused dependencies and keeps the rest", async () => {
    const dir = fixture();
    const remove = vi.fn(fakeRemove());
    const result = await removeUnusedDependenciesWith({ cwd: dir }, deps({ remove }));

    expect(result.status).toBe("removed");
    expect(result.removals).toEqual([
      { dir: ".", name: "orphan", section: "dependencies", range: "^1.0.0" },
    ]);
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ names: ["orphan"], dir: ".", packageManager: "npm" }),
    );
    expect(JSON.parse(read(dir, "package.json")).dependencies).toEqual({
      used: "^1.0.0",
      "eslint-plugin-maybe": "^1.0.0",
      rimraf: "^6.0.0",
    });
    // The plugin nothing names is only "probably unused", rimraf is replaceable but used: neither is touched.
    expect(
      result.report.packages[0]!.unused.map((entry) => [entry.name, entry.classification]),
    ).toEqual([
      ["eslint-plugin-maybe", "probably-unused"],
      ["orphan", "certainly-unused"],
    ]);
    expect(result.report.packages[0]!.replaceable.map((entry) => entry.name)).toEqual(["rimraf"]);
    expect(result.verification?.passed).toBe(true);
    expect(result.verification?.checks.map((check) => [check.name, check.status])).toEqual([
      ["scope", "passed"],
      ["policy", "passed"],
      ["tests", "skipped"],
    ]);
  });

  it("rolls back when verification fails: manifest and lockfile are restored byte for byte", async () => {
    const dir = fixture();
    const manifestBefore = read(dir, "package.json");
    const lockBefore = read(dir, "package-lock.json");
    const reinstall = vi.fn(async () => undefined);

    // Removing "orphan" breaks the project's tests, which the verifier runs and the removal cannot pass.
    writeFileSync(
      join(dir, "package.json"),
      manifestBefore.replace(
        '"test": "node index.js"',
        String.raw`"test": "node -e \"process.exit(1)\""`,
      ),
    );
    git(dir, "commit", "-q", "-am", "failing test script");
    const manifestWithFailingTest = read(dir, "package.json");

    const result = await removeUnusedDependenciesWith(
      { cwd: dir, runTests: true },
      deps({ reinstall }),
    );

    expect(result.status).toBe("rolled-back");
    expect(result.verification?.passed).toBe(false);
    expect(result.verification?.failedCheck).toBe("tests");
    expect(result.message).toMatch(/Verification failed \(tests\)/);
    expect(read(dir, "package.json")).toBe(manifestWithFailingTest);
    expect(read(dir, "package-lock.json")).toBe(lockBefore);
    expect(reinstall).toHaveBeenCalledTimes(1);
    // The project is as it was committed.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  });

  it("rolls back a removal that touched anything beyond dependency files", async () => {
    const dir = fixture();
    const before = read(dir, "index.js");
    const result = await removeUnusedDependenciesWith(
      { cwd: dir },
      deps({
        remove: fakeRemove((root) =>
          writeFileSync(join(root, "index.js"), "// rewritten by something\n"),
        ),
      }),
    );
    expect(result.status).toBe("rolled-back");
    expect(result.verification?.failedCheck).toBe("scope");
    expect(read(dir, "index.js")).toBe(before);
    expect(JSON.parse(read(dir, "package.json")).dependencies.orphan).toBe("^1.0.0");
  });

  it("restores everything and reports failed when the package manager itself fails", async () => {
    const dir = fixture();
    const manifestBefore = read(dir, "package.json");
    const result = await removeUnusedDependenciesWith(
      { cwd: dir },
      deps({
        remove: async (request) => {
          await fakeRemove()(request);
          throw new Error("ERESOLVE could not resolve");
        },
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/ERESOLVE could not resolve/);
    expect(read(dir, "package.json")).toBe(manifestBefore);
  });

  it("says when a failed reinstall leaves node_modules to the user", async () => {
    const dir = fixture();
    const result = await removeUnusedDependenciesWith(
      { cwd: dir, runTests: true },
      deps({
        verify: async (request) => ({
          ...(await realVerify(request)),
          passed: false,
          failedCheck: "tests" as const,
        }),
        reinstall: async () => {
          throw new Error("offline");
        },
      }),
    );
    expect(result.status).toBe("rolled-back");
    expect(result.message).toMatch(/reinstalling the restored lockfile failed: offline/);
  });

  it("does nothing, and never calls the package manager, when nothing is certainly unused", async () => {
    const dir = makeProject({
      "package.json": { name: "app", dependencies: { used: "1" } },
      "index.js": 'require("used");\n',
    });
    installed(dir, { used: true });
    const remove = vi.fn();
    const result = await removeUnusedDependenciesWith({ cwd: dir }, deps({ remove }));
    expect(result.status).toBe("nothing-to-remove");
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses package managers it cannot drive, naming what to remove by hand", async () => {
    const dir = fixture();
    await expect(
      removeUnusedDependenciesWith({ cwd: dir, packageManager: "yarn" }, deps()),
    ).rejects.toThrow(/supports npm and pnpm.*orphan/);
  });

  it("removes from each workspace package it belongs to", async () => {
    const dir = makeProject({
      "package.json": { name: "root", private: true },
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "packages/a/package.json": { name: "a", dependencies: { "a-orphan": "1", "a-used": "1" } },
      "packages/a/index.js": 'require("a-used");\n',
      "packages/b/package.json": { name: "b", devDependencies: { "b-orphan": "1" } },
      "packages/b/index.js": "",
      ".gitignore": "node_modules\n.autoremediator\n",
    });
    installed(dir, { "a-orphan": true, "a-used": true, "b-orphan": true });
    commit(dir);
    const calls: { dir: string; names: string[] }[] = [];
    const result = await removeUnusedDependenciesWith(
      { cwd: dir },
      deps({
        remove: async ({ root, dir: target, names }) => {
          calls.push({ dir: target, names });
          const file = join(root, target, "package.json");
          const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<
            string,
            Record<string, string> | undefined
          >;
          for (const section of ["dependencies", "devDependencies"])
            for (const name of names) delete manifest[section]?.[name];
          writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
        },
      }),
    );
    expect(result.status).toBe("removed");
    expect(calls).toEqual([
      { dir: "packages/a", names: ["a-orphan"] },
      { dir: "packages/b", names: ["b-orphan"] },
    ]);
  });
});

describe("removeCommand", () => {
  it("builds npm and pnpm commands that run no lifecycle scripts", () => {
    expect(removeCommand("npm", ".", ["a", "b"], false)).toEqual([
      "npm",
      "uninstall",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--",
      "a",
      "b",
    ]);
    expect(removeCommand("npm", "packages/x", ["a"], true)).toEqual([
      "npm",
      "uninstall",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--workspace",
      "packages/x",
      "--",
      "a",
    ]);
    expect(removeCommand("pnpm", ".", ["a"], false)).toEqual([
      "pnpm",
      "remove",
      "--ignore-scripts",
      "--",
      "a",
    ]);
    expect(removeCommand("pnpm", ".", ["a"], true)).toEqual([
      "pnpm",
      "remove",
      "--workspace-root",
      "--ignore-scripts",
      "--",
      "a",
    ]);
    expect(removeCommand("pnpm", "packages/x", ["a"], true)).toEqual([
      "pnpm",
      "--filter",
      "./packages/x",
      "remove",
      "--ignore-scripts",
      "--",
      "a",
    ]);
  });

  it("refuses a name that is not a package name, so it can never be read as an option", () => {
    for (const name of ["--prefix=/x", "-g", "a b", "../x"]) {
      expect(() => removeCommand("npm", ".", [name], false)).toThrow(/not a valid package name/);
    }
  });
});

describe("with the real npm and the real verifier", () => {
  /** Local `file:` dependencies, so npm needs no registry. */
  function localProject(testScript: string, extra: Record<string, string> = {}): string {
    const dir = makeProject({
      "package.json": {
        name: "app",
        version: "1.0.0",
        private: true,
        scripts: { test: testScript },
        dependencies: { used: "file:vendor/used", orphan: "file:vendor/orphan" },
      },
      "index.js": 'console.log(require("used"));\n',
      "vendor/used/package.json": { name: "used", version: "1.0.0", main: "i.js" },
      "vendor/used/i.js": "module.exports = 1;\n",
      "vendor/orphan/package.json": { name: "orphan", version: "1.0.0", main: "i.js" },
      "vendor/orphan/i.js": "module.exports = 2;\n",
      ".gitignore": "node_modules\n.autoremediator\n",
      ...extra,
    });
    execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts"], {
      cwd: dir,
      stdio: "ignore",
    });
    commit(dir);
    return dir;
  }

  it("removes the unused dependency and the frozen install, and the tests, still pass", async () => {
    const dir = localProject("node index.js");
    const { removeUnusedDependencies } = await import("./apply.js");
    const result = await removeUnusedDependencies({ cwd: dir, runTests: true, typecheck: false });
    expect(result.status).toBe("removed");
    expect(result.verification?.checks.map((check) => [check.name, check.status])).toEqual([
      ["scope", "passed"],
      ["policy", "passed"],
      ["install", "passed"],
      ["typecheck", "skipped"],
      ["tests", "passed"],
    ]);
    expect(Object.keys(JSON.parse(read(dir, "package.json")).dependencies)).toEqual(["used"]);
    expect(read(dir, "package-lock.json")).not.toContain("orphan");
  }, 120_000);

  it("puts the project back when the tests fail after the removal", async () => {
    // The tests pass only while the package is still installed: removing it breaks them.
    const dir = localProject("node check.js", {
      "check.js": "process.exit(require('node:fs').existsSync('node_modules/orphan') ? 0 : 1);\n",
    });
    const manifestBefore = read(dir, "package.json");
    const lockBefore = read(dir, "package-lock.json");
    const { removeUnusedDependencies } = await import("./apply.js");
    const result = await removeUnusedDependencies({ cwd: dir, runTests: true, typecheck: false });
    expect(result.status).toBe("rolled-back");
    expect(result.verification?.failedCheck).toBe("tests");
    expect(read(dir, "package.json")).toBe(manifestBefore);
    expect(read(dir, "package-lock.json")).toBe(lockBefore);
    // The restored lockfile was reinstalled, so the package is back in node_modules.
    expect(
      execFileSync(
        "node",
        ["-e", "process.stdout.write(String(require('fs').existsSync('node_modules/orphan')))"],
        { cwd: dir, encoding: "utf8" },
      ),
    ).toBe("true");
  }, 120_000);

  it("does the same with pnpm: remove, frozen install, tests", async () => {
    const dir = makeProject({
      "package.json": {
        name: "app",
        version: "1.0.0",
        private: true,
        scripts: { test: "node index.js" },
        dependencies: { used: "file:vendor/used", orphan: "file:vendor/orphan" },
      },
      "index.js": 'console.log(require("used"));\n',
      "vendor/used/package.json": { name: "used", version: "1.0.0", main: "i.js" },
      "vendor/used/i.js": "module.exports = 1;\n",
      "vendor/orphan/package.json": { name: "orphan", version: "1.0.0", main: "i.js" },
      "vendor/orphan/i.js": "module.exports = 2;\n",
      ".gitignore": "node_modules\n.autoremediator\n",
    });
    execFileSync("pnpm", ["install", "--offline", "--ignore-scripts", "--ignore-workspace"], {
      cwd: dir,
      stdio: "ignore",
    });
    commit(dir);
    const { removeUnusedDependencies } = await import("./apply.js");
    const result = await removeUnusedDependencies({ cwd: dir, runTests: true, typecheck: false });
    expect(result.status).toBe("removed");
    expect(result.verification?.checks.find((check) => check.name === "install")?.status).toBe(
      "passed",
    );
    expect(Object.keys(JSON.parse(read(dir, "package.json")).dependencies)).toEqual(["used"]);
    expect(read(dir, "pnpm-lock.yaml")).not.toContain("orphan");
  }, 120_000);
});
