import { describe, expect, it } from "vitest";

import { pkg } from "./__tests__/fixtures.js";
import { compareSurfaces, type ApiChange } from "./api-diff.js";
import { extractDtsSurface, extractJsSurface } from "./dts-surface.js";
import { comparePackageManifests, isSubpathExported } from "./manifest-diff.js";
import { PackageIndex, moduleFormat } from "./package-index.js";

function dtsChanges(before: string, after: string, extra: Record<string, string> = {}): ApiChange[] {
  const files = (dts: string): Record<string, string> => ({ "index.d.ts": dts, ...extra });
  const a = new PackageIndex(pkg("1.0.0", files(before), { types: "index.d.ts" }));
  const b = new PackageIndex(pkg("2.0.0", files(after), { types: "index.d.ts" }));
  return compareSurfaces("fixture-pkg", extractDtsSurface(a, "index.d.ts"), extractDtsSurface(b, "index.d.ts"));
}

const summary = (changes: ApiChange[]): string[] =>
  changes.map((change) => `${change.category}:${change.symbol}${change.member ? `.${change.member}` : ""}:${change.severity}`).toSorted();

describe("declaration surface comparison", () => {
  it("reports no change for reformatted declarations", () => {
    const before = `export declare function f(a: string, b?: number): void;\nexport interface I { a: string }`;
    const after = `/** docs */\nexport   declare function f(\n  a: string,\n  b?: number,\n): void;\nexport interface I {\n  a: string;\n}`;
    expect(dtsChanges(before, after)).toEqual([]);
  });

  it("reports a removed export and detects a rename of an identically shaped one", () => {
    const changes = dtsChanges(
      `export declare function oldName(a: string): number;\nexport declare function gone(a: string, b: string): void;`,
      `export declare function newName(a: string): number;`,
    );
    expect(summary(changes)).toEqual(["removed-export:gone:breaking", "renamed-export:oldName:breaking"]);
    expect(changes.find((change) => change.symbol === "oldName")?.renamedTo).toBe("newName");
  });

  it("classifies signature changes: new required parameter, dropped parameter, optional made required", () => {
    const changes = dtsChanges(
      `export declare function a(x: string): void;\nexport declare function b(x: string, y: string): void;\nexport declare function c(x: string, y?: number): void;\nexport declare function same(x: string): void;`,
      `export declare function a(x: string, y: number): void;\nexport declare function b(x: string): void;\nexport declare function c(x: string, y: number): void;\nexport declare function same(x: string): void;`,
    );
    expect(summary(changes)).toEqual([
      "signature-changed:a:breaking",
      "signature-changed:b:breaking",
      "signature-changed:c:breaking",
    ]);
    expect(changes.find((change) => change.symbol === "a")?.arity).toEqual({ min: 2, max: 2 });
    expect(changes.find((change) => change.symbol === "b")?.arity).toEqual({ min: 1, max: 1 });
  });

  it("treats a changed parameter or return type as possibly breaking, with both texts", () => {
    const changes = dtsChanges(
      `export declare function f(x: string): number;`,
      `export declare function f(x: string | number): string;`,
    );
    expect(summary(changes)).toEqual(["type-changed:f:possibly-breaking", "type-changed:f:possibly-breaking"]);
    expect(changes.map((change) => change.reason).join(" ")).toMatch(/string -> string \| number/);
    expect(changes.map((change) => change.reason).join(" ")).toMatch(/number -> string/);
  });

  it("handles overloads: an added overload is fine, a removed one breaks", () => {
    expect(
      dtsChanges(
        `export declare function f(a: string): void;`,
        `export declare function f(a: string): void;\nexport declare function f(a: number): void;`,
      ),
    ).toEqual([]);
    expect(
      summary(
        dtsChanges(
          `export declare function f(a: string): void;\nexport declare function f(a: number): void;`,
          `export declare function f(a: string): void;`,
        ),
      ),
    ).toEqual(["signature-changed:f:breaking"]);
  });

  it("compares class members: removed, renamed, static, constructor and base class", () => {
    const changes = dtsChanges(
      `export declare class A extends Base {\n  constructor(a: string);\n  run(x: number): void;\n  stop(): void;\n  static create(): A;\n  private secret: number;\n}`,
      `export declare class A extends Other {\n  constructor(a: string, b: number);\n  execute(x: number): void;\n  static create(opts: object): A;\n}`,
    );
    expect(summary(changes)).toEqual([
      "extends-changed:A:possibly-breaking",
      "member-changed:A.[new]:breaking",
      "member-changed:A.static create:breaking",
      "removed-member:A.stop:breaking",
      "renamed-member:A.run:breaking",
    ]);
  });

  it("flags a new required interface member, a member made required and a removed member", () => {
    const changes = dtsChanges(
      `export interface Options { a: string; b?: number; c: string }`,
      `export interface Options { a: string; b: number; d: boolean; e?: string }`,
    );
    expect(summary(changes)).toEqual([
      "added-required-member:Options.d:possibly-breaking",
      "member-changed:Options.b:possibly-breaking",
      "removed-member:Options.c:breaking",
    ]);
  });

  it("flags enum member removal, kind changes and type alias changes", () => {
    const changes = dtsChanges(
      `export declare enum Mode { A = 0, B = 1 }\nexport declare function fn(): void;\nexport type T = { a: string };`,
      `export declare enum Mode { A = 0 }\nexport declare class fn {}\nexport type T = { a: number };`,
    );
    expect(summary(changes)).toEqual([
      "kind-changed:fn:breaking",
      "removed-member:Mode.B:breaking",
      "type-changed:T:possibly-breaking",
    ]);
  });

  it("follows `export *`, named re-exports and `export =` with a merged namespace", () => {
    const changes = dtsChanges(
      `export * from "./a";\nexport { b as bee } from "./b";`,
      `export * from "./a";\nexport { b as bee } from "./b";`,
      { "a.d.ts": `export declare function a(x: string): void;`, "b.d.ts": `export declare function b(): void;` },
    );
    expect(changes).toEqual([]);

    const merged = dtsChanges(
      `declare function lib(a: string): void;\ndeclare namespace lib { function extra(a: string): void; }\nexport = lib;`,
      `declare function lib(a: string): void;\ndeclare namespace lib { function extra(a: string, b: string): void; }\nexport = lib;`,
    );
    expect(summary(merged)).toContain("signature-changed:extra:breaking");
  });

  it("resolves a variable declared as a named interface, so its members are the API", () => {
    const changes = dtsChanges(
      `export interface Chalk { red(s: string): string; keyword(c: string): Chalk }\ndeclare const chalk: Chalk;\nexport default chalk;`,
      `export interface Chalk { red(s: string): string }\ndeclare const chalk: Chalk;\nexport default chalk;`,
    );
    expect(summary(changes)).toContain("removed-member:default.keyword:breaking");
  });

  it("reads the API from JavaScript when there are no declarations, and downgrades arity changes", () => {
    const before = new PackageIndex(pkg("1.0.0", { "index.js": `exports.f = function (a) {};\nexports.g = function () {};\nexports.C = class { m() {} n() {} };` }));
    const after = new PackageIndex(pkg("2.0.0", { "index.js": `exports.f = function (a, b) {};\nexports.C = class { m() {} };` }));
    const changes = compareSurfaces("fixture-pkg", extractJsSurface(before, "index.js"), extractJsSurface(after, "index.js"));
    expect(summary(changes)).toEqual([
      "removed-export:g:breaking",
      "removed-member:C.n:breaking",
      "signature-changed:f:possibly-breaking",
    ]);
  });

  it("does not report a CommonJS module.exports function as removed when it becomes a default export", () => {
    const before = new PackageIndex(pkg("1.0.0", { "index.js": `module.exports = function (a) { return a; };` }));
    const after = new PackageIndex(pkg("2.0.0", { "index.js": `export default function (a) { return a; }` }, { type: "module" }));
    const changes = compareSurfaces("fixture-pkg", extractJsSurface(before, "index.js"), extractJsSurface(after, "index.js"));
    expect(changes).toEqual([]);
  });
});

