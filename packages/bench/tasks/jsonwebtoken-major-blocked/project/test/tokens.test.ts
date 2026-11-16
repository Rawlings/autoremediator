import assert from "node:assert/strict";
import test from "node:test";

import { createDevKeys, issue, subjectOf } from "../src/tokens.ts";

test("a token signed with the dev keys verifies and names its subject", () => {
  const keys = createDevKeys();
  assert.equal(subjectOf(issue("amy", keys), keys), "amy");
});

test("a token signed with other keys is rejected", () => {
  assert.throws(() => subjectOf(issue("amy", createDevKeys()), createDevKeys()));
});
