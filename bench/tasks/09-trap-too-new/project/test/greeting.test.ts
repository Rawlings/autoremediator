import assert from "node:assert/strict";
import test from "node:test";
import { greeting } from "../src/greeting.ts";

test("renders a greeting", () => {
  assert.equal(greeting("Ada"), "Hello, Ada!");
});
