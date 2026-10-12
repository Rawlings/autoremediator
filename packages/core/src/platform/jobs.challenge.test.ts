import { describe, expect, it } from "vitest";
import { BoundedJobRegistry, type AsyncRemediationJob } from "./jobs.js";

describe("Milestone 4 Challenge: BoundedJobRegistry Stress Tests", () => {
  it("enforces strict capacity bound across high-volume sequential and concurrent sets", () => {
    const registry = new BoundedJobRegistry({ maxCapacity: 25 });
    expect(registry.getMaxCapacity()).toBe(25);

    // Insert 500 jobs rapidly
    for (let i = 0; i < 500; i++) {
      registry.set(`job-${i}`, {
        jobId: `job-${i}`,
        status: i % 2 === 0 ? "done" : "running",
        submittedAt: new Date(Date.now() - (500 - i) * 1000).toISOString(),
        completedAt: i % 2 === 0 ? new Date(Date.now() - (500 - i) * 500).toISOString() : undefined,
      });
      expect(registry.size).toBeLessThanOrEqual(25);
    }

    expect(registry.size).toBe(25);
    const stats = registry.stats();
    expect(stats.size).toBe(25);
    expect(stats.maxCapacity).toBe(25);
  });

  it("prioritizes terminal jobs (done / failed) over active jobs (pending / running) during eviction", () => {
    const registry = new BoundedJobRegistry({ maxCapacity: 3 });

    // Insert 2 active jobs and 1 terminal job
    registry.set("active-1", {
      jobId: "active-1",
      status: "running",
      submittedAt: "2026-10-11T10:00:00.000Z",
    });
    registry.set("active-2", {
      jobId: "active-2",
      status: "pending",
      submittedAt: "2026-10-11T10:01:00.000Z",
    });
    registry.set("terminal-1", {
      jobId: "terminal-1",
      status: "done",
      submittedAt: "2026-10-11T10:02:00.000Z",
      completedAt: "2026-10-11T10:03:00.000Z",
    });

    expect(registry.size).toBe(3);

    // Now insert a 4th job ("active-3")
    // Because "terminal-1" is terminal, it must be evicted first, even though active-1 is older!
    registry.set("active-3", {
      jobId: "active-3",
      status: "running",
      submittedAt: "2026-10-11T10:04:00.000Z",
    });

    expect(registry.size).toBe(3);
    expect(registry.has("terminal-1")).toBe(false); // terminal evicted
    expect(registry.has("active-1")).toBe(true); // older active job preserved
    expect(registry.has("active-2")).toBe(true);
    expect(registry.has("active-3")).toBe(true);
  });

  it("evicts oldest active job when all jobs at capacity are active", () => {
    const registry = new BoundedJobRegistry({ maxCapacity: 2 });

    registry.set("running-old", {
      jobId: "running-old",
      status: "running",
      submittedAt: "2026-10-11T10:00:00.000Z",
    });
    registry.set("running-new", {
      jobId: "running-new",
      status: "running",
      submittedAt: "2026-10-11T10:05:00.000Z",
    });

    expect(registry.size).toBe(2);

    // Insert 3rd running job
    registry.set("running-latest", {
      jobId: "running-latest",
      status: "running",
      submittedAt: "2026-10-11T10:10:00.000Z",
    });

    expect(registry.size).toBe(2);
    expect(registry.has("running-old")).toBe(false); // oldest overall evicted
    expect(registry.has("running-new")).toBe(true);
    expect(registry.has("running-latest")).toBe(true);
  });

  it("stress-tests TTL expiration: lazy eviction on get/has/set and active eviction via evictExpired/prune", () => {
    const ONE_HOUR = 60 * 60 * 1000;
    const registry = new BoundedJobRegistry({ maxCapacity: 10, ttlMs: ONE_HOUR });

    const baseTime = Date.now();
    const oldTime = new Date(baseTime - 2 * ONE_HOUR).toISOString(); // 2 hours ago (expired)
    const freshTime = new Date(baseTime - 10 * 1000).toISOString(); // 10s ago (fresh)

    registry.set("expired-done", {
      jobId: "expired-done",
      status: "done",
      submittedAt: oldTime,
      completedAt: oldTime,
    });
    registry.set("fresh-running", {
      jobId: "fresh-running",
      status: "running",
      submittedAt: freshTime,
    });

    // Lazy eviction on get()
    expect(registry.get("expired-done")).toBeUndefined();
    expect(registry.has("expired-done")).toBe(false);
    expect(registry.size).toBe(1);

    // Fresh job remains accessible
    expect(registry.get("fresh-running")?.jobId).toBe("fresh-running");

    // Add another expired job directly
    registry.set("expired-2", {
      jobId: "expired-2",
      status: "failed",
      submittedAt: oldTime,
      completedAt: oldTime,
    });

    // Active prune
    const prunedCount = registry.prune();
    expect(prunedCount).toBe(1);
    expect(registry.has("expired-2")).toBe(false);
    expect(registry.size).toBe(1);
  });

  it("stress-tests dynamic reconfiguration: setMaxCapacity enforces new bound immediately and rejects invalid inputs", () => {
    const registry = new BoundedJobRegistry({ maxCapacity: 10 });
    for (let i = 0; i < 10; i++) {
      registry.set(`j-${i}`, {
        jobId: `j-${i}`,
        status: i < 5 ? "done" : "running",
        submittedAt: new Date(Date.now() - (10 - i) * 1000).toISOString(),
        completedAt: i < 5 ? new Date(Date.now() - (10 - i) * 500).toISOString() : undefined,
      });
    }
    expect(registry.size).toBe(10);

    // Dynamically lower capacity to 3
    registry.setMaxCapacity(3);
    expect(registry.size).toBe(3);
    expect(registry.getMaxCapacity()).toBe(3);

    // Validation
    expect(() => registry.setMaxCapacity(0)).toThrow("maxCapacity must be greater than 0");
    expect(() => registry.setMaxCapacity(-5)).toThrow("maxCapacity must be greater than 0");
    expect(() => registry.setTtl(0)).toThrow("ttlMs must be greater than 0");
    expect(() => registry.setTtl(-100)).toThrow("ttlMs must be greater than 0");
  });

  it("updating an existing key updates in place without triggering eviction", () => {
    const registry = new BoundedJobRegistry({ maxCapacity: 2 });
    registry.set("job-1", {
      jobId: "job-1",
      status: "running",
      submittedAt: "2026-10-11T10:00:00.000Z",
    });
    registry.set("job-2", {
      jobId: "job-2",
      status: "running",
      submittedAt: "2026-10-11T10:01:00.000Z",
    });
    expect(registry.size).toBe(2);

    // Update job-1 status to done
    const updated: AsyncRemediationJob = {
      jobId: "job-1",
      status: "done",
      submittedAt: "2026-10-11T10:00:00.000Z",
      completedAt: "2026-10-11T10:05:00.000Z",
    };
    registry.set("job-1", updated);

    expect(registry.size).toBe(2);
    expect(registry.get("job-1")?.status).toBe("done");
    expect(registry.has("job-2")).toBe(true);
  });
});
