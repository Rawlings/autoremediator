import assert from "node:assert/strict";
import test from "node:test";
import { sessionHeader } from "../src/session.ts";

test("serialises the session cookie", () => {
  assert.equal(sessionHeader("a b"), "sid=a%20b; theme=dark");
});
