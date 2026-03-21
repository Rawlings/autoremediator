import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRepoLock, withRepoLock } from "./repo-lock.js";

describe("repo-lock", () => {
  it("serializes concurrent operations in the same cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "autoremediator-lock-test-"));
    const order: string[] = [];

    const first = withRepoLock(cwd, async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push("first-end");
      return "first";
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = withRepoLock(cwd, async () => {
      order.push("second-start");
      order.push("second-end");
      return "second";
    });

    const results = await Promise.all([first, second]);
    expect(results).toEqual(["first", "second"]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("times out when lock is not released within timeout", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "autoremediator-lock-timeout-test-"));

    const held = await acquireRepoLock(cwd);
    await expect(
      acquireRepoLock(cwd, { timeoutMs: 50, retryDelayMs: 10 })
    ).rejects.toThrow(/Timed out waiting for repository lock/);

    await held.release();
  });
});
