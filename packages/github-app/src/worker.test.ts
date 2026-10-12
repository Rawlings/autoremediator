import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryJobQueue } from "./queue.js";
import { startJobWorker } from "./worker.js";

describe("startJobWorker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes queued jobs and marks completion", async () => {
    vi.useFakeTimers();
    const queue = createInMemoryJobQueue();
    queue.enqueue({
      eventName: "check_suite",
      payload: {},
      maxAttempts: 3,
    });

    const processJob = vi.fn(async () => undefined);
    const worker = startJobWorker({
      queue,
      pollIntervalMs: 25,
      concurrency: 1,
      retryDelayMs: 100,
      processJob,
    });

    await vi.advanceTimersByTimeAsync(40);

    expect(processJob).toHaveBeenCalledTimes(1);
    expect(queue.listJobs()[0]?.status).toBe("completed");

    worker.stop();
  });

  it("retries failed jobs", async () => {
    vi.useFakeTimers();
    const queue = createInMemoryJobQueue();
    queue.enqueue({
      eventName: "workflow_dispatch",
      payload: {},
      maxAttempts: 2,
    });

    const processJob = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);

    const worker = startJobWorker({
      queue,
      pollIntervalMs: 25,
      concurrency: 1,
      retryDelayMs: 50,
      processJob,
    });

    await vi.advanceTimersByTimeAsync(35);
    expect(processJob).toHaveBeenCalledTimes(1);
    expect(queue.listJobs()[0]?.status).toBe("queued");

    await vi.advanceTimersByTimeAsync(70);
    expect(processJob).toHaveBeenCalledTimes(2);
    expect(queue.listJobs()[0]?.status).toBe("completed");

    worker.stop();
  });

  it("transitions job to failed status and calls onJobFailed when maxAttempts is exhausted", async () => {
    vi.useFakeTimers();
    const queue = createInMemoryJobQueue();
    queue.enqueue({
      eventName: "push",
      payload: {},
      maxAttempts: 1,
    });

    const onJobFailed = vi.fn();
    const processJob = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("fatal error"));

    const worker = startJobWorker({
      queue,
      pollIntervalMs: 25,
      concurrency: 1,
      retryDelayMs: 50,
      processJob,
      onJobFailed,
    });

    await vi.advanceTimersByTimeAsync(35);
    expect(processJob).toHaveBeenCalledTimes(1);
    expect(onJobFailed).toHaveBeenCalledTimes(1);
    const failedJob = queue.listJobs()[0];
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.lastError).toBe("fatal error");
    expect(onJobFailed).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));

    worker.stop();
  });
});
