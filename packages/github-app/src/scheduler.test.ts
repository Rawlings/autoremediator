import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryJobQueue } from "./queue.js";
import { startWorkflowDispatchScheduler } from "./scheduler.js";

describe("startWorkflowDispatchScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues scheduled workflow dispatch jobs with bucket dedupe", async () => {
    vi.useFakeTimers();

    const queue = createInMemoryJobQueue();
    const scheduler = startWorkflowDispatchScheduler({
      queue,
      intervalMs: 1000,
      queueMaxAttempts: 3,
    });

    expect(queue.listJobs()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);

    const jobs = queue.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.every((job) => job.eventName === "workflow_dispatch")).toBe(true);

    scheduler.stop();
  });
});
