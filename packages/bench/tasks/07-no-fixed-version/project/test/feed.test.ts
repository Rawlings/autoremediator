import assert from "node:assert/strict";
import test from "node:test";
import { feedTitle } from "../src/feed.ts";

test("reads the feed title", () => {
  assert.equal(feedTitle("<feed><title>News</title></feed>"), "News");
});
