import { describe, expect, it, beforeEach } from "vitest";
import { BoundedJobRegistry, jobRegistry, type AsyncRemediationJob } from "./jobs.js";

describe("BoundedJobRegistry", () => {
  let registry: BoundedJobRegistry;

  beforeEach(() => {
    registry = new BoundedJobRegistry({ maxCapacity: 3, ttlMs: 24 * 60 * 60 * 1000 });
  });

  it("satisfies Map interface semantics", () => {
    expect(registry instanceof Map).toBe(true);
    const job: AsyncRemediationJob = {
      jobId: "job-1",
      status: "pending",
      submittedAt: new Date().toISOString(),
    };
    registry.set("job-1", job);
    expect(registry.has("job-1")).toBe(true);
    expect(registry.get("job-1")).toEqual(job);
    expect(registry.size).toBe(1);

    registry.delete("job-1");
    expect(registry.has("job-1")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("updates existing job in-place without triggering eviction", () => {
    const job: AsyncRemediationJob = {
      jobId: "job-1",
      status: "pending",
      submittedAt: new Date().toISOString(),
    };
    registry.set("job-1", job);
    registry.set("job-1", { ...job, status: "running" });

    expect(registry.size).toBe(1);
    expect(registry.get("job-1")?.status).toBe("running");
  });

  it("evicts oldest terminal job when maxCapacity is exceeded", () => {
    const now = Date.now();
    const t0 = new Date(now - 4000).toISOString();
    const t1 = new Date(now - 3000).toISOString();
    const t2 = new Date(now - 2000).toISOString();
    const t3 = new Date(now - 1000).toISOString();

    // Capacity is 3
    registry.set("job-1", { jobId: "job-1", status: "done", submittedAt: t0, completedAt: t0 });
    registry.set("job-2", { jobId: "job-2", status: "running", submittedAt: t1 });
    registry.set("job-3", { jobId: "job-3", status: "pending", submittedAt: t2 });

    expect(registry.size).toBe(3);

    // Adding 4th job should evict terminal job-1 first, preserving running/pending jobs
    registry.set("job-4", { jobId: "job-4", status: "pending", submittedAt: t3 });

    expect(registry.size).toBe(3);
    expect(registry.has("job-1")).toBe(false); // evicted
    expect(registry.has("job-2")).toBe(true); // retained running job
    expect(registry.has("job-3")).toBe(true);
    expect(registry.has("job-4")).toBe(true);
  });

  it("falls back to evicting oldest job when no terminal jobs exist", () => {
    const now = Date.now();
    const t0 = new Date(now - 4000).toISOString();
    const t1 = new Date(now - 3000).toISOString();
    const t2 = new Date(now - 2000).toISOString();
    const t3 = new Date(now - 1000).toISOString();

    registry.set("job-1", { jobId: "job-1", status: "pending", submittedAt: t0 });
    registry.set("job-2", { jobId: "job-2", status: "running", submittedAt: t1 });
    registry.set("job-3", { jobId: "job-3", status: "pending", submittedAt: t2 });

    // Adding 4th job must evict oldest overall job-1
    registry.set("job-4", { jobId: "job-4", status: "running", submittedAt: t3 });

    expect(registry.size).toBe(3);
    expect(registry.has("job-1")).toBe(false);
    expect(registry.has("job-2")).toBe(true);
    expect(registry.has("job-3")).toBe(true);
    expect(registry.has("job-4")).toBe(true);
  });

  it("lazily evicts expired jobs upon get() and has()", () => {
    const shortTtlRegistry = new BoundedJobRegistry({ maxCapacity: 10, ttlMs: 50 });
    const oldTimestamp = new Date(Date.now() - 500).toISOString();

    shortTtlRegistry.set("stale-job", {
      jobId: "stale-job",
      status: "done",
      submittedAt: oldTimestamp,
      completedAt: oldTimestamp,
    });

    expect(shortTtlRegistry.has("stale-job")).toBe(false);
    expect(shortTtlRegistry.get("stale-job")).toBeUndefined();
    expect(shortTtlRegistry.size).toBe(0);
  });

  it("actively purges expired jobs via evictExpired() and prune()", () => {
    const registry = new BoundedJobRegistry({ maxCapacity: 10, ttlMs: 1000 });
    const now = Date.now();

    registry.set("stale-1", {
      jobId: "stale-1",
      status: "done",
      submittedAt: new Date(now - 500).toISOString(),
      completedAt: new Date(now - 500).toISOString(),
    });
    registry.set("fresh-1", {
      jobId: "fresh-1",
      status: "running",
      submittedAt: new Date(now).toISOString(),
    });

    // At now + 600ms, stale-1 is 1100ms old (> ttlMs 1000ms), fresh-1 is 600ms old (<= ttlMs)
    const evictedCount = registry.prune(now + 600);
    expect(evictedCount).toBe(1);
    expect(registry.size).toBe(1);
    expect(registry.has("fresh-1")).toBe(true);
    expect(registry.has("stale-1")).toBe(false);
  });

  it("dynamically updates maxCapacity and trims excess entries", () => {
    registry.set("j1", { jobId: "j1", status: "done", submittedAt: new Date().toISOString() });
    registry.set("j2", { jobId: "j2", status: "done", submittedAt: new Date().toISOString() });
    registry.set("j3", { jobId: "j3", status: "done", submittedAt: new Date().toISOString() });
    expect(registry.size).toBe(3);

    registry.setMaxCapacity(2);
    expect(registry.getMaxCapacity()).toBe(2);
    expect(registry.size).toBe(2);
  });

  it("provides comprehensive stats distribution", () => {
    const now = new Date().toISOString();
    registry.set("p1", { jobId: "p1", status: "pending", submittedAt: now });
    registry.set("r1", { jobId: "r1", status: "running", submittedAt: now });
    registry.set("d1", { jobId: "d1", status: "done", submittedAt: now });

    const stats = registry.stats();
    expect(stats).toEqual({
      size: 3,
      maxCapacity: 3,
      ttlMs: 24 * 60 * 60 * 1000,
      pending: 1,
      running: 1,
      done: 1,
      failed: 0,
    });
  });

  it("default jobRegistry singleton is an instance of BoundedJobRegistry", () => {
    expect(jobRegistry instanceof BoundedJobRegistry).toBe(true);
    expect(jobRegistry.getMaxCapacity()).toBe(1000);
    expect(jobRegistry.getTtl()).toBe(24 * 60 * 60 * 1000);
  });
});
