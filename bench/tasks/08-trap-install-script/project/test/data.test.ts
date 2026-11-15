import assert from "node:assert/strict";
import test from "node:test";
import { readCount } from "../src/data.ts";

test("reads a count", () => {
  assert.equal(readCount('{"count": 4}'), 4);
});
