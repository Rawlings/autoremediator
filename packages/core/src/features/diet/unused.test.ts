import { afterEach, describe, expect, it } from "vitest";

import { analyzeDependencies } from "./analyze.js";
import { installed, makeProject, removeProjects } from "./testing/project.js";
import type { DependencyDietReport } from "./types.js";

afterEach(removeProjects);

/** name -> classification for the first package; absent means the dependency is used (imported). */
function classes(report: DependencyDietReport, index = 0): Record<string, string> {
  return Object.fromEntries(
    report.packages[index]!.unused.map((entry) => [entry.name, entry.classification]),
  );
}

const manifest = (dependencies: string[], extra: object = {}) => ({
  name: "app",
  version: "1.0.0",
  dependencies: Object.fromEntries(dependencies.map((name) => [name, "^1.0.0"])),
  ...extra,
});

describe("imports are uses", () => {
  it("counts ESM, CommonJS, dynamic, re-export, resolve and type references as use", async () => {
    const dir = makeProject({
      "package.json": manifest([
        "a-esm",
        "b-cjs",
        "c-dynamic",
        "d-reexport",
        "e-resolve",
        "f-type",
        "g-destructure",
        "h-member",
        "i-meta",
        "@s/scoped",
        "j-equals",
        "k-ref",
      ]),
      "src/index.ts": [
        'import a from "a-esm";',
        'import type { T } from "f-type";',
        'export * from "d-reexport";',
        'import jEquals = require("j-equals");',
        '/// <reference types="k-ref" />',
        'import { x } from "@s/scoped/deep/path";',
        "export const lazy = () => import('c-dynamic');",
        "export const where = import.meta.resolve('i-meta');",
        "export default [a, x, jEquals];",
      ].join("\n"),
      "src/legacy.cjs": [
        'const b = require("b-cjs");',
        'const { one, two: renamed } = require("g-destructure");',
        'const m = require("h-member").thing;',
        'module.exports = require.resolve("e-resolve") + b + one + renamed + m;',
      ].join("\n"),
    });
    installed(dir, { "a-esm": true, "b-cjs": true });
    const report = await analyzeDependencies({ cwd: dir });
    expect(report.packages[0]!.unused).toEqual([]);
    expect(report.packages[0]!.counts.used).toBe(12);
  });

  it("records which exports are taken", async () => {
    const dir = makeProject({
      "package.json": manifest(["uuid"]),
      "index.js": 'const { v4, v1: legacy } = require("uuid");\nmodule.exports = [v4, legacy];\n',
    });
    // Symbols matter to the replaceable table: see replaceable.test.ts. Here only that it counts as used.
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({});
  });
});

describe("certainly unused", () => {
  it("is declared, installed, with no import, string, script, config, command or peer link", async () => {
    const dir = makeProject({
      "package.json": manifest(["used", "orphan"], { scripts: { test: "node --test" } }),
      "index.js": 'require("used");\n',
    });
    installed(dir, { used: true, orphan: true });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({ orphan: "certainly-unused" });
    expect(report.summary.certainlyUnused).toBe(1);
  });
});

