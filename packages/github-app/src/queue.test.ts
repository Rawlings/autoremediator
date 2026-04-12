import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileBackedJobQueue, createInMemoryJobQueue } from "./queue.js";

describe("job queue", () => {
  it("deduplicates queued jobs by dedupe key", () => {
    const queue = createInMemoryJobQueue();

    const first = queue.enqueue({
      eventName: "check_suite",
      payload: {},
      dedupeKey: "delivery-1",
      maxAttempts: 3,
    });

    const second = queue.enqueue({
      eventName: "check_suite",
      payload: {},
      dedupeKey: "delivery-1",
      maxAttempts: 3,
    });

    expect(second.id).toBe(first.id);
    expect(queue.listJobs()).toHaveLength(1);
  });

  it("claims due jobs and retries until max attempts", () => {
    const queue = createInMemoryJobQueue();

    const job = queue.enqueue({
      eventName: "workflow_dispatch",
      payload: {},
      maxAttempts: 2,
    });

    const claimed = queue.claimDueJobs(1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(job.id);
    expect(claimed[0]?.status).toBe("running");
    expect(claimed[0]?.attempts).toBe(1);

    const retried = queue.failJob(job.id, "temporary", 0);
    expect(retried?.status).toBe("queued");

    const secondClaim = queue.claimDueJobs(1);
    expect(secondClaim).toHaveLength(1);
    const failed = queue.failJob(job.id, "permanent", 1);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(2);
  });

  it("persists jobs to disk and reloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "autoremediator-queue-"));

    try {
      const filePath = join(dir, "queue.json");
      const queue = createFileBackedJobQueue(filePath);

      const job = queue.enqueue({
        eventName: "check_suite",
        payload: { test: true },
        maxAttempts: 3,
      });

      expect(queue.listJobs()).toHaveLength(1);

      const reloaded = createFileBackedJobQueue(filePath);
      const jobs = reloaded.listJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe(job.id);
      expect(jobs[0]?.eventName).toBe("check_suite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
