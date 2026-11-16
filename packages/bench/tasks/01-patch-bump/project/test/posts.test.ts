import assert from "node:assert/strict";
import test from "node:test";
import { postUrl } from "../src/posts.ts";

test("builds a post url from a title", () => {
  assert.equal(postUrl("Hello, World!"), "/posts/hello-world");
  assert.equal(postUrl("  Already   spaced  "), "/posts/already-spaced");
});
