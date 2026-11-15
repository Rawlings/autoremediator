import { afterEach, describe, expect, it } from "vitest";

import { analyzeDependencies } from "./analyze.js";
import { attackSurface, type SurfaceInputs } from "./surface.js";
import { makeProject, removeProjects } from "./tests/project.js";

afterEach(removeProjects);

const none: SurfaceInputs = {
  installedPackages: 0,
  directDependencies: 0,
  maxDepth: 0,
  installScriptPackages: [],
  deprecatedPackages: [],
  manifestsRead: 0,
  certainlyUnused: 0,
  probablyUnused: 0,
  replaceable: 0,
  extraCopies: 0,
  installedMissing: false,
};

describe("the attack-surface formula", () => {
  it("is 0 for nothing installed", () => {
    expect(attackSurface(none).score).toBe(0);
  });

  it("sums six capped components to at most 100", () => {
    const worst = attackSurface({
      ...none,
      installedPackages: 100_000,
      maxDepth: 50,
      installScriptPackages: Array.from({ length: 50 }, (_, i) => `p${i}@1.0.0`),
      deprecatedPackages: Array.from({ length: 50 }, (_, i) => `d${i}@1.0.0`),
      certainlyUnused: 100,
      extraCopies: 100,
    });
    expect(worst.components.map((component) => [component.id, component.points])).toEqual([
      ["size", 30],
      ["depth", 10],
      ["install-scripts", 20],
      ["deprecated", 15],
      ["waste", 15],
      ["duplicates", 10],
    ]);
    expect(worst.score).toBe(100);
    expect(worst.components.reduce((sum, component) => sum + component.maxPoints, 0)).toBe(100);
  });

  it("follows the stated rule for each component", () => {
    const surface = attackSurface({
      ...none,
      installedPackages: 479,
      maxDepth: 5,
      installScriptPackages: ["a@1.0.0", "b@1.0.0", "c@1.0.0"],
      deprecatedPackages: ["x@1.0.0", "y@1.0.0"],
      certainlyUnused: 2,
      probablyUnused: 3,
      replaceable: 1,
      extraCopies: 4,
    });
    const points = Object.fromEntries(
      surface.components.map((component) => [component.id, component.points]),
    );
    expect(points).toEqual({
      size: Math.round(30 * (Math.log(480) / Math.log(2001)) * 10) / 10,
      depth: Math.round(10 * (4 / 9) * 10) / 10,
      "install-scripts": 6,
      deprecated: 5,
      waste: 1.5 * 2 + 0.5 * 3 + 1,
      duplicates: 2,
    });
    expect(surface.score).toBe(
      Math.round(Object.values(points).reduce((sum, value) => sum + value, 0)),
    );
    // Every component carries its formula, so a reader can check the arithmetic.
    for (const component of surface.components)
      expect(component.formula.length).toBeGreaterThan(10);
  });

  it("admits what it cannot see", () => {
    const limits = attackSurface(none).limits.join(" ");
    expect(limits).toMatch(/unmaintained packages are not detected/);
  });
});

describe("install scripts and deprecation, from the lockfile and installed packages", () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": {
        name: "app",
        dependencies: {
          native: "^1.0.0",
          flagged: "^1.0.0",
          old: "^1.0.0",
          gyp: "^1.0.0",
          plain: "^1.0.0",
        },
      },
      "node_modules/native": { version: "1.0.0" },
      "node_modules/flagged": { version: "1.0.0", hasInstallScript: true },
      "node_modules/old": { version: "1.0.0", deprecated: "use new instead" },
      "node_modules/gyp": { version: "1.0.0" },
      "node_modules/plain": { version: "1.0.0" },
    },
  };

  it("reads install scripts from the installed package.json, a binding.gyp, and the lockfile's own flag", async () => {
    const dir = makeProject({
      "package.json": {
        name: "app",
        dependencies: {
          native: "^1.0.0",
          flagged: "^1.0.0",
          old: "^1.0.0",
          gyp: "^1.0.0",
          plain: "^1.0.0",
        },
      },
      "package-lock.json": JSON.stringify(lock),
      "index.js":
        'require("native"); require("flagged"); require("old"); require("gyp"); require("plain");',
      "node_modules/native/package.json": {
        name: "native",
        version: "1.0.0",
        scripts: { postinstall: "node build.js" },
      },
      "node_modules/gyp/package.json": { name: "gyp", version: "1.0.0" },
      "node_modules/gyp/binding.gyp": "{}",
      "node_modules/plain/package.json": {
        name: "plain",
        version: "1.0.0",
        scripts: { test: "node t.js" },
      },
      "node_modules/old/package.json": { name: "old", version: "1.0.0" },
    });
    const { attackSurface: surface } = await analyzeDependencies({ cwd: dir });
    expect(surface.facts.installScriptPackages).toEqual([
      "flagged@1.0.0",
      "gyp@1.0.0",
      "native@1.0.0",
    ]);
    expect(surface.facts.deprecatedPackages).toEqual(["old@1.0.0"]);
    expect(surface.facts.installedPackages).toBe(5);
    // flagged is not installed: the lockfile's flag is all there is, and the limits say so.
    expect(surface.facts.manifestsRead).toBe(4);
    expect(surface.limits.join(" ")).toMatch(
      /only 4 of 5 installed package.json files could be read/,
    );
  });

  it("counts unused and replaceable dependencies in the score", async () => {
    const dir = makeProject({
      "package.json": { name: "app", dependencies: { ghost: "^1.0.0" }, engines: { node: ">=20" } },
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { ghost: "^1.0.0" } },
          "node_modules/ghost": { version: "1.0.0" },
        },
      }),
      "index.js": "",
      "node_modules/ghost/package.json": { name: "ghost", version: "1.0.0" },
    });
    const { attackSurface: surface, summary } = await analyzeDependencies({ cwd: dir });
    expect(summary.certainlyUnused).toBe(1);
    expect(surface.components.find((component) => component.id === "waste")).toMatchObject({
      value: 1.5,
      points: 1.5,
    });
  });
});
