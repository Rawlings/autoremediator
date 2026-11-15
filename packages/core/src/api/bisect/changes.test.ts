import { describe, expect, it } from "vitest";

import { directDependencyNames, lockfileChanges } from "./changes.js";

const npmLock = (packages: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "app" },
      ...Object.fromEntries(Object.entries(packages).map(([key, version]) => [key, { version }])),
    },
  });

const pnpmLock = (packages: string[]) =>
  `lockfileVersion: '9.0'\npackages:\n${packages.map((entry) => `  ${entry}:\n    resolution: {integrity: x}\n`).join("")}`;

describe("lockfileChanges", () => {
  it("lists packages whose single locked version changed, with direct or transitive scope", () => {
    const good = npmLock({ "node_modules/a": "1.0.0", "node_modules/b": "1.0.0", "node_modules/same": "2.0.0" });
    const bad = npmLock({ "node_modules/a": "1.0.1", "node_modules/b": "1.1.0", "node_modules/same": "2.0.0" });
    const { updates, skipped } = lockfileChanges("package-lock.json", good, bad, new Set(["a"]));
    expect(updates).toEqual([
      { packageName: "a", fromVersion: "1.0.0", toVersion: "1.0.1", dependencyScope: "direct" },
      { packageName: "b", fromVersion: "1.0.0", toVersion: "1.1.0", dependencyScope: "transitive" },
    ]);
    expect(skipped).toEqual([]);
  });

  it("does not guess at packages that were added, removed or exist in several versions", () => {
    const good = npmLock({
      "node_modules/gone": "1.0.0",
      "node_modules/multi": "1.0.0",
      "node_modules/x/node_modules/multi": "2.0.0",
    });
    const bad = npmLock({
      "node_modules/new": "3.0.0",
      "node_modules/multi": "1.5.0",
      "node_modules/x/node_modules/multi": "2.0.0",
    });
    const { updates, skipped } = lockfileChanges("package-lock.json", good, bad, new Set());
    expect(updates).toEqual([]);
    expect(skipped.map((item) => [item.packageName, item.reason])).toEqual([
      ["gone", "removed at the bad ref"],
      ["multi", "several versions are locked, so a single pin cannot stand for it"],
      ["new", "added at the bad ref"],
    ]);
  });

  it("reads pnpm lockfiles, ignoring peer-dependency suffixes", () => {
    const good = pnpmLock(["foo@1.0.0", "'@scope/bar@2.0.0(react@18.0.0)'", "baz@1.0.0"]);
    const bad = pnpmLock(["foo@1.0.1", "'@scope/bar@2.1.0(react@18.0.0)'", "baz@1.0.0"]);
    const { updates } = lockfileChanges("pnpm-lock.yaml", good, bad, new Set(["foo"]));
    expect(updates).toEqual([
      { packageName: "@scope/bar", fromVersion: "2.0.0", toVersion: "2.1.0", dependencyScope: "transitive" },
      { packageName: "foo", fromVersion: "1.0.0", toVersion: "1.0.1", dependencyScope: "direct" },
    ]);
  });

  it("reads yarn classic lockfiles", () => {
    const lock = (version: string) =>
      `# yarn lockfile v1\n\n\nfoo@^1.0.0:\n  version "${version}"\n  resolved "https://example.test/foo-${version}.tgz"\n`;
    const { updates } = lockfileChanges("yarn.lock", lock("1.0.0"), lock("1.2.0"), new Set());
    expect(updates).toEqual([
      { packageName: "foo", fromVersion: "1.0.0", toVersion: "1.2.0", dependencyScope: "transitive" },
    ]);
  });

  it("reports a downgrade as a change too", () => {
    const { updates } = lockfileChanges(
      "package-lock.json",
      npmLock({ "node_modules/a": "2.0.0" }),
      npmLock({ "node_modules/a": "1.9.0" }),
      new Set(),
    );
    expect(updates).toMatchObject([{ packageName: "a", fromVersion: "2.0.0", toVersion: "1.9.0" }]);
  });
});

describe("directDependencyNames", () => {
  it("collects runtime, dev and optional dependencies, not peers", () => {
    const names = directDependencyNames({
      dependencies: { a: "1" },
      devDependencies: { b: "1" },
      optionalDependencies: { c: "1" },
      peerDependencies: { d: "1" },
    } as never);
    expect([...names].toSorted()).toEqual(["a", "b", "c"]);
    expect(directDependencyNames(undefined).size).toBe(0);
  });
});
