import assert from "node:assert/strict";
import test from "node:test";
import { host, port } from "../src/server.ts";

test("reads the configured host and port", () => {
  assert.equal(host(), "example.com");
  assert.equal(port(), 8080);
});
