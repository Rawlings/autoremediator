import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/args.ts";

test("reads flags, options and positional files", () => {
  assert.deepEqual(parseArgs(["-p", "3000", "-v", "a.txt", "b.txt"]), {
    port: 3000,
    verbose: true,
    files: ["a.txt", "b.txt"],
  });
});

test("falls back to the defaults", () => {
  assert.deepEqual(parseArgs([]), { port: 8080, verbose: false, files: [] });
});
