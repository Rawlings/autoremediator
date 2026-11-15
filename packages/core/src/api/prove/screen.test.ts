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
    expect(screen(`import assert from "node:assert";\nimport template from "lodash/template";\n`).ok).toBe(true);
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
    ["the constructor chain", `require("lodash"); ({}).constructor.constructor("return process")();`],
    ["a version check", `require("lodash"); if (require("lodash").VERSION) {}\nconst v = _.version;`],
    ["the manifest", `require("lodash"); require("lodash/package.json");`],
    ["a version it was told", `require("lodash"); if (x === "4.17.18") process.exit(1);`],
  ])("refuses %s", (_name, body) => {
    const result = screen(body);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("refuses a script that is too long", () => {
    const result = screen(`require("lodash");\n${"// x\n".repeat(MAX_SCRIPT_CHARS)}`);
    expect(result.violations.join(" ")).toContain("longer than");
  });
});
