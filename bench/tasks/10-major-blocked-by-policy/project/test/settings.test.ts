import assert from "node:assert/strict";
import test from "node:test";
import { readMode } from "../src/settings.ts";

test("reads the mode", () => {
  assert.equal(readMode("mode: fast\nlevel: 3"), "fast");
  assert.equal(readMode("level: 3"), "default");
});
