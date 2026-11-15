import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { filePathOf, instrumentEsModule } from "./esm-instrument.js";

const instrument = (source: string, visible?: Parameters<typeof instrumentEsModule>[2]) =>
  instrumentEsModule("/p/node_modules/pkg/index.js", source, visible, "reg", "/p/node_modules/pkg");

describe("instrumentEsModule", () => {
  it("wraps exported function, class and let/var bindings after the module body", () => {
    const source = `export function f() {}\nexport let l = () => 1;\nexport var v = () => 2;\nexport class K {}\n`;
    const result = instrument(source);
    expect(result.wrapped.toSorted()).toEqual(["K", "f", "l", "v"]);
    expect(result.source?.startsWith(source)).toBe(true);
    expect(result.source).toContain('r.wrap(f,["f"]');
    expect(result.source).toContain('r.wrap(l,["l"]');
  });

  it("wraps a named default export under the name default", () => {
    const result = instrument("export default function named() {}");
    expect(result.wrapped).toEqual(["default"]);
    expect(result.source).toContain('r.wrap(named,["default"]');
  });

  it("wraps through `export { local as alias }` under the alias", () => {
    const result = instrument("function local() {}\nexport { local as alias };");
    expect(result.wrapped).toEqual(["alias"]);
  });

  it("reports bindings it cannot reassign instead of rewriting them", () => {
    const result = instrument(`export const c = () => 1;\nexport default function () {}\n`);
    expect(result.unwrapped).toEqual({
      c: "const-binding",
      default: "anonymous-or-expression-export",
    });
    expect(result.source).toBeUndefined();
  });

  it("reports namespace and cross-package re-exports", () => {
    const result = instrument(`export * as ns from "./n.js";\nexport { x } from "other-pkg";`);
    expect(result.unwrapped).toEqual({
      ns: "namespace-reexport",
      x: "reexport-of-another-package",
    });
  });

  it("follows relative re-exports, with the names they are visible under", () => {
    const result = instrument(
      `export * from "./all.js";\nexport { a as b } from "./some.js";\nexport { c } from "./some.js";`,
    );
    expect(result.reexports.get("/p/node_modules/pkg/all.js")).toEqual({
      all: true,
      names: new Map(),
    });
    expect(result.reexports.get("/p/node_modules/pkg/some.js")).toEqual({
      all: false,
      names: new Map([
        ["a", new Set(["b"])],
        ["c", new Set(["c"])],
      ]),
    });
  });

  it("in a re-exported module, only counts what the re-export makes visible, with aliases", () => {
    const source = `export function a() {}\nexport function c() {}\nexport function hidden() {}\n`;
    const result = instrument(source, {
      all: false,
      names: new Map([
        ["a", new Set(["b"])],
        ["c", new Set()],
      ]),
    });
    expect(result.wrapped).toEqual(["a", "b", "c"]);
    expect(result.source).toContain('r.wrap(a,["a","b"]');
    expect(result.source?.slice(source.length)).not.toContain("hidden");
  });

  it("does not touch sources that fail to parse", () => {
    const result = instrument("export function (");
    expect(result.source).toBeUndefined();
    expect(result.unwrapped["*"]).toBe("source-could-not-be-parsed");
  });

  it("produces code that survives a trailing line comment", () => {
    const result = instrument("export function f() {} // trailing");
    expect(parseSync("out.mjs", result.source ?? "").errors).toEqual([]);
  });
});

describe("filePathOf", () => {
  it("only resolves file: URLs", () => {
    expect(filePathOf("file:///a/b.js")).toBe("/a/b.js");
    expect(filePathOf("node:fs")).toBeUndefined();
    expect(filePathOf("data:text/javascript,1")).toBeUndefined();
  });
});