describe("used indirectly", () => {
  it("follows configuration: eslint shorthand, babel presets, jest presets, tsconfig types and extends", async () => {
    const dir = makeProject({
      "package.json": {
        name: "app",
        devDependencies: Object.fromEntries(
          [
            "eslint-config-airbnb",
            "eslint-plugin-react",
            "@typescript-eslint/eslint-plugin",
            "@babel/preset-env",
            "ts-jest",
            "@types/jest",
            "@tsconfig/node20",
            "babel-plugin-styled-components",
          ].map((name) => [name, "1.0.0"]),
        ),
      },
      ".eslintrc.json": {
        extends: ["airbnb", "plugin:react/recommended", "plugin:@typescript-eslint/recommended"],
      },
      ".babelrc": { presets: ["@babel/env"], plugins: ["styled-components"] },
      "jest.config.js": 'module.exports = { preset: "ts-jest" };\n',
      "tsconfig.json": {
        extends: "@tsconfig/node20/tsconfig.json",
        compilerOptions: { types: ["jest"] },
      },
      "index.ts": "export {};\n",
    });
    installed(
      dir,
      Object.fromEntries(
        [
          "eslint-config-airbnb",
          "eslint-plugin-react",
          "@typescript-eslint/eslint-plugin",
          "@babel/preset-env",
          "ts-jest",
          "@types/jest",
          "@tsconfig/node20",
          "babel-plugin-styled-components",
        ].map((name) => [name, true]),
      ),
    );
    const report = await analyzeDependencies({ cwd: dir });
    expect(Object.values(classes(report))).toEqual(
      Array.from({ length: 8 }, () => "used-indirectly"),
    );
  });

  it("follows a package's commands in scripts, npx, .bin paths, git hooks and CI workflows", async () => {
    const dir = makeProject({
      "package.json": {
        name: "app",
        scripts: {
          build: "tx --out dist && echo done",
          lint: "npx lintbin@latest .",
          fmt: "./node_modules/.bin/fmtbin --check",
        },
        devDependencies: {
          "tool-x": "1",
          "lint-tool": "1",
          "fmt-tool": "1",
          "hook-tool": "1",
          "ci-tool": "1",
          "never-run": "1",
        },
      },
      ".husky/pre-commit": "#!/bin/sh\nhooktool-run staged\n",
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - run: pnpm exec ci-bin --strict\n",
    });
    installed(dir, {
      "tool-x": { bin: { tx: "bin.js" } },
      "lint-tool": { bin: { lintbin: "bin.js" } },
      "fmt-tool": { bin: { fmtbin: "bin.js" } },
      "hook-tool": { bin: { "hooktool-run": "bin.js" } },
      "ci-tool": { bin: { "ci-bin": "bin.js" } },
      "never-run": { bin: { "never-run": "bin.js" } },
    });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({
      "tool-x": "used-indirectly",
      "lint-tool": "used-indirectly",
      "fmt-tool": "used-indirectly",
      "hook-tool": "used-indirectly",
      "ci-tool": "used-indirectly",
      // Provides a command nothing here runs: it may be run by hand, so never "certainly".
      "never-run": "probably-unused",
    });
    expect(report.packages[0]!.unused.find((entry) => entry.name === "tool-x")!.evidence).toEqual([
      "package.json#scripts.build",
    ]);
  });

  it("follows tool sections of package.json (eslintConfig, jest, babel, lint-staged)", async () => {
    const dir = makeProject({
      "package.json": {
        name: "app",
        devDependencies: { "ts-jest": "1", "lint-staged": "1" },
        jest: { preset: "ts-jest" },
        "lint-staged": { "*.js": "prettier --write" },
      },
      "index.js": "",
    });
    installed(dir, { "ts-jest": true, "lint-staged": { bin: "cli.js" } });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({
      "ts-jest": "used-indirectly",
      "lint-staged": "used-indirectly",
    });
  });

  it("keeps @types packages whose package is used, declared or global", async () => {
    const dir = makeProject({
      "package.json": {
        name: "app",
        dependencies: { express: "1" },
        devDependencies: {
          "@types/express": "1",
          "@types/node": "1",
          "@types/lodash": "1",
          lodash: "1",
          "@types/orphan-lib": "1",
        },
      },
      "tsconfig.json": {},
      "index.ts": 'import express from "express";\nexport default express;\n',
    });
    installed(dir, {
      express: true,
      "@types/express": true,
      "@types/node": true,
      "@types/lodash": true,
      lodash: true,
      "@types/orphan-lib": true,
    });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({
      "@types/express": "used-indirectly",
      "@types/node": "used-indirectly",
      // lodash itself is unused, so its types are unused with it.
      lodash: "certainly-unused",
      "@types/lodash": "certainly-unused",
      // A types package for something neither declared nor imported: could be global types.
      "@types/orphan-lib": "probably-unused",
    });
  });

  it("treats a peer of another dependency, and a development copy of an own peer, as used", async () => {
    const dir = makeProject({
      "package.json": {
        name: "lib",
        devDependencies: { react: "1", "react-dom": "1", "plugin-host": "1", "opt-peer": "1" },
        peerDependencies: { react: "*" },
      },
      "index.js": 'require("plugin-host");\n',
    });
    installed(dir, {
      react: true,
      "react-dom": true,
      "opt-peer": true,
      "plugin-host": {
        peerDependencies: { "react-dom": "*", "opt-peer": "*" },
        peerDependenciesMeta: { "opt-peer": { optional: true } },
      },
    });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({
      react: "used-indirectly",
      "react-dom": "used-indirectly",
      "opt-peer": "used-indirectly",
    });
  });

  it("treats a package named as a string (mock path, plugin list, dynamic specifier) as used", async () => {
    const dir = makeProject({
      "package.json": manifest(["mocked", "listed"]),
      "test/a.test.js":
        'jest.mock("mocked");\nconst plugins = ["listed"];\nmodule.exports = plugins;\n',
    });
    installed(dir, { mocked: true, listed: true });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({ mocked: "used-indirectly", listed: "used-indirectly" });
  });

  it("finds a require in an extensionless script under bin/", async () => {
    const dir = makeProject({
      "package.json": manifest(["commander", "orphan"]),
      "bin/cli":
        '#!/usr/bin/env node\nconst { program } = require("commander");\nprogram.parse();\n',
    });
    installed(dir, { commander: true, orphan: true });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({ commander: "used-indirectly", orphan: "certainly-unused" });
  });

  it("finds imports in Vue and Svelte single-file components", async () => {
    const dir = makeProject({
      "package.json": manifest(["vue-only", "svelte-only", "orphan"]),
      "App.vue": '<script>\nimport thing from "vue-only";\n</script>\n',
      "Page.svelte": "<script>\n  import x from 'svelte-only/sub';\n</script>\n",
    });
    installed(dir, { "vue-only": true, "svelte-only": true, orphan: true });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({
      "vue-only": "used-indirectly",
      "svelte-only": "used-indirectly",
      orphan: "certainly-unused",
    });
  });
});

