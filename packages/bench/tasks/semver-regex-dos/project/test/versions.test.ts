import assert from "node:assert/strict";
import test from "node:test";

import { isUpgrade, newestCompatible, nextVersion } from "../src/versions.ts";

test("picks the newest version inside a range", () => {
  assert.equal(newestCompatible("^1.2.0", ["1.2.0", "1.4.1", "2.0.0"]), "1.4.1");
  assert.equal(newestCompatible("^3.0.0", ["1.2.0"]), null);
});

test("bumps and compares versions", () => {
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(isUpgrade("1.2.3", "1.10.0"), true);
  assert.equal(isUpgrade("2.0.0", "1.10.0"), false);
});
