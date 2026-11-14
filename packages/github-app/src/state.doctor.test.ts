import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileAppStateStore, createInMemoryAppStateStore } from "./state.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "autoremediator-ghapp-state-"));
  tempDirs.push(dir);
  return dir;
}

describe("doctor attempts and remediation modes", () => {
  it("grants attempts up to the cap, one per head commit", () => {
    const store = createInMemoryAppStateStore();
    expect(store.reserveDoctorAttempt("o/r#1", "a", 2)).toEqual({ outcome: "granted", attempt: 1 });
    expect(store.reserveDoctorAttempt("o/r#1", "a", 2)).toEqual({ outcome: "duplicate" });
    expect(store.reserveDoctorAttempt("o/r#1", "b", 2)).toEqual({ outcome: "granted", attempt: 2 });
    expect(store.reserveDoctorAttempt("o/r#1", "c", 2)).toEqual({
      outcome: "limit",
      announce: true,
    });
    expect(store.reserveDoctorAttempt("o/r#1", "d", 2)).toEqual({
      outcome: "limit",
      announce: false,
    });
  });

  it("counts each pull request on its own", () => {
    const store = createInMemoryAppStateStore();
    store.reserveDoctorAttempt("o/r#1", "a", 1);
    expect(store.reserveDoctorAttempt("o/r#2", "a", 1)).toEqual({ outcome: "granted", attempt: 1 });
  });

  it("persists counters and modes across a reload", async () => {
    const dir = await tempDir();

    const writer = createFileAppStateStore(dir);
    writer.reserveDoctorAttempt("o/r#1", "a", 2);
    writer.recordRemediationMode("o/r:cve-2021-23337", "fix");

    const reader = createFileAppStateStore(dir);
    expect(reader.getRemediationMode("o/r:cve-2021-23337")).toBe("fix");
    expect(reader.reserveDoctorAttempt("o/r#1", "a", 2)).toEqual({ outcome: "duplicate" });
    expect(reader.reserveDoctorAttempt("o/r#1", "b", 2)).toEqual({
      outcome: "granted",
      attempt: 2,
    });
  });

  it("ignores malformed doctor and mode records in a state file", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "github-app-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        deliveries: [],
        installations: {},
        doctor: {
          "o/r#1": { attempts: "many" },
          "o/r#2": null,
          "o/r#3": { attempts: 1, lastSha: "x", announced: false },
        },
        modes: { a: "rm -rf", b: "plan" },
      }),
    );
    const store = createFileAppStateStore(dir);
    expect(store.reserveDoctorAttempt("o/r#1", "a", 2)).toEqual({ outcome: "granted", attempt: 1 });
    expect(store.reserveDoctorAttempt("o/r#3", "x", 2)).toEqual({ outcome: "duplicate" });
    expect(store.getRemediationMode("a")).toBeUndefined();
    expect(store.getRemediationMode("b")).toBe("plan");
  });

  it("loads state files written before these fields existed", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "github-app-state.json"),
      JSON.stringify({ schemaVersion: 1, deliveries: ["d1"], installations: { "5": "active" } }),
    );
    const store = createFileAppStateStore(dir);
    expect(store.hasProcessedDelivery("d1")).toBe(true);
    expect(store.reserveDoctorAttempt("o/r#1", "a", 1)).toEqual({ outcome: "granted", attempt: 1 });
  });

  it("keeps the number of tracked pull requests and advisories bounded", () => {
    const store = createInMemoryAppStateStore();
    for (let i = 0; i < 2100; i += 1) {
      store.reserveDoctorAttempt(`o/r#${i}`, "a", 1);
      store.recordRemediationMode(`o/r:cve-${i}`, "plan");
    }
    // The newest entries are remembered; the oldest has been forgotten and so starts over.
    expect(store.reserveDoctorAttempt("o/r#2099", "a", 1)).toEqual({ outcome: "duplicate" });
    expect(store.getRemediationMode("o/r:cve-2099")).toBe("plan");
    expect(store.getRemediationMode("o/r:cve-0")).toBeUndefined();
    expect(store.reserveDoctorAttempt("o/r#0", "a", 1)).toEqual({ outcome: "granted", attempt: 1 });
  });
});