describe("package manifest comparison", () => {
  const project = { engines: { node: ">=18" }, dependencies: { react: "^18.0.0" } };

  it("flags a narrowed engines.node and proves a conflict only against the project's own range", () => {
    const before = { engines: { node: ">=10" } };
    const after = { engines: { node: ">=20" } };
    const unknown = comparePackageManifests(before, after, undefined, "v22.0.0");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ category: "engines", severity: "possibly-breaking", evidence: "unresolved" });
    expect(unknown[0]?.reason).toMatch(/Node v22.0.0 on this machine satisfies it/);

    const conflict = comparePackageManifests(before, after, project, "v22.0.0");
    expect(conflict[0]).toMatchObject({ severity: "breaking", evidence: "project-conflict" });

    // The project already requires a Node that fits: nothing to report.
    expect(comparePackageManifests(before, after, { engines: { node: ">=22" } }, "v22.0.0")).toEqual([]);
    // Widening is not a break.
    expect(comparePackageManifests({ engines: { node: ">=20" } }, { engines: { node: ">=10" } }, project)).toEqual([]);
  });

  it("detects CommonJS to ESM-only", () => {
    const changes = comparePackageManifests({ main: "index.js" }, { type: "module", exports: "./index.js" }, undefined);
    expect(changes[0]).toMatchObject({ category: "module-format", affectsRequire: true });
    expect(moduleFormat({ main: "index.js" })).toBe("cjs-only");
    expect(moduleFormat({ type: "module", exports: "./index.js" })).toBe("esm-only");
    expect(moduleFormat({ exports: { import: "./i.mjs", require: "./i.cjs" } })).toBe("dual");
    expect(comparePackageManifests({ exports: { ".": "./index.js" } }, { exports: { ".": { import: "./i.mjs", require: "./i.cjs" } } }, undefined)).toEqual([]);
  });

  it("detects removed exports subpaths and a newly restricted package", () => {
    const removed = comparePackageManifests({ exports: { ".": "./a.js", "./sub": "./sub.js" } }, { exports: { ".": "./a.js" } }, undefined);
    expect(removed[0]).toMatchObject({ category: "exports-map", severity: "breaking", removedSubpaths: ["./sub"] });
    const restricted = comparePackageManifests({ main: "a.js" }, { main: "a.js", exports: { ".": "./a.js" } }, undefined);
    expect(restricted[0]).toMatchObject({ category: "exports-map", restrictsDeepImports: true });
    expect(isSubpathExported({ exports: { ".": "./a.js", "./features/*": "./f/*.js" } }, "./features/x")).toBe(true);
    expect(isSubpathExported({ exports: { ".": "./a.js" } }, "./lib/x")).toBe(false);
    expect(isSubpathExported({ main: "a.js" }, "./lib/x")).toBe(true);
  });

  it("detects new required peer dependencies and conflicts with the project's range", () => {
    const missing = comparePackageManifests({}, { peerDependencies: { vue: "^3.0.0" } }, project);
    expect(missing[0]).toMatchObject({ category: "peer-dependency", severity: "possibly-breaking", evidence: "unresolved" });

    const conflict = comparePackageManifests({}, { peerDependencies: { react: "^19.0.0" } }, project);
    expect(conflict[0]).toMatchObject({ severity: "breaking", evidence: "project-conflict" });

    expect(comparePackageManifests({}, { peerDependencies: { react: "^18.0.0" } }, project)).toEqual([]);
    expect(
      comparePackageManifests({}, { peerDependencies: { vue: "^3" }, peerDependenciesMeta: { vue: { optional: true } } }, project),
    ).toEqual([]);
  });
});
