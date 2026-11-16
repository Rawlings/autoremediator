import assert from "node:assert/strict";
import test from "node:test";

import { parseSettings, resolveAlias } from "../src/config.ts";

test("reads a settings file written as JSON5", () => {
  const text = "{ // the port\n  port: 8080,\n  tags: ['a', 'b',],\n}";
  assert.deepEqual(parseSettings(text), { port: 8080, tags: ["a", "b"] });
});

test("resolves an alias from tsconfig paths", () => {
  assert.match(resolveAlias(process.cwd(), "@app/greet") ?? "", /src\/greet(\.ts)?$/);
  assert.equal(resolveAlias(process.cwd(), "@app/missing"), undefined);
});