describe("false-positive guards: never certainly-unused when something could still use it", () => {
  const unusedEverywhere = (
    extra: Record<string, string | object>,
    dependencies = ["ghost"],
    installedDeps: Record<string, object | true> = { ghost: true },
  ) => {
    const dir = makeProject({
      "package.json": manifest(dependencies),
      "index.js": "module.exports = 1;\n",
      ...extra,
    });
    installed(dir, installedDeps);
    return dir;
  };

  it("a file that loads a module by a runtime name", async () => {
    const dir = unusedEverywhere({ "load.js": "module.exports = (name) => require(name);\n" });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({ ghost: "probably-unused" });
    expect(report.packages[0]!.scan.dynamicLoadFiles).toEqual(["load.js"]);
    expect(report.packages[0]!.unused[0]!.reason).toMatch(/only known at runtime/);
  });

  it("is not tripped by a computed relative require", async () => {
    const dir = unusedEverywhere({
      "load.js": ["module.exports = (n) => require(`./plugins/$", "{n}.js`);\n"].join(""),
    });
    expect(classes(await analyzeDependencies({ cwd: dir }))).toEqual({ ghost: "certainly-unused" });
  });

  it("a file the parser could not read", async () => {
    const dir = unusedEverywhere({ "broken.ts": "const = = ;\nimport (\n" });
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({ ghost: "probably-unused" });
    expect(report.packages[0]!.scan.unparsedFiles).toContain("broken.ts");
  });

  it("an unparseable file that names the package is a use", async () => {
    const dir = unusedEverywhere({ "broken.ts": 'const = = ;\nrequire("ghost")\n(' });
    expect(classes(await analyzeDependencies({ cwd: dir }))).toEqual({ ghost: "used-indirectly" });
  });

  it("an optional dependency", async () => {
    const dir = makeProject({
      "package.json": { name: "app", optionalDependencies: { fsevents: "1" } },
      "index.js": "",
    });
    installed(dir, { fsevents: true });
    expect(classes(await analyzeDependencies({ cwd: dir }))).toEqual({
      fsevents: "probably-unused",
    });
  });

  it("a dependency that is not installed, so its commands and peers are unknown", async () => {
    const dir = unusedEverywhere({}, ["ghost"], {});
    const report = await analyzeDependencies({ cwd: dir });
    expect(classes(report)).toEqual({ ghost: "probably-unused" });
    expect(report.notes.join(" ")).toMatch(/not installed/);
  });

  it("a plugin, preset or loader that no configuration names", async () => {
    const dir = unusedEverywhere({}, ["eslint-plugin-ghost", "babel-preset-ghost", "css-loader"], {
      "eslint-plugin-ghost": true,
      "babel-preset-ghost": true,
      "css-loader": true,
    });
    expect(classes(await analyzeDependencies({ cwd: dir }))).toEqual({
      "eslint-plugin-ghost": "probably-unused",
      "babel-preset-ghost": "probably-unused",
      "css-loader": "probably-unused",
    });
  });

  it("a project with no source files at all", async () => {
    const dir = makeProject({ "package.json": manifest(["ghost"]) });
    installed(dir, { ghost: true });
    expect(classes(await analyzeDependencies({ cwd: dir }))).toEqual({ ghost: "probably-unused" });
  });

  it("@types/node without any TypeScript", async () => {
    const dir = makeProject({
      "package.json": { name: "app", devDependencies: { "@types/node": "1" } },
      "index.js": "",
    });
    installed(dir, { "@types/node": true });
    expect(classes(await analyzeDependencies({ cwd: dir }))).toEqual({
      "@types/node": "probably-unused",
    });
  });
});

