import assert from "node:assert/strict";
import test from "node:test";
import { validUsername } from "../src/signup.ts";

test("accepts and rejects usernames", () => {
  assert.equal(validUsername("alice_1"), true);
  assert.equal(validUsername("Al"), false);
  assert.equal(validUsername("has space"), false);
});
