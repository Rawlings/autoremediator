/**
 * A project on disk with fake installed packages covering the export shapes the trace hook has to
 * handle: CommonJS function / object / class / frozen / getter exports, native ES modules with
 * named, default, class and re-exported functions, and a package that is never loaded.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture-app", version: "0.0.0", private: true }),

  "node_modules/cjs-fn/package.json": JSON.stringify({
    name: "cjs-fn",
    version: "1.2.3",
    main: "index.js",
  }),
  "node_modules/cjs-fn/index.js": `
function render(x) { return "r:" + x + ":" + ((this && this.tag) || ""); }
render.helper = function helper() { return "helper"; };
render.VERSION = "1.2.3";
module.exports = render;
`,

  "node_modules/cjs-obj/package.json": JSON.stringify({
    name: "cjs-obj",
    version: "2.0.0",
    main: "index.js",
  }),
  "node_modules/cjs-obj/index.js": `
exports.add = (a, b) => a + b;
exports.mul = (a, b) => a * b;
exports.self = function () { return this.add(1, 2); };
exports.unused = () => "never called";
exports.value = 42;
`,

  "node_modules/cjs-class/package.json": JSON.stringify({
    name: "cjs-class",
    version: "3.1.0",
    main: "index.js",
  }),
  "node_modules/cjs-class/index.js": `
class Widget {
  constructor(n) { this.n = n; }
  get double() { return this.n * 2; }
  static make(n) { return new Widget(n); }
}
class Guarded {
  static #count = 0;
  static next() { return ++Guarded.#count; }
  static peek() { return this.#count; }
}
class Base {
  constructor() { if (new.target === Base) throw new Error("abstract"); }
}
module.exports = { Widget, Guarded, Base };
`,

  "node_modules/cjs-frozen/package.json": JSON.stringify({
    name: "cjs-frozen",
    version: "1.0.0",
    main: "index.js",
  }),
  "node_modules/cjs-frozen/index.js": `
module.exports = Object.freeze({ frozenFn() { return "frozen"; }, n: 1 });
`,

  "node_modules/cjs-getter/package.json": JSON.stringify({
    name: "cjs-getter",
    version: "1.0.0",
    main: "index.js",
  }),
  "node_modules/cjs-getter/index.js": `
Object.defineProperty(exports, "lazy", { enumerable: true, get() { return function lazy() { return "lazy"; }; } });
exports.plain = function plain() { return "plain"; };
`,

  "node_modules/cjs-outer/package.json": JSON.stringify({
    name: "cjs-outer",
    version: "1.0.0",
    main: "index.js",
    dependencies: { "cjs-inner": "^1.0.0" },
  }),
  "node_modules/cjs-outer/index.js": `
const inner = require("cjs-inner");
exports.run = () => inner.go();
`,
  "node_modules/cjs-inner/package.json": JSON.stringify({
    name: "cjs-inner",
    version: "1.4.0",
    main: "index.js",
  }),
  "node_modules/cjs-inner/index.js": `exports.go = () => "inner";`,

  "node_modules/cjs-never/package.json": JSON.stringify({
    name: "cjs-never",
    version: "9.9.9",
    main: "index.js",
  }),
  "node_modules/cjs-never/index.js": `exports.boom = () => "never loaded";`,

  "node_modules/@scope/esm-pkg/package.json": JSON.stringify({
    name: "@scope/esm-pkg",
    version: "4.5.6",
    type: "module",
    exports: "./index.js",
  }),
  "node_modules/@scope/esm-pkg/index.js": `
export function esmFn(x) { return "esm:" + x; }
export class EsmWidget { constructor() { this.k = 1; } }
export default function esmDefault() { return "default"; }
export const esmConst = () => "const";
export * from "./lib.js";
export { renamed as aliased } from "./lib.js";
`,
  "node_modules/@scope/esm-pkg/lib.js": `
export function libFn() { return "lib"; }
export function renamed() { return "renamed"; }
export function hidden() { return "hidden"; }
`,

  // Exercises every shape from CommonJS code. Prints one JSON line.
  "main.cjs": `
const out = {};
const fn = require("cjs-fn");
out.fn = [fn("a"), fn.helper(), fn.VERSION, fn.call({ tag: "T" }, "b"), fn.name, fn.length];
const obj = require("cjs-obj");
out.obj = [obj.add(1, 2), obj.self(), obj.value, require("cjs-obj") === obj, Object.keys(obj)];
const { Widget, Guarded, Base } = require("cjs-class");
const w = new Widget(2);
let abstractError = "";
try { new Base(); } catch (e) { abstractError = e.message; }
class Derived extends Base {}
out.cls = [w instanceof Widget, w.double, Widget.make(3) instanceof Widget, Widget.make(3).n,
  Guarded.next(), Guarded.next(), Guarded.peek(), abstractError, new Derived() instanceof Base,
  Object.getPrototypeOf(w) === Widget.prototype, w.constructor === Widget];
const frozen = require("cjs-frozen");
out.frozen = [frozen.frozenFn(), frozen.n, Object.isFrozen(frozen)];
const getter = require("cjs-getter");
out.getter = [getter.lazy(), getter.plain()];
out.transitive = require("cjs-outer").run();
if (process.env.USE_NEVER) out.never = require("cjs-never").boom();
console.log(JSON.stringify(out));
`,

  // Exercises ES module imports, including named imports from CommonJS packages.
  "main.mjs": `
import esmDefault, { esmFn, EsmWidget, esmConst, libFn, aliased } from "@scope/esm-pkg";
import * as ns from "@scope/esm-pkg";
import cjsFn from "cjs-fn";
import { add, mul } from "cjs-obj";
const out = {};
out.esm = [esmFn("x"), new EsmWidget() instanceof EsmWidget, esmDefault(), esmConst(), libFn(), aliased(),
  Object.keys(ns).toSorted(), typeof ns.hidden];
out.cjs = [cjsFn("z"), add(2, 3), mul(2, 3)];
console.log(JSON.stringify(out));
`,

  // A node:test suite that loads a package.
  "check.test.mjs": `
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
test("uses cjs-obj", () => {
  assert.equal(require("cjs-obj").add(2, 2), 4);
});
`,
};

/** Write the fixture project into `dir`. */
export function writeTraceFixture(dir: string): void {
  for (const [path, content] of Object.entries(FILES)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}
