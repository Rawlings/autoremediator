import { describe, expect, it } from "vitest";

import { MAX_SCRIPT_CHARS, screenScript } from "./screen.js";

const context = { packageName: "lodash", versions: ["4.17.18", "4.17.19"] };
const screen = (body: string) => screenScript(body, context);

const HONEST = `
const assert = require("node:assert");
const _ = require("lodash");
_.zipObjectDeep(["__proto__.polluted"], [true]);
assert.strictEqual({}.polluted, undefined, "EXPLOIT_REPRODUCED");
delete Object.prototype.polluted;
`;

describe("screenScript", () => {
  it("passes a plain reproduction", () => {
    expect(screen(HONEST)).toEqual({ ok: true, violations: [] });
  });

  it("accepts import syntax, a subpath of the package, and the node: prefix", () => {
    expect(
      screen(`import assert from "node:assert";\nimport template from "lodash/template";\n`).ok,
    ).toBe(true);
    expect(screen(`const assert = require("assert/strict");\nrequire("lodash/fp");`).ok).toBe(true);
  });

  it.each([
    ["an empty script", ""],
    ["a script that never loads the package", `require("node:assert").ok(true);`],
    ["another package", `require("lodash"); require("left-pad");`],
    ["a network module", `require("lodash"); require("node:https");`],
    ["child processes", `require("lodash"); require("child_process");`],
    ["a computed module name", `require("lodash"); const n = "a"; require(n);`],
    ["a dynamic import", `require("lodash"); import(name);`],
    ["the environment", `require("lodash"); console.log(process.env.HOME);`],
    ["a signal", `require("lodash"); process.kill(1);`],
    ["fetch", `require("lodash"); fetch("http://x");`],
    ["eval", `require("lodash"); eval("1");`],
    ["the Function constructor", `require("lodash"); new Function("return 1")();`],
    [
      "the constructor chain",
      `require("lodash"); ({}).constructor.constructor("return process")();`,
    ],
    [
      "a version check",
      `require("lodash"); if (require("lodash").VERSION) {}\nconst v = _.version;`,
    ],
    ["the manifest", `require("lodash"); require("lodash/package.json");`],
    ["a version it was told", `require("lodash"); if (x === "4.17.18") process.exit(1);`],
  ])("refuses %s", (_name, body) => {
    const result = screen(body);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it.each([
    ["a concatenated module name", `require("lodash"); require("child_"+"process");`],
    [
      "a template-built module name",
      ['require("lodash"); require(`child_', "$", '{"process"}`);'].join(""),
    ],
    ["destructuring the environment", `require("lodash"); const { env } = process;`],
    ["a computed process member", `require("lodash"); process["env"];`],
    ["an indirect eval", `require("lodash"); (0, eval)("1");`],
    ["process aliased", `require("lodash"); const p = process; p.binding("fs");`],
    ["a computed manifest path", `require("lodash"); require("lodash/package" + ".json");`],
    [
      "the script's own location",
      `require("lodash"); if (__dirname.endsWith("vulnerable")) process.exit(1);`,
    ],
    [
      "the working directory",
      `require("lodash"); if (process.cwd().includes("fixed")) process.exit(1);`,
    ],
    ["a bare require used as a value", `const r = require; r("lodash"); r("child_process");`],
    ["require.resolve", `require("lodash"); require.resolve("lodash");`],
    ["the module object", `require("lodash"); module.require("child_process");`],
    ["globalThis", `require("lodash"); globalThis["pro" + "cess"];`],
    ["import.meta", `import _ from "lodash"; console.log(import.meta.url);`],
    ["a script that does not parse", `require("lodash"); const = ;`],
  ])("refuses %s (bypasses of the old text patterns)", (_name, body) => {
    expect(screen(body).ok).toBe(false);
  });

  it("does not mistake property names for references", () => {
    const body = `const assert = require("node:assert");\nconst _ = require("lodash");\nconst o = { process: 1, env: 2, version: 3 };\nassert.ok(o.env === 2);\nprocess.stdout.write("EXPLOIT_REPRODUCED");\nprocess.exitCode = 1;`;
    const result = screen(body);
    // `version` as a plain key is still refused (the script must not look at versions); the rest is fine.
    expect(result.violations.every((violation) => violation.includes("version"))).toBe(true);
  });

  it("refuses a script that is too long", () => {
    const result = screen(`require("lodash");\n${"// x\n".repeat(MAX_SCRIPT_CHARS)}`);
    expect(result.violations.join(" ")).toContain("longer than");
  });
});
