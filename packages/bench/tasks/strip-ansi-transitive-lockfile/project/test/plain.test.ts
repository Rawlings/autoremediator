import assert from "node:assert/strict";
import test from "node:test";

import { plain, visibleLength } from "../src/plain.ts";

test("removes colour and style codes", () => {
  assert.equal(plain("\u001B[4mcake\u001B[0m"), "cake");
  assert.equal(plain("\u001B[31mred\u001B[39m and \u001B[1mbold\u001B[22m"), "red and bold");
});

test("measures what is visible", () => {
  assert.equal(visibleLength("\u001B[32mok\u001B[39m"), 2);
  assert.equal(visibleLength("plain"), 5);
});
