import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";

import semver from "semver";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { analyzeDependencies } from "./analyze.js";
import { nodeHas, REPLACEMENTS, replacementFor } from "./replaceable.js";
import { installed, makeProject, removeProjects } from "./testing/project.js";
import type { DependencyDietReport } from "./types.js";

afterEach(removeProjects);

const nodeRequire = createRequire(import.meta.url);
beforeAll(() => {
  (globalThis as { require?: NodeJS.Require }).require = nodeRequire;
});
afterAll(() => {
  delete (globalThis as { require?: NodeJS.Require }).require;
});

describe("the replacement table", () => {
  it("is well-formed: unique packages, valid Node ranges, a source and a migration for each", () => {
    const names = REPLACEMENTS.map((row) => row.package);
    expect(new Set(names).size).toBe(names.length);
    for (const row of REPLACEMENTS) {
      expect(semver.validRange(row.nodeRange)).not.toBeNull();
      expect(row.migration).toContain("->");
      expect(row.source).toMatch(/^https:\/\/(nodejs\.org|developer\.mozilla\.org)\//);
    }
  });

  it("names the documented micro-packages", () => {
    for (const name of [
      "left-pad",
      "is-number",
      "array-flatten",
      "object-assign",
      "rimraf",
      "mkdirp",
      "uuid",
      "node-fetch",
      "pify",
    ]) {
      expect(replacementFor(name)).toBeDefined();
    }
  });

  it.each(REPLACEMENTS.map((row) => [row.package, row] as const))(
    "%s: the replacement runs here and gives the documented result",
    (_name, row) => {
      // The example runs as an expression in this process, with `require` available.
      expect(String(runInThisContext(row.example.after))).toBe(row.example.result);
    },
  );

  it("only gives rows a Node range the replacement's own API history supports (spot checks)", () => {
    // Each of these is the version nodejs.org's API history or MDN's compat data lists as the first release.
    const added: Record<string, string> = {
      "left-pad": "8.0.0",
      "array-flatten": "11.0.0",
      "object-assign": "4.0.0",
      rimraf: "14.14.0",
      mkdirp: "10.12.0",
      "make-dir": "10.12.0",
      pify: "8.0.0",
      globalthis: "12.0.0",
      has: "16.9.0",
      "os-homedir": "2.3.0",
    };
    for (const [name, version] of Object.entries(added)) {
      expect(semver.minVersion(replacementFor(name)!.nodeRange)!.version).toBe(version);
    }
    // crypto.randomUUID is in 14.17.0 and 15.6.0 and later, but not 15.0.0 to 15.5.x.
    expect(
      nodeHas(
        { range: ">=15.0.0", source: "engines.node", file: "package.json" },
        replacementFor("uuid")!.nodeRange,
      ),
    ).toBe(false);
    expect(
      nodeHas(
        { range: ">=15.6.0", source: "engines.node", file: "package.json" },
        replacementFor("uuid")!.nodeRange,
      ),
    ).toBe(true);
    expect(
      nodeHas(
        { range: "^14.17.0 || >=16", source: "engines.node", file: "package.json" },
        replacementFor("uuid")!.nodeRange,
      ),
    ).toBe(true);
  });
});

const replaceable = (report: DependencyDietReport, index = 0) =>
  Object.fromEntries(
    report.packages[index]!.replaceable.map((entry) => [entry.name, entry.status]),
  );

/** A project that imports the given packages and declares them, with an optional Node floor. */
function project(
  dependencies: string[],
  extra: Record<string, string | object> = {},
  engines?: string,
): string {
  const dir = makeProject({
    "package.json": {
      name: "app",
      dependencies: Object.fromEntries(dependencies.map((name) => [name, "^1.0.0"])),
      ...(engines ? { engines: { node: engines } } : {}),
    },
    "index.js": `${dependencies.map((name, i) => `const m${i} = require(${JSON.stringify(name)});`).join("\n")}\nmodule.exports = [];\n`,
    ...extra,
  });
  installed(dir, Object.fromEntries(dependencies.map((name) => [name, true])));
  return dir;
}

describe("gating by the project's Node range", () => {
  it("replaceable when every declared Node version has the API", async () => {
    const report = await analyzeDependencies({
      cwd: project(["rimraf", "mkdirp", "left-pad"], {}, ">=18"),
    });
    expect(replaceable(report)).toEqual({
      rimraf: "replaceable",
      mkdirp: "replaceable",
      "left-pad": "replaceable",
    });
    expect(report.summary.replaceable).toBe(3);
  });

  it("never replaceable when the declared range reaches below the API", async () => {
    const report = await analyzeDependencies({
      cwd: project(["rimraf", "mkdirp", "left-pad", "array-flatten"], {}, ">=10"),
    });
    // fs.rm is 14.14.0, mkdir recursive 10.12.0, padStart 8.0.0, flat 11.0.0.
    expect(replaceable(report)).toEqual({
      rimraf: "blocked-by-node",
      mkdirp: "blocked-by-node",
      "left-pad": "replaceable",
      "array-flatten": "blocked-by-node",
    });
    expect(report.summary.replaceable).toBe(1);
    const rimraf = report.packages[0]!.replaceable.find((entry) => entry.name === "rimraf")!;
    expect(rimraf.reason).toMatch(/includes versions without fs\.rm/);
  });

  it("is blocked by a disjunction whose lowest branch is too old", async () => {
    const report = await analyzeDependencies({
      cwd: project(["rimraf"], {}, "^12.0.0 || ^18.0.0 || ^20.0.0"),
    });
    expect(replaceable(report)).toEqual({ rimraf: "blocked-by-node" });
  });

  it("is blocked by an open range such as * or none at all", async () => {
    expect(replaceable(await analyzeDependencies({ cwd: project(["rimraf"], {}, "*") }))).toEqual({
      rimraf: "blocked-by-node",
    });
  });

  it("makes no claim when the project declares no Node minimum", async () => {
    const report = await analyzeDependencies({ cwd: project(["rimraf"]) });
    expect(replaceable(report)).toEqual({ rimraf: "unknown-node" });
    expect(report.summary.replaceable).toBe(0);
    expect(report.packages[0]!.replaceable[0]!.reason).toMatch(/declares no minimum/);
  });

  it("reads .nvmrc and .node-version as the floor when engines is absent", async () => {
    const nvmrc = await analyzeDependencies({
      cwd: project(["rimraf"], { ".nvmrc": "v20.11.0\n" }),
    });
    expect(replaceable(nvmrc)).toEqual({ rimraf: "replaceable" });
    expect(nvmrc.packages[0]!.node).toMatchObject({ source: ".nvmrc", range: ">=20.11.0" });

    const low = await analyzeDependencies({
      cwd: project(["rimraf"], { ".node-version": "12\n" }),
    });
    expect(replaceable(low)).toEqual({ rimraf: "blocked-by-node" });
  });

  it("does not guess from an alias such as lts/*", async () => {
    const report = await analyzeDependencies({ cwd: project(["rimraf"], { ".nvmrc": "lts/*\n" }) });
    expect(replaceable(report)).toEqual({ rimraf: "unknown-node" });
    expect(report.packages[0]!.node).toBeUndefined();
  });

  it("prefers engines.node over .nvmrc", async () => {
    const report = await analyzeDependencies({
      cwd: project(["rimraf"], { ".nvmrc": "22\n" }, ">=12"),
    });
    expect(replaceable(report)).toEqual({ rimraf: "blocked-by-node" });
    expect(report.packages[0]!.node?.source).toBe("engines.node");
  });

  it("handles crypto.randomUUID's gap at Node 15.0 to 15.5", async () => {
    const at15 = await analyzeDependencies({
      cwd: project(
        ["uuid"],
        { "index.js": 'const { v4 } = require("uuid");\nv4();\n' },
        ">=15.0.0",
      ),
    });
    expect(replaceable(at15)).toEqual({ uuid: "blocked-by-node" });
    const at16 = await analyzeDependencies({
      cwd: project(
        ["uuid"],
        { "index.js": 'const { v4 } = require("uuid");\nv4();\n' },
        ">=16.0.0",
      ),
    });
    expect(replaceable(at16)).toEqual({ uuid: "replaceable" });
  });

  it("inherits the workspace root's engines for a package that declares none", async () => {
    const dir = makeProject({
      "package.json": { name: "root", private: true, engines: { node: ">=20" } },
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/a/package.json": { name: "a", dependencies: { rimraf: "1" } },
      "packages/a/index.js": 'require("rimraf");\n',
    });
    installed(dir, { rimraf: true });
    const report = await analyzeDependencies({ cwd: dir });
    expect(replaceable(report, 1)).toEqual({ rimraf: "replaceable" });
    expect(report.packages[1]!.node?.file).toBe("package.json");
  });
});

describe("what the source actually uses", () => {
  const v4Only = 'const { v4: id } = require("uuid");\nmodule.exports = id();\n';

  it("uuid is replaceable only when v4 is the only export imported", async () => {
    const report = await analyzeDependencies({
      cwd: project(["uuid"], { "index.js": v4Only }, ">=18"),
    });
    expect(replaceable(report)).toEqual({ uuid: "replaceable" });
  });

  it.each([
    ["another version", 'const { v4, v5 } = require("uuid");\n'],
    ["the default export", 'const uuid = require("uuid");\n'],
    ["a namespace import", 'import * as uuid from "uuid";\n'],
    ["a member access that is not v4", 'const x = require("uuid").validate("a");\n'],
  ])("uuid is not covered when the source uses %s", async (_label, source) => {
    const dir = project(["uuid"], { "index.mjs": source, "index.js": "" }, ">=18");
    expect(replaceable(await analyzeDependencies({ cwd: dir }))).toEqual({ uuid: "not-covered" });
  });

  it("does not offer a replacement for a dependency that is unused anyway", async () => {
    const dir = makeProject({
      "package.json": { name: "app", dependencies: { rimraf: "1" }, engines: { node: ">=20" } },
      "index.js": "module.exports = 1;\n",
    });
    installed(dir, { rimraf: true });
    const report = await analyzeDependencies({ cwd: dir });
    expect(replaceable(report)).toEqual({});
    expect(report.packages[0]!.unused[0]).toMatchObject({
      name: "rimraf",
      classification: "certainly-unused",
    });
  });
});
