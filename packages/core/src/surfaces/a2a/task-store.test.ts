import { describe, expect, it } from "vitest";

import { TaskStore, truncateMessage } from "./task-store.js";

const task = (id: string, size = 10) => ({ id, payload: "p".repeat(size) });

describe("TaskStore", () => {
  it("returns a task to its owner only", () => {
    const store = new TaskStore<{ id: string }>({ maxTasks: 10, maxBytes: 10_000, ttlMs: 1000 });
    store.remember(task("a"), "reader", "alice", 0);
    expect(store.get("a", 1)?.owner).toBe("alice");
    expect(store.get("missing", 1)).toBeUndefined();
  });

  it("forgets tasks after the time limit", () => {
    const store = new TaskStore<{ id: string }>({ maxTasks: 10, maxBytes: 10_000, ttlMs: 1000 });
    store.remember(task("a"), "reader", "alice", 0);
    expect(store.get("a", 1001)).toBeUndefined();
  });

  it("holds at most the given number of tasks, dropping the oldest", () => {
    const store = new TaskStore<{ id: string }>({ maxTasks: 2, maxBytes: 10_000, ttlMs: 1000 });
    for (const id of ["a", "b", "c"]) store.remember(task(id), "reader", "alice", 0);
    expect(store.size).toBe(2);
    expect(store.get("a", 1)).toBeUndefined();
    expect(store.get("c", 1)).toBeDefined();
  });

  it("holds at most the given number of bytes, dropping the oldest", () => {
    const store = new TaskStore<{ id: string }>({ maxTasks: 100, maxBytes: 1000, ttlMs: 1000 });
    for (const id of ["a", "b", "c", "d"]) store.remember(task(id, 400), "reader", "alice", 0);
    expect(store.bytes).toBeLessThanOrEqual(1000);
    expect(store.get("a", 1)).toBeUndefined();
    expect(store.get("d", 1)).toBeDefined();
  });

  it("refuses a single task bigger than the whole budget", () => {
    const store = new TaskStore<{ id: string }>({ maxTasks: 100, maxBytes: 1000, ttlMs: 1000 });
    expect(store.remember(task("big", 5000), "reader", "alice", 0)).toBe(false);
    expect(store.size).toBe(0);
  });
});

describe("truncateMessage", () => {
  const message = (parts: unknown[]) =>
    ({ messageId: "m", role: "ROLE_USER", parts }) as {
      messageId: string;
      role: string;
      parts: Array<{ text?: string; data?: unknown; mediaType?: string }>;
    };

  it("keeps a short message as it is", () => {
    const short = message([
      { text: "hello" },
      { data: { operation: "guardPackage", input: { spec: "x" } } },
    ]);
    expect(truncateMessage(short)).toEqual(short);
  });

  it("cuts long text and replaces data that does not fit, within the budget", () => {
    const long = message([
      { data: { operation: "guardPackage", input: {} }, mediaType: "application/json" },
      { text: "y".repeat(100_000) },
      { data: { big: "z".repeat(100_000) } },
      { raw: "AAAA", mediaType: "image/png" },
    ]);
    const kept = truncateMessage(long, 2048);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(2048 + 512);
    expect(JSON.stringify(kept)).not.toContain("zzzz");
    expect(JSON.stringify(kept)).not.toContain("AAAA");
    expect(kept.parts[0]).toMatchObject({ data: { operation: "guardPackage" } });
  });
});
