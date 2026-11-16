import assert from "node:assert/strict";
import test from "node:test";
import { runJob } from "../src/job.ts";

test("retries a job that fails twice", async () => {
  let calls = 0;
  const result = await runJob(async () => {
    calls += 1;
    if (calls < 3) throw new Error("not yet");
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(calls, 3);
});
