import { describe, expect, it } from "vitest";

import { pkg } from "./__tests__/fixtures.js";
import { findVulnerableSymbols, parseCweIds } from "./fix-diff.js";

const symbols = (diff: ReturnType<typeof findVulnerableSymbols>): string[] =>
  diff.candidates.map(
    (candidate) => `${candidate.specifier}#${candidate.exportName}:${candidate.basis}`,
  );

describe("findVulnerableSymbols", () => {
  it("ignores formatting, comments, quote style and parentheses", () => {
    const before = pkg("1.0.0", {
      "index.js": `exports.parse = function (input) { return input.trim() + 'x'; };\nexports.other = (a) => a + 1;`,
    });
    const after = pkg("1.0.1", {
      "index.js": `// reformatted\n/* block */\nexports.parse = function(input) {\n  return (input.trim()) + "x"\n}\n\nexports.other = (a) =>\n  a + 1;\n`,
    });
    const diff = findVulnerableSymbols(before, after);
    expect(diff.candidates).toEqual([]);
    expect(diff.changedFiles).toEqual([]);
    expect(diff.limitations.join(" ")).toMatch(/identical after normalising/);
  });

  it("flags a CommonJS export whose body changed and not its neighbour", () => {
    const before = pkg("1.0.0", {
      "index.js": `exports.parse = function (s) { return s.replace(/(a+)+$/, ""); };\nexports.keep = function (s) { return s; };`,
    });
    const after = pkg("1.0.1", {
      "index.js": `exports.parse = function (s) { if (s.length > 1000) throw new Error("too long"); return s.replace(/a+$/, ""); };\nexports.keep = function (s) { return s; };`,
    });
    const diff = findVulnerableSymbols(before, after);
    expect(symbols(diff)).toEqual(["fixture-pkg#parse:direct"]);
    expect(diff.heuristic).toBe(true);
    expect(diff.candidates[0]?.addedTokens).toContain("Error");
  });

  it("handles ESM exports, aliased exports and `export *` re-exports", () => {
    const before = pkg(
      "1.0.0",
      {
        "index.js": `export * from "./lib/a.js";\nexport { helper as run } from "./lib/b.js";\nexport default function main() { return 1; }`,
        "lib/a.js": `export function a() { return "a"; }\nexport const stable = 1;`,
        "lib/b.js": `export function helper() { return "h"; }`,
      },
      { type: "module", main: "index.js" },
    );
    const after = pkg(
      "1.0.1",
      {
        "index.js": `export * from "./lib/a.js";\nexport { helper as run } from "./lib/b.js";\nexport default function main() { return 2; }`,
        "lib/a.js": `export function a() { return "A"; }\nexport const stable = 1;`,
        "lib/b.js": `export function helper() { return "h"; }`,
      },
      { type: "module", main: "index.js" },
    );
    const diff = findVulnerableSymbols(before, after);
    expect(symbols(diff).toSorted()).toEqual([
      "fixture-pkg#a:direct",
      "fixture-pkg#default:direct",
    ]);
    const a = diff.candidates.find((candidate) => candidate.exportName === "a");
    expect(a?.file).toBe("lib/a.js");
  });

  it("follows module.exports = require(...) and object-literal exports", () => {
    const before = pkg("1.0.0", {
      "index.js": `module.exports = require("./impl");`,
      "impl.js": `function one() { return 1; }\nfunction two() { return 2; }\nmodule.exports = { one, two, three: function () { return 3; } };`,
    });
    const after = pkg("1.0.1", {
      "index.js": `module.exports = require("./impl");`,
      "impl.js": `function one() { return 1; }\nfunction two() { return 22; }\nmodule.exports = { one, two, three: function () { return 33; } };`,
    });
    const diff = findVulnerableSymbols(before, after);
    expect(symbols(diff).toSorted()).toEqual([
      "fixture-pkg#three:direct",
      "fixture-pkg#two:direct",
    ]);
  });

  it("reports an export that calls a changed internal function, with the hop count", () => {
    const before = pkg("1.0.0", {
      "index.js": `function clean(s) { return s.replace(/x/g, ""); }\nfunction wrap(s) { return clean(s); }\nexports.render = function (s) { return wrap(s); };\nexports.unrelated = function () { return 1; };`,
    });
    const after = pkg("1.0.1", {
      "index.js": `function clean(s) { return s.replace(/x/g, "").slice(0, 100); }\nfunction wrap(s) { return clean(s); }\nexports.render = function (s) { return wrap(s); };\nexports.unrelated = function () { return 1; };`,
    });
    const diff = findVulnerableSymbols(before, after);
    expect(symbols(diff)).toEqual(["fixture-pkg#render:via-internal-function"]);
    expect(diff.candidates[0]?.via).toEqual(["clean"]);
    expect(diff.candidates[0]?.reasons.join(" ")).toMatch(/2 call hops away/);
  });

  it("reports an export removed by the fix", () => {
    const before = pkg("1.0.0", {
      "index.js": `exports.unsafe = function () { return eval("1"); };\nexports.safe = function () { return 1; };`,
    });
    const after = pkg("1.0.1", {
      "index.js": `exports.safe = function () { return 1; };\nexports.added = function () { return 1; };`,
    });
    const diff = findVulnerableSymbols(before, after);
    expect(symbols(diff)).toEqual(["fixture-pkg#unsafe:removed-in-fix"]);
    expect(diff.addedExports).toEqual(["fixture-pkg#added"]);
  });

  it("does not treat a version constant bump as a fix", () => {
    const before = pkg("1.0.0", {
      "index.js": `exports.VERSION = "1.0.0";\nexports.f = function () { return 1; };`,
    });
    const after = pkg("1.0.1", {
      "index.js": `exports.VERSION = "1.0.1";\nexports.f = function () { return 1; };`,
    });
    expect(findVulnerableSymbols(before, after).candidates).toEqual([]);
  });

  it("ranks by the advisory text and by CWE vocabulary, and says why", () => {
    const before = pkg("1.0.0", {
      "index.js": `exports.alpha = function (s) { return s + "1"; };\nexports.beta = function (s) { return s.replace(/(x+)+/, ""); };`,
    });
    const after = pkg("1.0.1", {
      "index.js": `exports.alpha = function (s) { return s + "2"; };\nexports.beta = function (s) { return s.replace(/x+/, ""); };`,
    });
    const plain = findVulnerableSymbols(before, after);
    // Without hints the tie breaks by name.
    expect(plain.candidates.map((candidate) => candidate.symbol)).toEqual(["alpha", "beta"]);

    const byCwe = findVulnerableSymbols(before, after, { hints: { cwes: ["CWE-1333"] } });
    expect(byCwe.candidates[0]?.symbol).toBe("beta");
    expect(byCwe.candidates[0]?.reasons.join(" ")).toMatch(/regular expression or size limit/);

    const byText = findVulnerableSymbols(before, after, {
      hints: { text: "alpha is vulnerable to prototype pollution" },
    });
    expect(byText.candidates[0]?.symbol).toBe("alpha");
    expect(byText.candidates[0]?.reasons.join(" ")).toMatch(/named in the advisory text/);
  });

  it("only exposes what an exports map exposes, and still sees changes behind it", () => {
    const manifest = { exports: { ".": "./lib/public.js" } };
    const before = pkg(
      "1.0.0",
      {
        "lib/public.js": `const { inner } = require("./internal.js");\nexports.api = function () { return inner(); };`,
        "lib/internal.js": `exports.inner = function () { return 1; };`,
        "lib/private-only.js": `exports.hidden = function () { return 1; };`,
      },
      manifest,
    );
    const after = pkg(
      "1.0.1",
      {
        "lib/public.js": `const { inner } = require("./internal.js");\nexports.api = function () { return inner(); };`,
        "lib/internal.js": `exports.inner = function () { return 2; };`,
        "lib/private-only.js": `exports.hidden = function () { return 2; };`,
      },
      manifest,
    );
    const diff = findVulnerableSymbols(before, after);
    // `hidden` is not importable; the public `api` is reported through the internal module.
    expect(symbols(diff)).toEqual(["fixture-pkg#api:via-internal-module"]);
    expect(diff.changedFiles.map((entry) => entry.file)).toContain("lib/private-only.js");
  });

  it("finds namespace-assignment exports in a UMD bundle and says the discovery is weak", () => {
    const body = (extra: string): string => {
      const lines = Array.from(
        { length: 9 },
        (_, index) => `  lodash.fn${index} = fn${index};`,
      ).join("\n");
      const defs = Array.from(
        { length: 9 },
        (_, index) => `  function fn${index}() { return ${index}; }`,
      ).join("\n");
      return `;(function () {\n  function runInContext() {\n${defs}\n  function template(s) { ${extra} return s; }\n  function lodash() {}\n${lines}\n  lodash.template = template;\n  return lodash;\n  }\n  var _ = runInContext();\n  (typeof module == "object" ? module : {}).exports = _;\n}.call(this));`;
    };
    const diff = findVulnerableSymbols(
      pkg("1.0.0", { "lodash.js": body("") }, { main: "lodash.js" }),
      pkg(
        "1.0.1",
        { "lodash.js": body("if (/bad/.test(s)) throw new Error('x');") },
        { main: "lodash.js" },
      ),
    );
    expect(symbols(diff)).toContain("fixture-pkg#template:direct");
    expect(diff.limitations.join(" ")).toMatch(/namespace-assignment heuristic/);
  });

  it("maps a default export of a deep file to the file's name and lists other specifiers once", () => {
    const before = pkg("1.0.0", {
      "index.js": `module.exports = require("./template.js");`,
      "template.js": `module.exports = function template(s) { return s; };`,
    });
    const after = pkg("1.0.1", {
      "index.js": `module.exports = require("./template.js");`,
      "template.js": `module.exports = function template(s) { return s.trim(); };`,
    });
    const diff = findVulnerableSymbols(before, after);
    const candidate = diff.candidates.find((entry) => entry.file === "template.js");
    expect(candidate?.symbol).toBe("template");
    expect(diff.candidates.filter((entry) => entry.file === "template.js")).toHaveLength(1);
  });

  it("limits the number of candidates but reports the total", () => {
    const make = (suffix: string): string =>
      Array.from(
        { length: 10 },
        (_, index) => `exports.f${index} = function () { return "${suffix}${index}"; };`,
      ).join("\n");
    const diff = findVulnerableSymbols(
      pkg("1.0.0", { "index.js": make("a") }),
      pkg("1.0.1", { "index.js": make("b") }),
      { limit: 3 },
    );
    expect(diff.candidates).toHaveLength(3);
    expect(diff.totalCandidates).toBe(10);
  });
});

describe("parseCweIds", () => {
  it("reads ids from values and from advisory text", () => {
    expect(parseCweIds(["CWE-1333", "79"], "see CWE-94 and cwe: 22")).toEqual([22, 79, 94, 1333]);
    expect(parseCweIds(undefined, undefined)).toEqual([]);
  });
});
