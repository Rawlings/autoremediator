import assert from "node:assert/strict";
import test from "node:test";

import { describeDuration, nextBusinessDay } from "../src/schedule.ts";

test("skips the weekend", () => {
  assert.equal(nextBusinessDay("2024-03-01"), "2024-03-04");
  assert.equal(nextBusinessDay("2024-03-04"), "2024-03-05");
});

test("describes a duration in words", () => {
  assert.equal(describeDuration(90), "2 hours");
  assert.equal(describeDuration(3), "3 minutes");
});
