import assert from "node:assert/strict";
import test from "node:test";

import { apiClient, sessionCookieHeader } from "../src/client.ts";

test("keeps a session cookie for its site", () => {
  assert.equal(sessionCookieHeader(), "session=abc123");
});

test("builds a preconfigured client without sending anything", () => {
  assert.equal(typeof apiClient(), "function");
});