describe("what is scanned", () => {
  it("scans a build directory .gitignore does not exclude, and skips one it does", async () => {
    const files = {
      "package.json": manifest(["only-in-build"]),
      "index.js": "",
      "build/gen.js": 'require("only-in-build");\n',
    };
    const scanned = makeProject({ ...files });
    installed(scanned, { "only-in-build": true });
    expect(classes(await analyzeDependencies({ cwd: scanned }))).toEqual({});

    const ignored = makeProject({ ...files, ".gitignore": "node_modules\nbuild/\n" });
    installed(ignored, { "only-in-build": true });
    expect(classes(await analyzeDependencies({ cwd: ignored }))).toEqual({
      "only-in-build": "certainly-unused",
    });
  });

  it("never scans node_modules", async () => {
    const dir = makeProject({
      "package.json": manifest(["ghost"]),
      "index.js": "",
      "node_modules/other/index.js": 'require("ghost");\n',
    });
    installed(dir, { ghost: true });
    expect(classes(await analyzeDependencies({ cwd: dir }))).toEqual({ ghost: "certainly-unused" });
  });
});

describe("monorepos are analysed per package", () => {
  const workspace = () => {
    const dir = makeProject({
      "package.json": {
        name: "root",
        private: true,
        devDependencies: { "root-tool": "1", "used-by-a": "1", "root-orphan": "1" },
        scripts: { lint: "rt ." },
      },
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/a/package.json": {
        name: "a",
        dependencies: { "a-dep": "1", "a-orphan": "1", "used-by-a": "1" },
      },
      "packages/a/index.js": 'require("a-dep");\nrequire("used-by-a");\n',
      "packages/b/package.json": { name: "b", dependencies: { "b-dep": "1", "root-tool": "1" } },
      "packages/b/index.js": 'require("b-dep");\n',
    });
    installed(dir, {
      "root-tool": { bin: { rt: "x.js" } },
      "used-by-a": true,
      "root-orphan": true,
      "a-dep": true,
      "a-orphan": true,
      "b-dep": true,
    });
    return dir;
  };

  it("reports each package against its own sources", async () => {
    const report = await analyzeDependencies({ cwd: workspace() });
    expect(report.packages.map((entry) => entry.dir)).toEqual([".", "packages/a", "packages/b"]);
    expect(classes(report, 1)).toEqual({ "a-orphan": "certainly-unused" });
    // Declared in b but only the root's script runs its command: covered by the root's scripts.
    expect(classes(report, 2)).toEqual({ "root-tool": "used-indirectly" });
  });

  it("does not call a root dependency unused when a member uses it", async () => {
    const report = await analyzeDependencies({ cwd: workspace() });
    expect(classes(report, 0)).toEqual({
      "root-tool": "used-indirectly",
      "used-by-a": "used-indirectly",
      "root-orphan": "certainly-unused",
    });
    expect(report.packages[0]!.unused.find((entry) => entry.name === "used-by-a")!.reason).toMatch(
      /workspace package a/,
    );
  });

  it("analyses only the package when run inside it", async () => {
    const dir = workspace();
    const report = await analyzeDependencies({ cwd: `${dir}/packages/a` });
    expect(report.packages.map((entry) => entry.name)).toEqual(["a"]);
    expect(classes(report)).toEqual({ "a-orphan": "certainly-unused" });
  });
});

describe("errors", () => {
  it("names the directory when there is no package.json", async () => {
    const dir = makeProject({ "README.md": "x" });
    await expect(analyzeDependencies({ cwd: dir })).rejects.toThrow(/No readable package.json/);
  });
});
