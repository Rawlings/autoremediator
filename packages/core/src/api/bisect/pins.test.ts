import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyPins, checkLockedVersions } from "./pins.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pins-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const manifest = () =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
const write = (value: unknown) =>
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(value, null, 4)}\n`);

describe("applyPins", () => {
  it("makes a direct dependency exact in every section that declares it, and overrides the rest", () => {
    write({
      name: "app",
      dependencies: { a: "^1.0.0" },
      devDependencies: { a: "^1.0.0", b: "~2.0.0" },
    });
    applyPins({ dir, packageManager: "npm" }, [
      { packageName: "a", version: "1.2.3" },
      { packageName: "b", version: "2.0.9" },
      { packageName: "deep", version: "3.1.0" },
    ]);
    expect(manifest()).toEqual({
      name: "app",
      dependencies: { a: "1.2.3" },
      devDependencies: { a: "1.2.3", b: "2.0.9" },
      overrides: { deep: "3.1.0" },
    });
    // The file keeps its own indentation and final newline.
    expect(readFileSync(join(dir, "package.json"), "utf8")).toMatch(/^\{\n {4}"name"/);
    expect(readFileSync(join(dir, "package.json"), "utf8").endsWith("}\n")).toBe(true);
  });

  it("uses resolutions for yarn", () => {
    write({ name: "app", dependencies: {} });
    applyPins({ dir, packageManager: "yarn" }, [{ packageName: "deep", version: "1.0.0" }]);
    expect(manifest()["resolutions"]).toEqual({ deep: "1.0.0" });
  });

  it("uses the pnpm field of package.json before pnpm 11", () => {
    write({ name: "app", pnpm: { overrides: { other: "1.0.0" } } });
    applyPins({ dir, packageManager: "pnpm", pnpmMajor: 10 }, [
      { packageName: "deep", version: "1.0.0" },
    ]);
    expect(manifest()["pnpm"]).toEqual({ overrides: { other: "1.0.0", deep: "1.0.0" } });
  });

  it("writes pnpm-workspace.yaml from pnpm 11, keeping what is already there", () => {
    write({ name: "app", dependencies: { a: "^1.0.0" } });
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "# settings\nlinkWorkspacePackages: false\noverrides:\n  old: 1.0.0\n",
    );
    applyPins({ dir, packageManager: "pnpm", pnpmMajor: 12 }, [
      { packageName: "deep", version: "2.0.0" },
      { packageName: "a", version: "1.0.4" },
    ]);
    const yaml = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("# settings");
    expect(yaml).toContain("linkWorkspacePackages: false");
    expect(yaml).toContain("old: 1.0.0");
    expect(yaml).toContain("deep: 2.0.0");
    expect(yaml).not.toContain("a: 1.0.4");
    expect(manifest()["dependencies"]).toEqual({ a: "1.0.4" });
    expect(manifest()["pnpm"]).toBeUndefined();
  });

  it("creates pnpm-workspace.yaml when there is none", () => {
    write({ name: "app" });
    applyPins({ dir, packageManager: "pnpm", pnpmMajor: 11 }, [
      { packageName: "deep", version: "2.0.0" },
    ]);
    expect(readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8")).toBe(
      "overrides:\n  deep: 2.0.0\n",
    );
  });

  it("does nothing without pins", () => {
    write({ name: "app" });
    applyPins({ dir, packageManager: "npm" }, []);
    expect(manifest()).toEqual({ name: "app" });
  });
});

describe("checkLockedVersions", () => {
  const lock = (versions: Record<string, string>) =>
    JSON.stringify({
      packages: {
        "": {},
        ...Object.fromEntries(
          Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }]),
        ),
      },
    });
  const updates = [
    {
      packageName: "a",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      dependencyScope: "transitive" as const,
    },
    {
      packageName: "b",
      fromVersion: "2.0.0",
      toVersion: "2.1.0",
      dependencyScope: "transitive" as const,
    },
  ];

  it("accepts a state that holds updated packages at the new version and the rest at the old", () => {
    expect(
      checkLockedVersions(
        "package-lock.json",
        lock({ a: "1.1.0", b: "2.0.0" }),
        updates,
        new Set(["a"]),
      ),
    ).toEqual([]);
  });

  it("reports a pin that did not take effect, and a package that drifted", () => {
    const mismatches = checkLockedVersions(
      "package-lock.json",
      lock({ a: "1.0.0", b: "2.1.0" }),
      updates,
      new Set(["a"]),
    );
    expect(mismatches).toEqual([
      { packageName: "a", expected: "1.1.0", found: ["1.0.0"] },
      { packageName: "b", expected: "2.0.0", found: ["2.1.0"] },
    ]);
  });

  it("reports a package that is missing", () => {
    expect(
      checkLockedVersions("package-lock.json", lock({ a: "1.1.0" }), updates, new Set(["a"])),
    ).toEqual([{ packageName: "b", expected: "2.0.0", found: [] }]);
  });
});
